import {
  isJudgeResultNotification,
  type JudgeResultNotification,
  type Logger,
  type SubmissionVerdictContext,
} from '@duelodev/shared';
import type { MatchHub } from '../socket/hub.js';
import type { MatchStore } from '../store/types.js';
import type {
  JudgedSubmissionRecord,
  ProcessedSubmissionStore,
  ResultSubscriber,
  SubmissionProvider,
} from './types.js';

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
 * aplicar doble puntuación o dobles transiciones, coteja con la persistencia
 * durable de PostgreSQL para obtener admission_seq y received_at fidedignos,
 * y delega a MatchHub.
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
        const errorMeta: Record<string, unknown> = {
          error: err instanceof Error ? err.message : String(err),
        };
        if (typeof notif === 'object' && notif !== null && 'submission_id' in notif) {
          errorMeta.submission_id = String((notif as { submission_id: unknown }).submission_id);
        }
        if (typeof notif === 'object' && notif !== null && 'match_id' in notif) {
          errorMeta.match_id = String((notif as { match_id: unknown }).match_id);
        }
        this.options.logger?.error('Error no controlado al procesar aviso de veredicto', errorMeta);
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
    // 1. Valida el esquema con la guardia estricta (doc 04 §135).
    // Nunca incluir objetos no validados en logs para prevenir fugas de tokens o código.
    if (!isJudgeResultNotification(notif)) {
      this.options.logger?.warn('Aviso de resultado de juez inválido o mal formado ignorado', {
        reason: 'malformed_judge_result_notification',
      });
      return false;
    }

    // 2. Reserva atómica de procesamiento / Idempotencia durable (doc 04 §132)
    let claimed = false;
    if (this.options.processedStore.claimProcessing) {
      claimed = await this.options.processedStore.claimProcessing(
        notif.match_id,
        notif.submission_id,
      );
      if (!claimed) {
        this.options.logger?.info(
          'Aviso de resultado ya en procesamiento o procesado previamente; ignorando duplicado',
          {
            match_id: notif.match_id,
            submission_id: notif.submission_id,
          },
        );
        return false;
      }
    } else {
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
      if (claimed && this.options.processedStore.releaseProcessing) {
        await this.options.processedStore.releaseProcessing(notif.match_id, notif.submission_id);
      }
      return false;
    }

    // 4. Consulta el registro durable en PostgreSQL si submissionProvider está disponible (doc 04 §131)
    let durableRecord: JudgedSubmissionRecord | null = null;
    if (this.options.submissionProvider?.findJudgedSubmissionById) {
      try {
        durableRecord = await this.options.submissionProvider.findJudgedSubmissionById(
          notif.submission_id,
        );
      } catch (err) {
        this.options.logger?.warn('Error al consultar registro durable de envío por ID', {
          match_id: notif.match_id,
          submission_id: notif.submission_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (this.options.submissionProvider?.findJudgedSubmissionsByMatch) {
      try {
        const list = await this.options.submissionProvider.findJudgedSubmissionsByMatch(
          notif.match_id,
        );
        durableRecord = list.find((r) => r.id === notif.submission_id) ?? null;
      } catch (err) {
        this.options.logger?.warn('Error al consultar envíos durables de la partida', {
          match_id: notif.match_id,
          submission_id: notif.submission_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Si hay submissionProvider, la fila en PostgreSQL es la única fuente de verdad
    if (this.options.submissionProvider && !durableRecord) {
      this.options.logger?.warn(
        'Envío no encontrado en almacenamiento durable; descartando aviso espurio',
        {
          match_id: notif.match_id,
          submission_id: notif.submission_id,
        },
      );
      if (claimed && this.options.processedStore.releaseProcessing) {
        await this.options.processedStore.releaseProcessing(notif.match_id, notif.submission_id);
      }
      return false;
    }

    // Validar coherencia entre el aviso y la fila durable para evitar avisos manipulados
    if (durableRecord) {
      const mismatch =
        durableRecord.match_id !== notif.match_id ||
        durableRecord.user_id !== notif.user_id ||
        durableRecord.round_id !== notif.round_id ||
        durableRecord.verdict !== notif.verdict;

      if (mismatch) {
        this.options.logger?.warn(
          'Discrepancia detectada entre aviso Pub/Sub y registro durable en PostgreSQL',
          {
            match_id: notif.match_id,
            submission_id: notif.submission_id,
          },
        );
        if (claimed && this.options.processedStore.releaseProcessing) {
          await this.options.processedStore.releaseProcessing(notif.match_id, notif.submission_id);
        }
        return false;
      }
    }

    // 5. Obtiene compile_output si el proveedor está configurado
    let compileOutput = durableRecord?.compile_output;
    if (compileOutput === undefined && this.options.submissionProvider?.getCompileOutput) {
      try {
        compileOutput = await this.options.submissionProvider.getCompileOutput(notif.submission_id);
      } catch (err) {
        this.options.logger?.warn('Fallo al obtener compile_output de submissionProvider', {
          submission_id: notif.submission_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 6. Construye el contexto del veredicto con valores durables fidedignos
    const admissionSeq = durableRecord ? durableRecord.admission_seq : 1;
    const receivedAtMs =
      durableRecord && Number.isFinite(Date.parse(durableRecord.received_at))
        ? Date.parse(durableRecord.received_at)
        : Date.now();
    const verdict = durableRecord ? durableRecord.verdict : notif.verdict;
    const passedCases = durableRecord ? durableRecord.passed_cases : notif.passed;
    const totalCases = durableRecord ? durableRecord.total_cases : notif.total;
    const execTimeMs = durableRecord ? durableRecord.exec_time_ms : notif.exec_time_ms;

    const roundIdx =
      (session as { player_rounds?: Record<string, { current_round_idx: number }> })
        .player_rounds?.[notif.user_id]?.current_round_idx ?? session.current_round_idx;

    const fallbackProblemId =
      session.problem_ids?.[roundIdx] ?? session.problem_ids?.[session.current_round_idx] ?? '';

    const problemId = durableRecord?.problem_id || fallbackProblemId;

    const submissionCtx: SubmissionVerdictContext = {
      submission_id: notif.submission_id,
      user_id: notif.user_id,
      round_id: notif.round_id,
      problem_id: problemId,
      admission_seq: admissionSeq,
      received_at: receivedAtMs,
      verdict,
      passed_cases: passedCases,
      total_cases: totalCases,
      exec_time_ms: execTimeMs,
    };

    // 7. Despacha a MatchHub y registra en processedStore
    try {
      await this.options.matchHub.processSubmissionVerdict(
        notif.match_id,
        submissionCtx,
        compileOutput,
      );

      await this.options.processedStore.markProcessed(notif.match_id, notif.submission_id);
      this.processedCount++;
      return true;
    } catch (err) {
      if (claimed && this.options.processedStore.releaseProcessing) {
        await this.options.processedStore.releaseProcessing(notif.match_id, notif.submission_id);
      }
      throw err;
    }
  }
}
