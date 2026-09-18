/**
 * Catálogo tipado de eventos WebSocket y contratos de estado de partida (doc 04 §3).
 *
 * Esta es la ÚNICA definición de eventos en el monorepo. Ni `realtime/` ni `web/`
 * escriben literales de nombres de evento: importan estas constantes.
 *
 * FRONTERA DE TIPOS Y RUNTIME:
 * TypeScript proporciona tipado en tiempo de compilación y no valida tráfico en runtime.
 * La validación estricta de payloads entrantes por WS y HTTP se realiza mediante
 * JSON Schema / validadores en las capas de API y Realtime.
 * Este módulo incluye guardias de tipo estáticas y reusables para validar invariantes
 * en capas de coordinación sin agregar dependencias externas.
 */
import { type Verdict, isVerdict } from './verdicts.js';

export const MATCH_NAMESPACE = '/match';

/** Nombre de la room de Socket.io para una partida. */
export function matchRoom(matchId: string): string {
  return `match:${matchId}`;
}

// ─────────────────────────── Cliente → Servidor ───────────────────────────

export const C2S = {
  JOIN_MATCH: 'join_match',
  TOGGLE_REVEAL: 'toggle_reveal',
  READY: 'ready',
  HEARTBEAT: 'heartbeat',
} as const;

export type ClientEventName = (typeof C2S)[keyof typeof C2S];

export interface ClientToServerEvents {
  [C2S.JOIN_MATCH]: (payload: { match_id: string }) => void;
  [C2S.TOGGLE_REVEAL]: (payload: { visible: boolean }) => void;
  [C2S.READY]: (payload: Record<string, never>) => void;
  [C2S.HEARTBEAT]: (payload: Record<string, never>) => void;
}

// ─────────────────────────── Servidor → Cliente ───────────────────────────

export const S2C = {
  MATCH_STARTED: 'match_started',
  MATCH_SYNC: 'match_sync',
  PROBLEM_BEGIN: 'problem_begin',
  SUBMISSION_RECEIVED: 'submission_received',
  VERDICT: 'verdict',
  SCORE_UPDATE: 'score_update',
  REVEAL_CHANGED: 'reveal_changed',
  PLAYER_STATUS: 'player_status',
  MATCH_FINISHED: 'match_finished',
  ERROR: 'error',
} as const;

export type ServerEventName = (typeof S2C)[keyof typeof S2C];

/**
 * Estados del ciclo de vida de la partida:
 * - `lobby`: en espera de participantes y preparación.
 * - `running`: partida activa admitiendo envíos.
 * - `settling`: tiempo agotado o meta alcanzada; resolviendo envíos admitidos antes del corte.
 * - `finished`: terminada con resultado final durable.
 * - `abandoned`: interrumpida por abandono o fallo irrecuperable de sistema.
 */
export const MATCH_STATUSES = ['lobby', 'running', 'settling', 'finished', 'abandoned'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export function isMatchStatus(value: unknown): value is MatchStatus {
  return typeof value === 'string' && (MATCH_STATUSES as readonly string[]).includes(value);
}

/**
 * Estados de la ocurrencia de un problema / ronda:
 * - `open`: admite envíos respetando cooldown.
 * - `settling`: primer AC candidato o tiempo agotado; evaluando envíos admitidos hasta el corte.
 * - `closed`: resuelta definitivamente, puntaje asignado.
 */
export const ROUND_STATUSES = ['open', 'settling', 'closed'] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

export function isRoundStatus(value: unknown): value is RoundStatus {
  return typeof value === 'string' && (ROUND_STATUSES as readonly string[]).includes(value);
}

export const PLAYER_CONNECTIONS = ['connected', 'disconnected', 'left'] as const;
export type PlayerConnection = (typeof PLAYER_CONNECTIONS)[number];

export function isPlayerConnection(value: unknown): value is PlayerConnection {
  return typeof value === 'string' && (PLAYER_CONNECTIONS as readonly string[]).includes(value);
}

export const GAME_MODE_NAMES = ['puntos', 'rondas'] as const;
export type GameModeName = (typeof GAME_MODE_NAMES)[number];

export function isGameModeName(value: unknown): value is GameModeName {
  return typeof value === 'string' && (GAME_MODE_NAMES as readonly string[]).includes(value);
}

export const PROBLEM_CATEGORIES = ['muy_facil', 'facil', 'facil_medio', 'dificil'] as const;
export type ProblemCategory = (typeof PROBLEM_CATEGORIES)[number];

/** Dificultades habilitadas para el MVP; `dificil` queda fuera del flujo principal. */
export const ACTIVE_PROBLEM_CATEGORIES = ['muy_facil', 'facil', 'facil_medio'] as const;
export type ActiveProblemCategory = (typeof ACTIVE_PROBLEM_CATEGORIES)[number];

export const PROBLEM_CATEGORY_LABELS: Record<ProblemCategory, string> = {
  muy_facil: 'Inicial',
  facil: 'Fácil',
  facil_medio: 'Medio',
  dificil: 'Difícil',
};

export function isProblemCategory(value: unknown): value is ProblemCategory {
  return typeof value === 'string' && (PROBLEM_CATEGORIES as readonly string[]).includes(value);
}

/** Valores válidos para la meta de problemas resueltos en Rondas (doc 02 §4). */
export const RONDAS_TARGET_VALUES = [3, 6, 9, 10] as const;
export type RondasTarget = (typeof RONDAS_TARGET_VALUES)[number];

export function isRondasTarget(value: unknown): value is RondasTarget {
  return typeof value === 'number' && (RONDAS_TARGET_VALUES as readonly number[]).includes(value);
}

/**
 * Motivos tipados de finalización de una partida (doc 02 §5, §6 y doc 04 §3).
 */
export const MATCH_FINISH_REASONS = [
  'target_reached',
  'problems_exhausted',
  'time_expired',
  'abandonment',
  'all_players_left',
  'judge_unavailable',
  'host_timeout',
  'admin_override',
] as const;

export type MatchFinishReason = (typeof MATCH_FINISH_REASONS)[number];

export const MATCH_FINISH_REASON_LABELS: Record<MatchFinishReason, string> = {
  target_reached: 'Meta de problemas alcanzada',
  problems_exhausted: 'Todos los problemas completados',
  time_expired: 'Tiempo agotado',
  abandonment: 'Victoria por abandono rival',
  all_players_left: 'Partida abandonada por todos los participantes',
  judge_unavailable: 'Servicio de evaluación no disponible',
  host_timeout: 'Tiempo de espera del anfitrión agotado en lobby',
  admin_override: 'Resolución manual del administrador',
};

export function isMatchFinishReason(value: unknown): value is MatchFinishReason {
  return typeof value === 'string' && (MATCH_FINISH_REASONS as readonly string[]).includes(value);
}

// ─────────────────────── Configuración de partida ─────────────────────────

interface BaseMatchConfig {
  num_problems: number;
  categories: ProblemCategory[];
  max_players: number;
}

/**
 * Configuración del modo Puntos:
 * - `time_per_problem_s`: duración por cada problema en segundos.
 * - `award_on_timeout` queda eliminado permanentemente del MVP (doc 02 §1).
 */
export interface PuntosMatchConfig extends BaseMatchConfig {
  mode: 'puntos';
  time_per_problem_s: number;
  match_duration_s?: never;
  target?: never;
  award_on_timeout?: never;
}

/**
 * Configuración del modo Rondas:
 * - `match_duration_s`: duración global de la partida en segundos.
 * - `target`: número de problemas a resolver para ganar (en {3, 6, 9, 10}).
 */
export interface RondasMatchConfig extends BaseMatchConfig {
  mode: 'rondas';
  match_duration_s: number;
  target: number;
  time_per_problem_s?: never;
  award_on_timeout?: never;
}

/** Configuración inequívoca discriminada por `mode` (doc 04 §3). */
export type MatchConfig = PuntosMatchConfig | RondasMatchConfig;

/**
 * Valida de forma estricta los invariantes de configuración de partida:
 * - Enteros positivos para tiempos y problemas.
 * - Al menos 2 jugadores máximos.
 * - Categorías válidas no vacías.
 * - En Rondas: target en {3, 6, 9, 10} y target <= num_problems.
 * - Prohibición expresa de award_on_timeout.
 */
export function isMatchConfig(value: unknown): value is MatchConfig {
  if (typeof value !== 'object' || value === null) return false;
  const cfg = value as Record<string, unknown>;

  if (
    typeof cfg.num_problems !== 'number' ||
    !Number.isInteger(cfg.num_problems) ||
    cfg.num_problems <= 0
  ) {
    return false;
  }

  if (
    typeof cfg.max_players !== 'number' ||
    !Number.isInteger(cfg.max_players) ||
    cfg.max_players < 2
  ) {
    return false;
  }

  if (
    !Array.isArray(cfg.categories) ||
    cfg.categories.length === 0 ||
    !cfg.categories.every(isProblemCategory)
  ) {
    return false;
  }

  if ('award_on_timeout' in cfg && cfg.award_on_timeout !== undefined) {
    return false;
  }

  if (cfg.mode === 'puntos') {
    return (
      typeof cfg.time_per_problem_s === 'number' &&
      Number.isInteger(cfg.time_per_problem_s) &&
      cfg.time_per_problem_s > 0 &&
      cfg.match_duration_s === undefined &&
      cfg.target === undefined
    );
  }

  if (cfg.mode === 'rondas') {
    return (
      typeof cfg.match_duration_s === 'number' &&
      Number.isInteger(cfg.match_duration_s) &&
      cfg.match_duration_s > 0 &&
      isRondasTarget(cfg.target) &&
      cfg.target <= cfg.num_problems &&
      cfg.time_per_problem_s === undefined
    );
  }

  return false;
}

export function isPuntosConfig(value: unknown): value is PuntosMatchConfig {
  return isMatchConfig(value) && value.mode === 'puntos';
}

export function isRondasConfig(value: unknown): value is RondasMatchConfig {
  return isMatchConfig(value) && value.mode === 'rondas';
}

// ─────────────────────── Estampas y versión de estado ─────────────────────

/** Todo evento S→C lleva `server_time` en epoch ms para calibrar desfase de reloj. */
export interface ServerStamped {
  server_time: number;
}

/** Eventos que notifican transiciones de estado de juego llevan `match_id` y `state_version`. */
export interface StateStamped extends ServerStamped {
  match_id: string;
  state_version: number;
}

export interface PlayerScore {
  user_id: string;
  gamertag: string;
  score: number;
  cases_total: number;
  time_total_ms: number;
  current_problem_idx: number;
}

export function isPlayerScore(value: unknown): value is PlayerScore {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.user_id === 'string' &&
    p.user_id.length > 0 &&
    typeof p.gamertag === 'string' &&
    p.gamertag.length > 0 &&
    typeof p.score === 'number' &&
    Number.isInteger(p.score) &&
    p.score >= 0 &&
    typeof p.cases_total === 'number' &&
    Number.isInteger(p.cases_total) &&
    p.cases_total >= 0 &&
    typeof p.time_total_ms === 'number' &&
    Number.isFinite(p.time_total_ms) &&
    p.time_total_ms >= 0 &&
    typeof p.current_problem_idx === 'number' &&
    Number.isInteger(p.current_problem_idx) &&
    p.current_problem_idx >= 0
  );
}

/**
 * Sincronización individual por jugador (doc 04 §3).
 *
 * En Rondas, este payload se envía personalizado a cada participante:
 * - Incluye su problema actual (`problem_id`, `round_id`, `problem_index`, `ends_at`).
 * - NO incluye problemas futuros de la lista para evitar filtraciones.
 * - Informa el progreso de todos mediante `scores` (posiciones e índices) y presencia.
 */
export interface MatchSyncPayload extends StateStamped {
  status: MatchStatus;
  mode: GameModeName;
  round_id: string | null;
  problem_id: string | null;
  problem_index: number;
  /** Instante absoluto de fin en epoch ms. El reloj del cliente se deriva de aquí. */
  ends_at: number | null;
  round_status: RoundStatus | null;
  scores: PlayerScore[];
  reveal_flags: Record<string, boolean>;
  players: Record<string, PlayerConnection>;
  winner_ids?: string[];
  winner_id?: string | null;
  finish_reason?: MatchFinishReason;
}

// ────────────────────── Payloads Servidor → Cliente ───────────────────────

export interface MatchStartedPayload extends StateStamped {
  mode: GameModeName;
  round_id: string;
  config: MatchConfig;
  /** Lista de problemas solo se envía en Puntos si ya está fijada, nunca en Rondas por adelantado. */
  problem_order?: string[];
}

export interface ProblemBeginPayload extends StateStamped {
  round_id: string;
  problem_id: string;
  index: number;
  ends_at: number;
}

export interface SubmissionReceivedPayload extends ServerStamped {
  match_id: string;
  round_id: string;
  submission_id: string;
  user_id: string;
}

export interface VerdictPayload extends ServerStamped {
  match_id: string;
  round_id: string;
  submission_id: string;
  user_id: string;
  verdict: Verdict;
  passed: number;
  total: number;
  exec_time_ms?: number;
  /** Máximo 4 KiB; solo se envía al dueño del envío, nunca a los demás (doc 04 §3). */
  compile_output?: string;
}

export interface ScoreUpdatePayload extends StateStamped {
  round_id?: string;
  scores: PlayerScore[];
}

export interface RevealChangedPayload extends ServerStamped {
  match_id: string;
  user_id: string;
  visible: boolean;
}

export interface PlayerStatusPayload extends ServerStamped {
  match_id: string;
  user_id: string;
  status: PlayerConnection;
}

export interface MatchFinishedPayload extends StateStamped {
  /** Estado durable resultante para distinguir una finalización normal de un abandono/cierre. */
  status: 'finished' | 'abandoned';
  /** Todos los ganadores en empates; vacío en partida abandonada (doc 02 §6). */
  winner_ids: string[];
  /** Singular para compatibilidad; null cuando hay empate o no hay ganador. */
  winner_id: string | null;
  finish_reason: MatchFinishReason;
  final_scores: PlayerScore[];
  summary_url: string;
}

export interface EventErrorPayload extends ServerStamped {
  match_id?: string;
  code: string;
  message: string;
}

export interface ServerToClientEvents {
  [S2C.MATCH_STARTED]: (p: MatchStartedPayload) => void;
  [S2C.MATCH_SYNC]: (p: MatchSyncPayload) => void;
  [S2C.PROBLEM_BEGIN]: (p: ProblemBeginPayload) => void;
  [S2C.SUBMISSION_RECEIVED]: (p: SubmissionReceivedPayload) => void;
  [S2C.VERDICT]: (p: VerdictPayload) => void;
  [S2C.SCORE_UPDATE]: (p: ScoreUpdatePayload) => void;
  [S2C.REVEAL_CHANGED]: (p: RevealChangedPayload) => void;
  [S2C.PLAYER_STATUS]: (p: PlayerStatusPayload) => void;
  [S2C.MATCH_FINISHED]: (p: MatchFinishedPayload) => void;
  [S2C.ERROR]: (p: EventErrorPayload) => void;
}

// ─────────────────────── Presupuestos y límites de evento ──────────────────

/** Presupuesto máximo por evento en bytes (doc 04 §3). El código fuente viaja por Yjs. */
export const MAX_EVENT_PAYLOAD_BYTES = 8 * 1024;
/** Límite de tamaño de un documento Yjs, defensa contra agotamiento de RAM (H12). */
export const MAX_YDOC_BYTES = 256 * 1024;
/** Máximo de salida de compilador enviada únicamente al dueño (doc 04 §3). */
export const MAX_COMPILE_OUTPUT_BYTES = 4 * 1024;
/** Gracia de reconexión antes de marcar a un jugador como desconectado (§9). */
export const RECONNECT_GRACE_MS = 60_000;
/** Tiempo máximo de espera en lobby al anfitrión ausente antes de cancelar la sala (doc 02 §5). */
export const HOST_LOBBY_TIMEOUT_MS = 60_000;

// ────────────────── Guardias de invariantes para eventos ──────────────────

export function isMatchStartedPayload(value: unknown): value is MatchStartedPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.match_id === 'string' &&
    p.match_id.length > 0 &&
    typeof p.state_version === 'number' &&
    Number.isInteger(p.state_version) &&
    p.state_version >= 1 &&
    typeof p.server_time === 'number' &&
    Number.isFinite(p.server_time) &&
    p.server_time > 0 &&
    isGameModeName(p.mode) &&
    typeof p.round_id === 'string' &&
    p.round_id.length > 0 &&
    isMatchConfig(p.config) &&
    (p.problem_order === undefined ||
      (Array.isArray(p.problem_order) &&
        p.problem_order.every((id) => typeof id === 'string' && id.length > 0)))
  );
}

export function isProblemBeginPayload(value: unknown): value is ProblemBeginPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.match_id === 'string' &&
    p.match_id.length > 0 &&
    typeof p.state_version === 'number' &&
    Number.isInteger(p.state_version) &&
    p.state_version >= 1 &&
    typeof p.server_time === 'number' &&
    Number.isFinite(p.server_time) &&
    p.server_time > 0 &&
    typeof p.round_id === 'string' &&
    p.round_id.length > 0 &&
    typeof p.problem_id === 'string' &&
    p.problem_id.length > 0 &&
    typeof p.index === 'number' &&
    Number.isInteger(p.index) &&
    p.index >= 0 &&
    typeof p.ends_at === 'number' &&
    Number.isFinite(p.ends_at) &&
    p.ends_at > 0
  );
}

export function isSubmissionReceivedPayload(value: unknown): value is SubmissionReceivedPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.match_id === 'string' &&
    p.match_id.length > 0 &&
    typeof p.round_id === 'string' &&
    p.round_id.length > 0 &&
    typeof p.submission_id === 'string' &&
    p.submission_id.length > 0 &&
    typeof p.user_id === 'string' &&
    p.user_id.length > 0 &&
    typeof p.server_time === 'number' &&
    Number.isFinite(p.server_time) &&
    p.server_time > 0
  );
}

export function isVerdictPayload(value: unknown): value is VerdictPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.match_id === 'string' &&
    p.match_id.length > 0 &&
    typeof p.round_id === 'string' &&
    p.round_id.length > 0 &&
    typeof p.submission_id === 'string' &&
    p.submission_id.length > 0 &&
    typeof p.user_id === 'string' &&
    p.user_id.length > 0 &&
    isVerdict(p.verdict) &&
    typeof p.passed === 'number' &&
    Number.isInteger(p.passed) &&
    p.passed >= 0 &&
    typeof p.total === 'number' &&
    Number.isInteger(p.total) &&
    p.total >= 0 &&
    p.passed <= p.total &&
    typeof p.server_time === 'number' &&
    Number.isFinite(p.server_time) &&
    p.server_time > 0 &&
    (p.exec_time_ms === undefined ||
      (typeof p.exec_time_ms === 'number' &&
        Number.isFinite(p.exec_time_ms) &&
        p.exec_time_ms >= 0)) &&
    (p.compile_output === undefined ||
      (typeof p.compile_output === 'string' && p.compile_output.length <= MAX_COMPILE_OUTPUT_BYTES))
  );
}

export function isScoreUpdatePayload(value: unknown): value is ScoreUpdatePayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.match_id === 'string' &&
    p.match_id.length > 0 &&
    typeof p.state_version === 'number' &&
    Number.isInteger(p.state_version) &&
    p.state_version >= 1 &&
    typeof p.server_time === 'number' &&
    Number.isFinite(p.server_time) &&
    p.server_time > 0 &&
    Array.isArray(p.scores) &&
    p.scores.every(isPlayerScore) &&
    (p.round_id === undefined || (typeof p.round_id === 'string' && p.round_id.length > 0))
  );
}

export function isRevealChangedPayload(value: unknown): value is RevealChangedPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.match_id === 'string' &&
    p.match_id.length > 0 &&
    typeof p.user_id === 'string' &&
    p.user_id.length > 0 &&
    typeof p.visible === 'boolean' &&
    typeof p.server_time === 'number' &&
    Number.isFinite(p.server_time) &&
    p.server_time > 0
  );
}

export function isPlayerStatusPayload(value: unknown): value is PlayerStatusPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.match_id === 'string' &&
    p.match_id.length > 0 &&
    typeof p.user_id === 'string' &&
    p.user_id.length > 0 &&
    isPlayerConnection(p.status) &&
    typeof p.server_time === 'number' &&
    Number.isFinite(p.server_time) &&
    p.server_time > 0
  );
}

export function isMatchFinishedPayload(value: unknown): value is MatchFinishedPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;

  if (
    typeof p.match_id !== 'string' ||
    p.match_id.length === 0 ||
    typeof p.state_version !== 'number' ||
    !Number.isInteger(p.state_version) ||
    p.state_version < 1 ||
    typeof p.server_time !== 'number' ||
    !Number.isFinite(p.server_time) ||
    p.server_time <= 0 ||
    (p.status !== 'finished' && p.status !== 'abandoned') ||
    !Array.isArray(p.winner_ids) ||
    !p.winner_ids.every((id) => typeof id === 'string' && id.length > 0) ||
    !isMatchFinishReason(p.finish_reason) ||
    !Array.isArray(p.final_scores) ||
    !p.final_scores.every(isPlayerScore) ||
    typeof p.summary_url !== 'string' ||
    p.summary_url.length === 0
  ) {
    return false;
  }

  // Invariante de desempate y ganadores (doc 02 §6):
  // Un único ganador implica winner_id === winner_ids[0]; empate o sin ganadores implica winner_id === null.
  if (p.winner_ids.length === 1) {
    return p.winner_id === p.winner_ids[0];
  }
  return p.winner_id === null;
}

export function isMatchSyncPayload(value: unknown): value is MatchSyncPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;

  if (
    typeof p.match_id !== 'string' ||
    p.match_id.length === 0 ||
    typeof p.state_version !== 'number' ||
    !Number.isInteger(p.state_version) ||
    p.state_version < 1 ||
    typeof p.server_time !== 'number' ||
    !Number.isFinite(p.server_time) ||
    p.server_time <= 0 ||
    !isMatchStatus(p.status) ||
    !isGameModeName(p.mode) ||
    (p.round_id !== null && typeof p.round_id !== 'string') ||
    (p.problem_id !== null && typeof p.problem_id !== 'string') ||
    typeof p.problem_index !== 'number' ||
    !Number.isInteger(p.problem_index) ||
    p.problem_index < 0 ||
    (p.ends_at !== null &&
      (typeof p.ends_at !== 'number' || !Number.isFinite(p.ends_at) || p.ends_at <= 0)) ||
    (p.round_status !== null && !isRoundStatus(p.round_status)) ||
    !Array.isArray(p.scores) ||
    !p.scores.every(isPlayerScore) ||
    typeof p.reveal_flags !== 'object' ||
    p.reveal_flags === null ||
    !Object.values(p.reveal_flags).every((v) => typeof v === 'boolean') ||
    typeof p.players !== 'object' ||
    p.players === null ||
    !Object.values(p.players).every(isPlayerConnection)
  ) {
    return false;
  }

  // En Rondas, está estrictamente prohibido exponer problem_order para no revelar problemas futuros (doc 04 §3)
  if (p.mode === 'rondas' && 'problem_order' in p && p.problem_order !== undefined) {
    return false;
  }

  return true;
}
