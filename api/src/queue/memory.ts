import {
  isJudgeJobStreamMessage,
  JUDGE_STREAM_KEY,
  type JudgeJobStreamMessage,
} from '@duelodev/shared';
import type { EnqueueJobResult, JudgeQueue } from './types.js';

/**
 * Implementación en memoria de la cola del juez para pruebas y desarrollo desacoplado (doc 04 §4).
 * Valida invariantes del contrato `judge:stream` y permite simular caídas de Redis para probar recuperación.
 */
export class InMemoryJudgeQueue implements JudgeQueue {
  private readonly jobs: EnqueueJobResult[] = [];
  private sequence = 0;
  private nextError: Error | null = null;

  /**
   * Encola un mensaje validando estrictamente su contrato contra el esquema canónico (doc 04 §4).
   */
  async enqueue(job: JudgeJobStreamMessage): Promise<EnqueueJobResult> {
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }

    if (!isJudgeJobStreamMessage(job)) {
      throw new Error('El mensaje no cumple los invariantes del contrato JudgeJobStreamMessage.');
    }

    const messageId = `${job.enqueued_at_ms}-${this.sequence++}`;
    const entry: EnqueueJobResult = {
      messageId,
      stream: JUDGE_STREAM_KEY,
      job: { ...job },
    };

    this.jobs.push(entry);
    return { ...entry };
  }

  /** Simula un fallo de conexión o ejecución en la próxima llamada a enqueue(). */
  failNext(
    error: Error = new Error('ECONNREFUSED: Fallo de conexión simulado con Redis Stream'),
  ): void {
    this.nextError = error;
  }

  /** Devuelve una copia de todos los trabajos encolados hasta el momento. */
  getEnqueuedJobs(): ReadonlyArray<EnqueueJobResult> {
    return [...this.jobs];
  }

  /** Busca el trabajo asociado a un submission_id. */
  findBySubmissionId(submissionId: string): EnqueueJobResult | null {
    const found = this.jobs.find((e) => e.job.submission_id === submissionId);
    return found ? { ...found } : null;
  }

  /** Cantidad de mensajes actualmente encolados. */
  count(): number {
    return this.jobs.length;
  }

  /** Limpia el estado interno de la cola. */
  clear(): void {
    this.jobs.length = 0;
    this.sequence = 0;
    this.nextError = null;
  }
}
