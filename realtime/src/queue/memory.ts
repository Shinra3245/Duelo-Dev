import { isJudgeResultNotification, type JudgeResultNotification } from '@duelodev/shared';
import type {
  JudgedSubmissionRecord,
  ProcessedSubmissionStore,
  ResultListener,
  ResultPublisher,
  ResultSubscriber,
  SubmissionProvider,
} from './types.js';

/**
 * Canal Pub/Sub en memoria que implementa `ResultSubscriber` y `ResultPublisher`.
 * Valida las notificaciones entrantes con `isJudgeResultNotification` y despacha
 * a los suscriptores activos.
 */
export class InMemoryResultChannel implements ResultSubscriber, ResultPublisher {
  private readonly listeners = new Set<ResultListener>();

  subscribe(listener: ResultListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async publish(notification: JudgeResultNotification): Promise<void> {
    if (!isJudgeResultNotification(notification)) {
      throw new Error(
        'Notificación de resultado inválida según esquema de JudgeResultNotification',
      );
    }

    const currentListeners = Array.from(this.listeners);
    await Promise.all(
      currentListeners.map(async (listener) => {
        try {
          await listener(notification);
        } catch {
          // Aislamiento de excepciones entre suscriptores
        }
      }),
    );
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
  }
}

/**
 * Almacén en memoria de envíos procesados para control de idempotencia (doc 04 §132).
 */
export class InMemoryProcessedSubmissionStore implements ProcessedSubmissionStore {
  private readonly processedKeys = new Set<string>();
  private readonly processingKeys = new Set<string>();

  private makeKey(matchId: string, submissionId: string): string {
    return `${matchId}:${submissionId}`;
  }

  async hasBeenProcessed(matchId: string, submissionId: string): Promise<boolean> {
    return this.processedKeys.has(this.makeKey(matchId, submissionId));
  }

  async claimProcessing(matchId: string, submissionId: string): Promise<boolean> {
    const key = this.makeKey(matchId, submissionId);
    if (this.processedKeys.has(key) || this.processingKeys.has(key)) {
      return false;
    }
    this.processingKeys.add(key);
    return true;
  }

  async releaseProcessing(matchId: string, submissionId: string): Promise<void> {
    const key = this.makeKey(matchId, submissionId);
    this.processingKeys.delete(key);
  }

  async markProcessed(matchId: string, submissionId: string): Promise<void> {
    const key = this.makeKey(matchId, submissionId);
    this.processingKeys.delete(key);
    this.processedKeys.add(key);
  }

  async countProcessed(matchId?: string): Promise<number> {
    if (matchId === undefined) {
      return this.processedKeys.size;
    }

    const prefix = `${matchId}:`;
    let count = 0;
    for (const key of this.processedKeys) {
      if (key.startsWith(prefix)) {
        count++;
      }
    }
    return count;
  }

  clear(): void {
    this.processedKeys.clear();
    this.processingKeys.clear();
  }
}

/**
 * Proveedor de envíos juzgados en memoria para pruebas y desarrollo.
 */
export class InMemorySubmissionProvider implements SubmissionProvider {
  private readonly records = new Map<string, JudgedSubmissionRecord>();

  addSubmission(record: JudgedSubmissionRecord): void {
    this.records.set(record.id, { ...record });
  }

  async findJudgedSubmissionsByMatch(matchId: string): Promise<JudgedSubmissionRecord[]> {
    const results: JudgedSubmissionRecord[] = [];
    for (const record of this.records.values()) {
      if (record.match_id === matchId) {
        results.push({ ...record });
      }
    }
    return results;
  }

  async findJudgedSubmissionById(submissionId: string): Promise<JudgedSubmissionRecord | null> {
    const record = this.records.get(submissionId);
    return record ? { ...record } : null;
  }

  async getCompileOutput(submissionId: string): Promise<string | undefined> {
    const record = this.records.get(submissionId);
    return record?.compile_output;
  }

  clear(): void {
    this.records.clear();
  }
}
