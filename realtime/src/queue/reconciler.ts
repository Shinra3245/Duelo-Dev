import type { Logger, SubmissionVerdictContext } from '@duelodev/shared';
import type { MatchHub } from '../socket/hub.js';
import type { MatchStore } from '../store/types.js';
import type { ProcessedSubmissionStore, SubmissionProvider } from './types.js';

export interface MatchStateReconcilerOptions {
  matchStore: MatchStore;
  matchHub: MatchHub;
  submissionProvider: SubmissionProvider;
  processedStore: ProcessedSubmissionStore;
  intervalMs?: number | undefined;
  logger?: Logger | undefined;
}

/**
 * Reconciliador de estado de partida (doc 04 §131).
 *
 * "Resultado guardado, aviso perdido: Realtime reconcilia envíos finales aún no
 * aplicados en PostgreSQL al arrancar y periódicamente".
 *
 * Consulta los envíos juzgados persistidos, los ordena por `admission_seq` ascendente
 * para garantizar aplicación determinista y secuencial, y procesa aquellos que aún
 * no han sido registrados en el almacén de idempotencia.
 */
export class MatchStateReconciler {
  private readonly options: MatchStateReconcilerOptions;
  private timer?: NodeJS.Timeout | undefined;
  private running = false;
  private totalReconciled = 0;

  constructor(options: MatchStateReconcilerOptions) {
    this.options = options;
  }

  /**
   * Inicia el ciclo periódico de reconciliación y ejecuta una pasada inmediata.
   */
  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    const intervalMs = this.options.intervalMs ?? 5000;

    // Pasada inmediata al arrancar
    void this.reconcileAll().catch((err) => {
      this.options.logger?.error('Error en reconciliación inicial de partidas', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Ciclo periódico con temporizador desreferenciado
    this.timer = setInterval(() => {
      void this.reconcileAll().catch((err) => {
        this.options.logger?.error('Error en ciclo periódico de reconciliación de partidas', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, intervalMs);

    this.timer.unref();

    this.options.logger?.info('MatchStateReconciler iniciado', {
      interval_ms: intervalMs,
    });
  }

  /**
   * Detiene el ciclo periódico de reconciliación.
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    this.options.logger?.info('MatchStateReconciler detenido');
  }

  /**
   * Indica si el reconciliador se encuentra en ejecución activa.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Retorna el número acumulado de envíos reconciliados por esta instancia.
   */
  getReconciledCount(): number {
    return this.totalReconciled;
  }

  /**
   * Reconcilia los envíos pendientes de una partida específica.
   * Retorna el número de envíos reconciliados y aplicados.
   */
  async reconcileMatch(matchId: string): Promise<number> {
    const session = await this.options.matchStore.getMatch(matchId);
    if (!session || (session.status !== 'running' && session.status !== 'settling')) {
      return 0;
    }

    const records = await this.options.submissionProvider.findJudgedSubmissionsByMatch(matchId);
    if (!records || records.length === 0) {
      return 0;
    }

    // Orden ascendente por admission_seq para aplicación determinista (doc 04 §131)
    const sorted = [...records].sort((a, b) => a.admission_seq - b.admission_seq);

    let reconciledCount = 0;

    for (const record of sorted) {
      let claimed = false;
      if (this.options.processedStore.claimProcessing) {
        claimed = await this.options.processedStore.claimProcessing(matchId, record.id);
        if (!claimed) {
          continue;
        }
      } else {
        const alreadyProcessed = await this.options.processedStore.hasBeenProcessed(
          matchId,
          record.id,
        );
        if (alreadyProcessed) {
          continue;
        }
      }

      // Re-verificar que la partida continúe activa tras envíos precedentes
      const currentSession = await this.options.matchStore.getMatch(matchId);
      if (
        !currentSession ||
        (currentSession.status !== 'running' && currentSession.status !== 'settling')
      ) {
        if (claimed && this.options.processedStore.releaseProcessing) {
          await this.options.processedStore.releaseProcessing(matchId, record.id);
        }
        this.options.logger?.info(
          'Partida finalizada durante reconciliación; interrumpiendo envíos restantes',
          { match_id: matchId, status: currentSession?.status },
        );
        break;
      }

      const roundIdx =
        (currentSession as { player_rounds?: Record<string, { current_round_idx: number }> })
          .player_rounds?.[record.user_id]?.current_round_idx ?? currentSession.current_round_idx;

      const fallbackProblemId =
        currentSession.problem_ids?.[roundIdx] ??
        currentSession.problem_ids?.[currentSession.current_round_idx] ??
        '';

      const problemId = record.problem_id ? record.problem_id : fallbackProblemId;

      const receivedAtMs = Number.isFinite(Date.parse(record.received_at))
        ? Date.parse(record.received_at)
        : Date.now();

      const submissionCtx: SubmissionVerdictContext = {
        submission_id: record.id,
        user_id: record.user_id,
        round_id: record.round_id,
        problem_id: problemId,
        admission_seq: record.admission_seq,
        received_at: receivedAtMs,
        verdict: record.verdict,
        passed_cases: record.passed_cases,
        total_cases: record.total_cases,
        exec_time_ms: record.exec_time_ms,
      };

      let compileOutput = record.compile_output;
      if (compileOutput === undefined && this.options.submissionProvider.getCompileOutput) {
        try {
          compileOutput = await this.options.submissionProvider.getCompileOutput(record.id);
        } catch {
          // Ignorar fallo al leer compile_output opcional
        }
      }

      try {
        await this.options.matchHub.processSubmissionVerdict(matchId, submissionCtx, compileOutput);

        await this.options.processedStore.markProcessed(matchId, record.id);
        reconciledCount++;
        this.totalReconciled++;

        this.options.logger?.info('Envío reconciliado exitosamente', {
          match_id: matchId,
          submission_id: record.id,
          admission_seq: record.admission_seq,
          verdict: record.verdict,
        });
      } catch (err) {
        if (claimed && this.options.processedStore.releaseProcessing) {
          await this.options.processedStore.releaseProcessing(matchId, record.id);
        }
        throw err;
      }
    }

    return reconciledCount;
  }

  /**
   * Reconcilia todas las partidas activas detectadas en el MatchStore o en el MatchHub.
   */
  async reconcileAll(): Promise<number> {
    const storeMatchIds = this.options.matchStore.listActiveMatchIds
      ? await this.options.matchStore.listActiveMatchIds()
      : [];

    const hubMatchIds = this.options.matchHub.getActiveMatchIds();

    const uniqueMatchIds = Array.from(new Set([...storeMatchIds, ...hubMatchIds]));

    let total = 0;
    for (const matchId of uniqueMatchIds) {
      try {
        const count = await this.reconcileMatch(matchId);
        total += count;
      } catch (err) {
        this.options.logger?.error('Error al reconciliar partida específica', {
          match_id: matchId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return total;
  }
}
