/**
 * Canal de publicación y suscripción para avisos de resultados del juez (doc 04 §4).
 * Canal Redis Pub/Sub objetivo: `judge:results` (JUDGE_RESULTS_CHANNEL).
 */
import {
  type JudgeResultNotification,
  JUDGE_RESULTS_CHANNEL,
  isJudgeResultNotification,
} from '@duelodev/shared';

export type ResultListener = (notification: JudgeResultNotification) => Promise<void> | void;

export interface ResultPublisher {
  publishResult(notification: JudgeResultNotification): Promise<void>;
}

export interface ResultSubscriber {
  subscribe(listener: ResultListener): () => void;
}

/**
 * Canal Pub/Sub en memoria que simula la publicación en el canal Redis `judge:results`.
 * Valida invariantes estrictos mediante `isJudgeResultNotification`.
 */
export class InMemoryResultChannel implements ResultPublisher, ResultSubscriber {
  readonly channelName = JUDGE_RESULTS_CHANNEL;
  private readonly listeners = new Set<ResultListener>();
  private readonly publishedHistory: JudgeResultNotification[] = [];

  async publishResult(notification: JudgeResultNotification): Promise<void> {
    if (!isJudgeResultNotification(notification)) {
      throw new Error('El aviso de resultado no cumple los invariantes de JudgeResultNotification');
    }

    this.publishedHistory.push({ ...notification });

    // Notificar a todos los suscriptores de forma asíncrona
    const notifications = Array.from(this.listeners).map(async (listener) => {
      try {
        await listener({ ...notification });
      } catch (err) {
        // Los errores de un suscriptor no deben propagarse ni abortar la entrega al resto
        console.error('Error en suscriptor de judge:results', err);
      }
    });

    await Promise.all(notifications);
  }

  subscribe(listener: ResultListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getPublishedHistory(): readonly JudgeResultNotification[] {
    return [...this.publishedHistory];
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
    this.publishedHistory.length = 0;
  }
}
