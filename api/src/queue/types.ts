import type { JudgeJobStreamMessage, Logger } from '@duelodev/shared';
import type { SubmissionRepository } from '../repositories/types.js';

/** Resultado de encolar un trabajo en el stream del juez. */
export interface EnqueueJobResult {
  messageId: string;
  stream: string;
  job: JudgeJobStreamMessage;
}

/** Contrato abstracto de cola para el stream del juez (doc 04 §4). */
export interface JudgeQueue {
  enqueue(job: JudgeJobStreamMessage): Promise<EnqueueJobResult>;
}

/** Métricas resultantes de una pasada de reconciliación de envíos. */
export interface ReconciliationStats {
  scanned: number;
  reenqueued: number;
  failed: number;
}

/** Opciones de configuración para el servicio de reconciliación de envíos (doc 04 §5). */
export interface SubmissionReconcilerOptions {
  submissionRepo: SubmissionRepository;
  queue: JudgeQueue;
  logger?: Logger;
  /** Intervalo en milisegundos entre pasadas de reconciliación (por defecto: 5000 ms). */
  intervalMs?: number;
  /** Cantidad máxima de envíos evaluados por pasada (por defecto: 50). */
  batchSize?: number;
  /** Período de gracia en milisegundos tras received_at antes de considerar re-despacho (por defecto: 2000 ms). */
  gracePeriodMs?: number;
}
