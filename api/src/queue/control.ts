import type { Redis } from 'ioredis';
import {
  isMatchControlNotification,
  MATCH_CONTROL_CHANNEL,
  type MatchControlNotification,
} from '@duelodev/shared';

/** Publicador de cambios de ciclo de vida de partidas entre API y Realtime. */
export interface MatchControlPublisher {
  publish(notification: MatchControlNotification): Promise<void>;
}

/** Publicador Redis del canal interno de control de partidas. */
export class RedisMatchControlPublisher implements MatchControlPublisher {
  private readonly redis: Redis;
  private readonly channel: string;

  constructor(options: { redis: Redis; channel?: string }) {
    this.redis = options.redis;
    this.channel = options.channel ?? MATCH_CONTROL_CHANNEL;
  }

  async publish(notification: MatchControlNotification): Promise<void> {
    if (!isMatchControlNotification(notification)) {
      throw new Error('El aviso de control de partida no cumple el contrato compartido');
    }
    await this.redis.publish(this.channel, JSON.stringify(notification));
  }
}
