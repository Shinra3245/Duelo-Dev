import {
  createLogger,
  JUDGE_STREAM_SCHEMA_VERSION,
  type JudgeJobStreamMessage,
  type Logger,
} from '@duelodev/shared';
import type { ProblemRepository, SubmissionRepository } from '../repositories/types.js';
import type { JudgeQueue, ReconciliationStats, SubmissionReconcilerOptions } from './types.js';

/**
 * Reconciliador en segundo plano para recuperación de envíos encolados no despachados (doc 04 §5).
 * Resuelve la interrupción: "INSERT confirmado, XADD falla: Bucle en API busca envíos sin veredicto
 * y sin despacho vigente; reencola con el mismo id".
 */
export class SubmissionReconciler {
  private readonly submissionRepo: SubmissionRepository;
  private readonly queue: JudgeQueue;
  private readonly problemRepo: ProblemRepository | undefined;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly gracePeriodMs: number;

  private intervalTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isProcessing = false;

  constructor(options: SubmissionReconcilerOptions) {
    this.submissionRepo = options.submissionRepo;
    this.queue = options.queue;
    this.problemRepo = options.problemRepo;
    this.logger = options.logger ?? createLogger('submission-reconciler');
    this.intervalMs = options.intervalMs ?? 5000;
    this.batchSize = options.batchSize ?? 50;
    this.gracePeriodMs = options.gracePeriodMs ?? 2000;
  }

  /**
   * Ejecuta una pasada de reconciliación sobre los envíos pendientes durables.
   */
  async reconcileOnce(now = Date.now()): Promise<ReconciliationStats> {
    if (this.isProcessing) {
      return { scanned: 0, reenqueued: 0, failed: 0 };
    }

    this.isProcessing = true;
    const stats: ReconciliationStats = {
      scanned: 0,
      reenqueued: 0,
      failed: 0,
    };

    try {
      const pendingList = await this.submissionRepo.findPendingSubmissions(this.batchSize);

      for (const submission of pendingList) {
        if (submission.status !== 'queued') {
          continue;
        }

        stats.scanned++;

        const receivedAtMs = new Date(submission.received_at).getTime();
        const ageMs = now - receivedAtMs;

        // Si el envío es muy reciente, conceder período de gracia para el despacho HTTP inmediato
        if (ageMs < this.gracePeriodMs) {
          continue;
        }

        const casesRef = `cases/${submission.problem_id}`;
        let problemVersion = 1;
        if (this.problemRepo) {
          try {
            const prob = await this.problemRepo.findProblemById(submission.problem_id);
            if (prob) {
              problemVersion = prob.version ?? 1;
            }
          } catch {
            // Mantener fallback seguro a 1
          }
        }

        const jobMessage: JudgeJobStreamMessage = {
          schema_version: JUDGE_STREAM_SCHEMA_VERSION,
          submission_id: submission.id,
          problem_id: submission.problem_id,
          problem_version: problemVersion,
          language: submission.language,
          source_code: submission.source_code,
          time_limit_ms: submission.time_limit_ms,
          memory_limit_mb: submission.memory_limit_mb,
          cases_ref: casesRef,
          enqueued_at_ms: now,
        };

        try {
          await this.queue.enqueue(jobMessage);
          stats.reenqueued++;
          this.logger.info('Envío pendiente reencolado exitosamente en judge:stream', {
            submission_id: submission.id,
            match_id: submission.match_id,
            problem_id: submission.problem_id,
            age_ms: ageMs,
          });
        } catch (enqueueErr) {
          stats.failed++;
          this.logger.error('Fallo al reencolar envío en judge:stream durante reconciliación', {
            submission_id: submission.id,
            error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
          });
        }
      }
    } catch (err) {
      this.logger.error('Error general durante pasada de reconciliación', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.isProcessing = false;
    }

    return stats;
  }

  /**
   * Inicia el ciclo periódico de reconciliación en segundo plano.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.intervalTimer = setInterval(() => {
      void this.reconcileOnce();
    }, this.intervalMs);

    // Evita impedir el cierre del proceso si es el único timer activo
    this.intervalTimer.unref();

    this.logger.info('Servicio de reconciliación de envíos iniciado', {
      interval_ms: this.intervalMs,
      batch_size: this.batchSize,
      grace_period_ms: this.gracePeriodMs,
    });
  }

  /**
   * Detiene el ciclo periódico de reconciliación.
   */
  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }

    this.logger.info('Servicio de reconciliación de envíos detenido');
  }

  get active(): boolean {
    return this.isRunning;
  }
}
