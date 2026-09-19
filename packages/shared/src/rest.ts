/**
 * Contratos tipados de Request y Response para la API REST `/api/v1` (doc 04 §2).
 *
 * FRONTERA DE TIPOS Y RUNTIME:
 * TypeScript modela los esquemas en tiempo de compilación. Las validaciones de entrada
 * en la API utilizan JSON Schema (Fastify) y validación de tipos antes de procesar la solicitud.
 * Este módulo incluye guardias de tipo reusables para validar invariantes estáticos
 * de peticiones y respuestas.
 */
import { type Language, SOURCE_CODE_MAX_BYTES, isLanguage } from './limits.js';
import { type Verdict, isVerdict } from './verdicts.js';
import {
  type GameModeName,
  type MatchConfig,
  type MatchFinishReason,
  type MatchStatus,
  type PlayerScore,
  MAX_COMPILE_OUTPUT_BYTES,
} from './events.js';

/** Expresión regular canónica para validación de gamertag (doc 04 §2). */
export const GAMERTAG_REGEX = /^[A-Za-z0-9-]{3,20}$/;

export function isValidGamertag(gamertag: string): boolean {
  return typeof gamertag === 'string' && GAMERTAG_REGEX.test(gamertag);
}

/** Nombre del encabezado para operaciones idempotentes y su ventana en segundos. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_WINDOW_S = 60;

// ────────────────────────────────── Auth ──────────────────────────────────

export const USER_ROLES = ['user', 'guest', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

export interface UserProfile {
  id: string;
  email: string | null;
  gamertag: string;
  role: UserRole;
  created_at: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  gamertag: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthUserResponse {
  user: UserProfile;
}

export interface ConvertGuestRequest {
  email: string;
  password: string;
}

export interface LogoutResponse {
  ok: boolean;
}

// ───────────────────────────────── Salas ──────────────────────────────────

export interface CreateRoomRequest {
  config: MatchConfig;
}

export interface RoomCreatedResponse {
  match_id: string;
  room_code: string;
  share_url: string;
  config: MatchConfig;
  created_at: string;
}

export interface JoinRoomRequest {
  gamertag: string;
}

export interface JoinRoomResponse {
  match_id: string;
  user_id: string;
  gamertag: string;
  role: 'host' | 'player';
  room_code: string;
}

export interface RoomPlayerSummary {
  user_id: string;
  gamertag: string;
  is_ready: boolean;
  is_host: boolean;
}

export interface RoomDetailsResponse {
  match_id: string;
  room_code: string;
  status: MatchStatus;
  config: MatchConfig;
  host_id: string;
  players: RoomPlayerSummary[];
  created_at: string;
}

export interface StartRoomResponse {
  match_id: string;
  started: boolean;
  status: MatchStatus;
}

// ──────────────────────────────── Envíos ──────────────────────────────────

export const SUBMISSION_STATUSES = ['queued', 'judging', 'completed'] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export function isSubmissionStatus(value: unknown): value is SubmissionStatus {
  return typeof value === 'string' && (SUBMISSION_STATUSES as readonly string[]).includes(value);
}

export interface CreateSubmissionRequest {
  match_id: string;
  round_id: string;
  problem_id: string;
  language: Language;
  source_code: string;
}

export interface SubmissionAcceptedResponse {
  submission_id: string;
  match_id: string;
  round_id: string;
  problem_id: string;
  admission_seq: number;
  received_at: number;
  status: 'queued';
}

export interface SubmissionDetailsResponse {
  submission_id: string;
  match_id: string;
  round_id: string;
  problem_id: string;
  language: Language;
  status: SubmissionStatus;
  verdict: Verdict | null;
  passed: number | null;
  total: number | null;
  exec_time_ms: number | null;
  /** Máximo 4 KiB; solo visible por el dueño del envío (doc 04 §2). */
  compile_output?: string;
  received_at: number;
  judged_at?: number | null;
}

// ─────────────────────────────── Problemas ────────────────────────────────

export interface ProblemExample {
  input: string;
  output: string;
  explanation?: string;
}

export interface ProblemPublicResponse {
  problem_id: string;
  title: string;
  description: string;
  time_limit_ms: number;
  memory_limit_mb: number;
  examples: ProblemExample[];
}

// ────────────────────────── Resumen de partida ────────────────────────────

export interface MatchCodeSnapshot {
  user_id: string;
  round_id: string;
  problem_id: string;
  language: Language;
  source_code: string;
  captured_at: string;
}

export interface MatchSummaryResponse {
  match_id: string;
  mode: GameModeName;
  status: MatchStatus;
  finish_reason: MatchFinishReason;
  winner_ids: string[];
  final_scores: PlayerScore[];
  started_at: string;
  finished_at: string;
  snapshots: MatchCodeSnapshot[];
}

// ─────────────────────────────── Administración ───────────────────────────────

export interface AdminPlayerSummary {
  user_id: string;
  gamertag: string;
  email: string | null;
  score: number;
  cases_total: number;
  time_total_ms: number;
  connection_status: string;
  is_ready: boolean;
  is_revealed: boolean;
}

export interface AdminRoomSummary {
  match_id: string;
  room_code: string;
  mode: GameModeName;
  status: MatchStatus;
  config: MatchConfig;
  host_id: string;
  winner_ids: string[];
  winner_id: string | null;
  finish_reason: MatchFinishReason | null;
  started_at: string | null;
  ends_at: string | null;
  finished_at: string | null;
  created_at: string;
  players: AdminPlayerSummary[];
}

export interface AdminRoomsResponse {
  rooms: AdminRoomSummary[];
  limit: number;
  offset: number;
}

export interface AdminPlayersResponse {
  players: Array<AdminPlayerSummary & { match_id: string; room_code: string }>;
  limit: number;
  offset: number;
}

export interface AdminRankingEntry {
  rank: number;
  user_id: string;
  gamertag: string;
  matches_played: number;
  wins: number;
  score: number;
  cases_total: number;
  time_total_ms: number;
}

export interface AdminRankingResponse {
  ranking: AdminRankingEntry[];
}

export interface AdminManualResultRequest {
  winner_ids: string[];
}

export interface AdminManualResultResponse {
  room: AdminRoomSummary;
  audited: boolean;
}

export interface AdminCloseRoomResponse {
  room: AdminRoomSummary;
  closed: boolean;
  audited: boolean;
}

export interface AdminCloseRoomsResponse {
  rooms: AdminRoomSummary[];
  closed_count: number;
  audited: boolean;
}

export interface AdminDeleteRoomResponse {
  match_id: string;
  room_code: string;
  deleted: boolean;
  audited: boolean;
}

export interface AdminDeleteRoomsResponse {
  match_ids: string[];
  deleted_count: number;
  audited: boolean;
}

export interface RoomCreationPolicyResponse {
  registered_users_can_create_rooms: boolean;
}

// ────────────────────── Guardias de invariantes REST ──────────────────────

export function isCreateSubmissionRequest(value: unknown): value is CreateSubmissionRequest {
  if (typeof value !== 'object' || value === null) return false;
  const req = value as Record<string, unknown>;
  return (
    typeof req.match_id === 'string' &&
    req.match_id.length > 0 &&
    typeof req.round_id === 'string' &&
    req.round_id.length > 0 &&
    typeof req.problem_id === 'string' &&
    req.problem_id.length > 0 &&
    isLanguage(req.language) &&
    typeof req.source_code === 'string' &&
    req.source_code.length <= SOURCE_CODE_MAX_BYTES
  );
}

export function isSubmissionAcceptedResponse(value: unknown): value is SubmissionAcceptedResponse {
  if (typeof value !== 'object' || value === null) return false;
  const res = value as Record<string, unknown>;
  return (
    typeof res.submission_id === 'string' &&
    res.submission_id.length > 0 &&
    typeof res.match_id === 'string' &&
    res.match_id.length > 0 &&
    typeof res.round_id === 'string' &&
    res.round_id.length > 0 &&
    typeof res.problem_id === 'string' &&
    res.problem_id.length > 0 &&
    typeof res.admission_seq === 'number' &&
    Number.isInteger(res.admission_seq) &&
    res.admission_seq >= 1 &&
    typeof res.received_at === 'number' &&
    Number.isFinite(res.received_at) &&
    res.received_at > 0 &&
    res.status === 'queued'
  );
}

export function isSubmissionDetailsResponse(value: unknown): value is SubmissionDetailsResponse {
  if (typeof value !== 'object' || value === null) return false;
  const res = value as Record<string, unknown>;

  if (
    typeof res.submission_id !== 'string' ||
    res.submission_id.length === 0 ||
    typeof res.match_id !== 'string' ||
    res.match_id.length === 0 ||
    typeof res.round_id !== 'string' ||
    res.round_id.length === 0 ||
    typeof res.problem_id !== 'string' ||
    res.problem_id.length === 0 ||
    !isLanguage(res.language) ||
    !isSubmissionStatus(res.status) ||
    (res.verdict !== null && !isVerdict(res.verdict)) ||
    (res.passed !== null &&
      (typeof res.passed !== 'number' || !Number.isInteger(res.passed) || res.passed < 0)) ||
    (res.total !== null &&
      (typeof res.total !== 'number' || !Number.isInteger(res.total) || res.total < 0)) ||
    (res.exec_time_ms !== null &&
      (typeof res.exec_time_ms !== 'number' ||
        !Number.isFinite(res.exec_time_ms) ||
        res.exec_time_ms < 0)) ||
    typeof res.received_at !== 'number' ||
    !Number.isFinite(res.received_at) ||
    res.received_at <= 0
  ) {
    return false;
  }

  // Invariante: passed <= total cuando ambos están informados
  if (typeof res.passed === 'number' && typeof res.total === 'number' && res.passed > res.total) {
    return false;
  }

  // Invariante de compile_output: máximo 4 KiB
  if (
    res.compile_output !== undefined &&
    (typeof res.compile_output !== 'string' || res.compile_output.length > MAX_COMPILE_OUTPUT_BYTES)
  ) {
    return false;
  }

  // Invariante de judged_at si está informado
  if (
    res.judged_at !== undefined &&
    res.judged_at !== null &&
    (typeof res.judged_at !== 'number' || !Number.isFinite(res.judged_at) || res.judged_at <= 0)
  ) {
    return false;
  }

  return true;
}
