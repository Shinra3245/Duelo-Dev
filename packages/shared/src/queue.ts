/**
 * Contratos de mensajes para la cola de ejecución del juez (doc 04 §4).
 *
 * Canal y Streams en Redis:
 * - Stream de trabajo: `judge:stream`, consumer group: `judges`.
 * - Aviso pub/sub de resultados: `judge:results`.
 *
 * FRONTERA DE TIPOS Y RUNTIME:
 * Estos tipos definen el contrato estático de mensajería entre API, Worker y Realtime.
 * Las guardias de tipo estáticas aquí provistas validan invariantes de serialización
 * y límites operativos al recibir mensajes de Redis.
 */
import { type Language, SOURCE_CODE_MAX_BYTES, isLanguage } from './limits.js';
import { type Verdict, isVerdict } from './verdicts.js';
import { MAX_COMPILE_OUTPUT_BYTES } from './events.js';

export const JUDGE_STREAM_KEY = 'judge:stream';
export const JUDGE_CONSUMER_GROUP = 'judges';
export const JUDGE_RESULTS_CHANNEL = 'judge:results';
export const JUDGE_STREAM_SCHEMA_VERSION = 1;
export const MATCH_CONTROL_CHANNEL = 'match:control';
export const MATCH_CONTROL_SCHEMA_VERSION = 1;

/**
 * Aviso interno para sincronizar cambios administrativos de una partida entre API y Realtime.
 * No contiene credenciales, código fuente ni datos de los jugadores.
 */
export interface MatchControlNotification {
  schema_version: number;
  type: 'match_closed';
  match_id: string;
  state_version: number;
  issued_at_ms: number;
}

export function isMatchControlNotification(value: unknown): value is MatchControlNotification {
  if (typeof value !== 'object' || value === null) return false;
  const notification = value as Record<string, unknown>;
  return (
    notification.schema_version === MATCH_CONTROL_SCHEMA_VERSION &&
    notification.type === 'match_closed' &&
    typeof notification.match_id === 'string' &&
    notification.match_id.length > 0 &&
    typeof notification.state_version === 'number' &&
    Number.isInteger(notification.state_version) &&
    notification.state_version >= 1 &&
    typeof notification.issued_at_ms === 'number' &&
    Number.isFinite(notification.issued_at_ms) &&
    notification.issued_at_ms > 0
  );
}

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

/**
 * Guardia estricta para mensajes del stream de ejecución.
 * Valida schema_version canónica, identificadores no vacíos, lenguaje soportado,
 * límites positivos y límite máximo de código fuente (64 KiB).
 */
export function isJudgeJobStreamMessage(value: unknown): value is JudgeJobStreamMessage {
  if (typeof value !== 'object' || value === null) return false;
  const msg = value as Record<string, unknown>;
  return (
    msg.schema_version === JUDGE_STREAM_SCHEMA_VERSION &&
    typeof msg.submission_id === 'string' &&
    msg.submission_id.length > 0 &&
    typeof msg.problem_id === 'string' &&
    msg.problem_id.length > 0 &&
    typeof msg.problem_version === 'number' &&
    Number.isInteger(msg.problem_version) &&
    msg.problem_version >= 1 &&
    isLanguage(msg.language) &&
    typeof msg.source_code === 'string' &&
    msg.source_code.length <= SOURCE_CODE_MAX_BYTES &&
    typeof msg.time_limit_ms === 'number' &&
    Number.isFinite(msg.time_limit_ms) &&
    msg.time_limit_ms > 0 &&
    typeof msg.memory_limit_mb === 'number' &&
    Number.isFinite(msg.memory_limit_mb) &&
    msg.memory_limit_mb > 0 &&
    typeof msg.cases_ref === 'string' &&
    msg.cases_ref.length > 0 &&
    typeof msg.enqueued_at_ms === 'number' &&
    Number.isFinite(msg.enqueued_at_ms) &&
    msg.enqueued_at_ms > 0 &&
    (msg.request_id === undefined ||
      (typeof msg.request_id === 'string' && msg.request_id.length > 0))
  );
}

/**
 * Guardia estricta para el resultado durable emitido por el worker.
 * Valida veredicto canónico, invariante passed <= total, tiempos válidos
 * y tope de 4 KiB en compile_output.
 */
export function isJudgeDurableResult(value: unknown): value is JudgeDurableResult {
  if (typeof value !== 'object' || value === null) return false;
  const res = value as Record<string, unknown>;
  return (
    typeof res.submission_id === 'string' &&
    res.submission_id.length > 0 &&
    isVerdict(res.verdict) &&
    typeof res.passed === 'number' &&
    Number.isInteger(res.passed) &&
    res.passed >= 0 &&
    typeof res.total === 'number' &&
    Number.isInteger(res.total) &&
    res.total >= 0 &&
    res.passed <= res.total &&
    typeof res.exec_time_ms === 'number' &&
    Number.isFinite(res.exec_time_ms) &&
    res.exec_time_ms >= 0 &&
    typeof res.judged_at === 'number' &&
    Number.isFinite(res.judged_at) &&
    res.judged_at > 0 &&
    (res.compile_output === undefined ||
      (typeof res.compile_output === 'string' &&
        res.compile_output.length <= MAX_COMPILE_OUTPUT_BYTES)) &&
    (res.judge_error === undefined || typeof res.judge_error === 'string')
  );
}

/**
 * Guardia estricta para notificaciones livianas Pub/Sub de resultados.
 * Valida campos de correlación de partida/ronda/usuario y consistencia de veredicto/casos.
 */
export function isJudgeResultNotification(value: unknown): value is JudgeResultNotification {
  if (typeof value !== 'object' || value === null) return false;
  const notif = value as Record<string, unknown>;
  return (
    typeof notif.submission_id === 'string' &&
    notif.submission_id.length > 0 &&
    typeof notif.match_id === 'string' &&
    notif.match_id.length > 0 &&
    typeof notif.round_id === 'string' &&
    notif.round_id.length > 0 &&
    typeof notif.user_id === 'string' &&
    notif.user_id.length > 0 &&
    isVerdict(notif.verdict) &&
    typeof notif.passed === 'number' &&
    Number.isInteger(notif.passed) &&
    notif.passed >= 0 &&
    typeof notif.total === 'number' &&
    Number.isInteger(notif.total) &&
    notif.total >= 0 &&
    notif.passed <= notif.total &&
    typeof notif.exec_time_ms === 'number' &&
    Number.isFinite(notif.exec_time_ms) &&
    notif.exec_time_ms >= 0 &&
    (notif.request_id === undefined ||
      (typeof notif.request_id === 'string' && notif.request_id.length > 0))
  );
}
