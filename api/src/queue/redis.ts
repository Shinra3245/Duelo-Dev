import { Redis } from 'ioredis';
import {
  isJudgeJobStreamMessage,
  isJudgeResultNotification,
  JUDGE_RESULTS_CHANNEL,
  JUDGE_STREAM_KEY,
  type JudgeJobStreamMessage,
  type JudgeResultNotification,
} from '@duelodev/shared';
import type { EnqueueJobResult, JudgeQueue } from './types.js';
import type { ResultPublisher } from './results.js';

export interface RedisJudgeQueueOptions {
  redis: Redis;
  streamKey?: string;
}

/**
 * Cola real sobre Redis Streams para despachar trabajos de evaluación al juez (doc 04 §4).
 * Encola los mensajes en formato plano compatible con stream_codec de Python.
 */
export class RedisJudgeQueue implements JudgeQueue {
  private readonly redis: Redis;
  private readonly streamKey: string;
  private readonly ownsClient: boolean;

  constructor(options: RedisJudgeQueueOptions | { redisUrl: string; streamKey?: string }) {
    if ('redis' in options) {
      this.redis = options.redis;
      this.ownsClient = false;
    } else {
      this.redis = new Redis(options.redisUrl);
      this.ownsClient = true;
    }
    this.streamKey = options.streamKey ?? JUDGE_STREAM_KEY;
  }

  async enqueue(job: JudgeJobStreamMessage): Promise<EnqueueJobResult> {
    if (!isJudgeJobStreamMessage(job)) {
      throw new Error('El mensaje del trabajo no cumple con el contrato JudgeJobStreamMessage');
    }

    const flatFields: string[] = [
      'schema_version',
      String(job.schema_version),
      'submission_id',
      job.submission_id,
      'problem_id',
      job.problem_id,
      'problem_version',
      String(job.problem_version),
      'language',
      job.language,
      'source_code',
      job.source_code,
      'time_limit_ms',
      String(job.time_limit_ms),
      'memory_limit_mb',
      String(job.memory_limit_mb),
      'cases_ref',
      job.cases_ref,
      'enqueued_at_ms',
      String(job.enqueued_at_ms),
    ];

    if (job.request_id) {
      flatFields.push('request_id', job.request_id);
    }

    const messageId = await this.redis.xadd(this.streamKey, '*', ...flatFields);
    if (!messageId) {
      throw new Error(`Fallo al encolar en Redis Stream ${this.streamKey}`);
    }

    return {
      messageId,
      stream: this.streamKey,
      job,
    };
  }

  async close(): Promise<void> {
    if (this.ownsClient) {
      await this.redis.quit();
    }
  }
}

/**
 * Publicador real sobre Redis Pub/Sub en el canal `judge:results`.
 */
export class RedisResultPublisher implements ResultPublisher {
  private readonly redis: Redis;
  private readonly channel: string;
  private readonly ownsClient: boolean;

  constructor(
    options: { redis: Redis; channel?: string } | { redisUrl: string; channel?: string },
  ) {
    if ('redis' in options) {
      this.redis = options.redis;
      this.ownsClient = false;
    } else {
      this.redis = new Redis(options.redisUrl);
      this.ownsClient = true;
    }
    this.channel = options.channel ?? JUDGE_RESULTS_CHANNEL;
  }

  async publish(notification: JudgeResultNotification): Promise<void> {
    if (!isJudgeResultNotification(notification)) {
      throw new Error('La notificación no cumple con el contrato JudgeResultNotification');
    }
    await this.redis.publish(this.channel, JSON.stringify(notification));
  }

  async publishResult(notification: JudgeResultNotification): Promise<void> {
    return this.publish(notification);
  }

  async close(): Promise<void> {
    if (this.ownsClient) {
      await this.redis.quit();
    }
  }
}
