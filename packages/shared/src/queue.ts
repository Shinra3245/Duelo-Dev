/**
 * Contratos de mensajes para la cola de ejecución del juez (doc 04 §4).
 *
 * Canal y Streams en Redis:
 * - Stream de trabajo: `judge:stream`, consumer group: `judges`.
 * - Aviso pub/sub de resultados: `judge:results`.
 *
 * FRONTERA DE TIPOS Y RUNTIME:
 * Estos tipos definen el contrato estático de mensajería entre API, Worker y Realtime.
 * La validación en runtime del mensaje al deserializar de Redis se realiza en el consumidor.
 */
import type { Language } from './limits.js';
import type { Verdict } from './verdicts.js';

export const JUDGE_STREAM_KEY = 'judge:stream';
export const JUDGE_CONSUMER_GROUP = 'judges';
export const JUDGE_RESULTS_CHANNEL = 'judge:results';
export const JUDGE_STREAM_SCHEMA_VERSION = 1;

/**
 * Mensaje publicado en el stream `judge:stream` mediante XADD.
 * El ejecutor del juez recibe únicamente la información indispensable para correr el código.
 */
export interface JudgeJobStreamMessage {
  schema_version: number;
  submission_id: string;
  problem_id: string;
  problem_version: number;
  language: Language;
  source_code: string;
  time_limit_ms: number;
  memory_limit_mb: number;
  /** Ruta o referencia de casos autorizada y generada exclusivamente por el servidor. */
  cases_ref: string;
  enqueued_at_ms: number;
  request_id?: string;
}

/**
 * Registro durable almacenado en PostgreSQL tras la evaluación del worker.
 */
export interface JudgeDurableResult {
  submission_id: string;
  verdict: Verdict;
  passed: number;
  total: number;
  exec_time_ms: number;
  judged_at: number;
  /** Máximo 4 KiB saneados; solo presente si el lenguaje compila y hubo salida. */
  compile_output?: string;
  /** Mensaje de diagnóstico interno si ocurrió un SE; no se muestra íntegro al cliente. */
  judge_error?: string;
}

/**
 * Aviso liviano publicado en el canal Redis Pub/Sub `judge:results` para notificar a Realtime.
 * Nota de arquitectura: este aviso es at-most-once; Realtime se reconcilia con PostgreSQL si se pierde.
 */
export interface JudgeResultNotification {
  submission_id: string;
  match_id: string;
  round_id: string;
  user_id: string;
  verdict: Verdict;
  passed: number;
  total: number;
  exec_time_ms: number;
  request_id?: string;
}

export function isJudgeJobStreamMessage(value: unknown): value is JudgeJobStreamMessage {
  if (typeof value !== 'object' || value === null) return false;
  const msg = value as Record<string, unknown>;
  return (
    typeof msg.schema_version === 'number' &&
    typeof msg.submission_id === 'string' &&
    typeof msg.problem_id === 'string' &&
    typeof msg.problem_version === 'number' &&
    typeof msg.language === 'string' &&
    typeof msg.source_code === 'string' &&
    typeof msg.time_limit_ms === 'number' &&
    typeof msg.memory_limit_mb === 'number' &&
    typeof msg.cases_ref === 'string' &&
    typeof msg.enqueued_at_ms === 'number'
  );
}

export function isJudgeResultNotification(value: unknown): value is JudgeResultNotification {
  if (typeof value !== 'object' || value === null) return false;
  const notif = value as Record<string, unknown>;
  return (
    typeof notif.submission_id === 'string' &&
    typeof notif.match_id === 'string' &&
    typeof notif.round_id === 'string' &&
    typeof notif.user_id === 'string' &&
    typeof notif.verdict === 'string' &&
    typeof notif.passed === 'number' &&
    typeof notif.total === 'number' &&
    typeof notif.exec_time_ms === 'number'
  );
}
