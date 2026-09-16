import { Redis } from 'ioredis';
import { isJudgeResultNotification, JUDGE_RESULTS_CHANNEL } from '@duelodev/shared';
import type { ResultListener, ResultSubscriber } from './types.js';

export interface RedisResultSubscriberOptions {
  redis?: Redis;
  redisUrl?: string;
  channel?: string;
}

/**
 * Suscriptor real a Redis Pub/Sub sobre el canal `judge:results` (doc 04 §4/§120).
 */
export class RedisResultSubscriber implements ResultSubscriber {
  private readonly redis: Redis;
  private readonly channel: string;
  private readonly ownsClient: boolean;
  private readonly listeners = new Set<ResultListener>();
  private isSubscribed = false;

  constructor(options: RedisResultSubscriberOptions | { redisUrl: string }) {
    if ('redis' in options && options.redis) {
      this.redis = options.redis;
      this.ownsClient = false;
    } else if ('redisUrl' in options && options.redisUrl) {
      this.redis = new Redis(options.redisUrl);
      this.ownsClient = true;
    } else {
      throw new Error('Debe proveerse redis o redisUrl');
    }
    this.channel =
      'channel' in options && options.channel ? options.channel : JUDGE_RESULTS_CHANNEL;

    this.redis.on('message', (chan, message) => {
      if (chan !== this.channel) return;
      try {
        const parsed = JSON.parse(message) as unknown;
        if (isJudgeResultNotification(parsed)) {
          for (const listener of this.listeners) {
            try {
              const res = listener(parsed);
              if (res instanceof Promise) {
                res.catch(() => {
                  // Silenciar error asíncrono no controlado del listener
                });
              }
            } catch {
              // Silenciar error síncrono del listener
            }
          }
        }
      } catch {
        // Silenciar mensaje malformado
      }
    });
  }

  subscribe(listener: ResultListener): () => void {
    this.listeners.add(listener);
    if (!this.isSubscribed) {
      this.isSubscribed = true;
      void this.redis.subscribe(this.channel);
    }

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.isSubscribed) {
        this.isSubscribed = false;
        void this.redis.unsubscribe(this.channel);
      }
    };
  }

  async close(): Promise<void> {
    this.listeners.clear();
    if (this.ownsClient) {
      await this.redis.quit();
    }
  }
}
