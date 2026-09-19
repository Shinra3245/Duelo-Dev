import type { Redis } from 'ioredis';
import {
  isMatchControlNotification,
  MATCH_CONTROL_CHANNEL,
  type MatchControlNotification,
} from '@duelodev/shared';

export type MatchControlListener = (notification: MatchControlNotification) => Promise<void> | void;

export interface MatchControlSubscriber {
  subscribe(listener: MatchControlListener): () => void;
}

/** Suscriptor Redis de ciclo de vida de partidas. */
export class RedisMatchControlSubscriber implements MatchControlSubscriber {
  private readonly redis: Redis;
  private readonly channel: string;
  private readonly listeners = new Set<MatchControlListener>();
  private subscribed = false;

  constructor(options: { redis: Redis; channel?: string }) {
    this.redis = options.redis;
    this.channel = options.channel ?? MATCH_CONTROL_CHANNEL;
    this.redis.on('message', (channel, message) => {
      if (channel !== this.channel) return;
      try {
        const parsed = JSON.parse(message) as unknown;
        if (!isMatchControlNotification(parsed)) return;
        for (const listener of this.listeners) {
          try {
            const result = listener(parsed);
            if (result instanceof Promise) {
              result.catch(() => undefined);
            }
          } catch {
            // Un listener defectuoso no debe detener el resto del canal interno.
          }
        }
      } catch {
        // Ignorar mensajes malformados del canal interno.
      }
    });
  }

  subscribe(listener: MatchControlListener): () => void {
    this.listeners.add(listener);
    if (!this.subscribed) {
      this.subscribed = true;
      void this.redis.subscribe(this.channel);
    }

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.subscribed) {
        this.subscribed = false;
        void this.redis.unsubscribe(this.channel);
      }
    };
  }
}
