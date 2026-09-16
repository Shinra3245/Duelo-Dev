import {
  isJudgeResultNotification,
  type JudgeResultNotification,
  type Logger,
  type SubmissionVerdictContext,
} from '@duelodev/shared';
import type { MatchHub } from '../socket/hub.js';
import type { MatchStore } from '../store/types.js';
import type { ProcessedSubmissionStore, ResultSubscriber, SubmissionProvider } from './types.js';

export interface JudgeResultsConsumerOptions {
  subscriber: ResultSubscriber;
  matchHub: MatchHub;
  matchStore: MatchStore;
  processedStore: ProcessedSubmissionStore;
  submissionProvider?: SubmissionProvider | undefined;
  logger?: Logger | undefined;
}

/**
 * Consumidor de avisos de resultados del juez (doc 04 §131-135).
 *
 * Recibe avisos desde el canal de resultados `judge:results`, valida el formato
 * según el esquema de notificaciones, garantiza idempotencia durable evitando
 * aplicar doble puntuación o dobles transiciones, y delega a MatchHub.
 */
export class JudgeResultsConsumer {
  private readonly options: JudgeResultsConsumerOptions;
  private unsubscribe?: (() => void) | undefined;
  private running = false;
  private processedCount = 0;

  constructor(options: JudgeResultsConsumerOptions) {
    this.options = options;
  }

  /**
   * Inicia la suscripción al canal de resultados.
   */
  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.unsubscribe = this.options.subscriber.subscribe(async (notif) => {
      try {
        await this.handleNotification(notif);
      } catch (err) {
        this.options.logger?.error('Error no controlado al procesar aviso de veredicto', {
          error: err instanceof Error ? err.message : String(err),
          submission_id: notif?.submission_id,
          match_id: notif?.match_id,
        });
      }
    });

    this.options.logger?.info('JudgeResultsConsumer iniciado y suscrito a judge:results');
  }

  /**
   * Detiene la suscripción al canal de resultados.
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }

    this.options.logger?.info('JudgeResultsConsumer detenido');
  }

  /**
   * Indica si el consumidor se encuentra activo y suscrito.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Retorna la cantidad de notificaciones procesadas con éxito por esta instancia.
   */
  getProcessedCount(): number {
    return this.processedCount;
  }

  /**
   * Procesa una notificación individual de resultado de juez con validaciones e idempotencia.
   * Retorna true si fue procesada y aplicada a la partida; false si fue descartada.
   */
  async handleNotification(notif: JudgeResultNotification): Promise<boolean> {
    // 1. Valida el esquema con la guardia estricta (doc 04 §135)
    if (!isJudgeResultNotification(notif)) {
      this.options.logger?.warn('Aviso de resultado de juez inválido o mal formado ignorado', {
        notification: notif,
      });
      return false;
    }

    // 2. Idempotencia durable (doc 04 §132)
    const alreadyProcessed = await this.options.processedStore.hasBeenProcessed(
      notif.match_id,
      notif.submission_id,
    );
    if (alreadyProcessed) {
      this.options.logger?.info(
        'Aviso de resultado ya procesado previamente; ignorando duplicado',
        {
          match_id: notif.match_id,
          submission_id: notif.submission_id,
        },
      );
      return false;
    }

    // 3. Recupera la sesión de la partida
    const session = await this.options.matchStore.getMatch(notif.match_id);
    if (!session || (session.status !== 'running' && session.status !== 'settling')) {
      this.options.logger?.warn(
        'Sesión de partida no encontrada o no activa al recibir veredicto',
        {
          match_id: notif.match_id,
          status: session?.status,
        },
      );
      return false;
    }

    // 4. Obtiene compile_output si el proveedor está configurado
    let compileOutput: string | undefined;
    if (this.options.submissionProvider?.getCompileOutput) {
      try {
        compileOutput = await this.options.submissionProvider.getCompileOutput(notif.submission_id);
      } catch (err) {
        this.options.logger?.warn('Fallo al obtener compile_output de submissionProvider', {
          submission_id: notif.submission_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 5. Construye el contexto del veredicto para el orquestador
    const roundIdx =
      (session as { player_rounds?: Record<string, { current_round_idx: number }> })
        .player_rounds?.[notif.user_id]?.current_round_idx ?? session.current_round_idx;

    const problemId =
      session.problem_ids?.[roundIdx] ?? session.problem_ids?.[session.current_round_idx] ?? '';

    const submissionCtx: SubmissionVerdictContext = {
      submission_id: notif.submission_id,
      user_id: notif.user_id,
      round_id: notif.round_id,
      problem_id: problemId,
      admission_seq: 1,
      received_at: Date.now(),
      verdict: notif.verdict,
      passed_cases: notif.passed,
      total_cases: notif.total,
      exec_time_ms: notif.exec_time_ms,
    };

    // 6. Despacha a MatchHub (actualización de score, transición de ronda/fin de partida, etc.)
    await this.options.matchHub.processSubmissionVerdict(
      notif.match_id,
      submissionCtx,
      compileOutput,
    );

    // 7. Registra como procesado en el almacén de idempotencia
    await this.options.processedStore.markProcessed(notif.match_id, notif.submission_id);
    this.processedCount++;

    return true;
  }
}
