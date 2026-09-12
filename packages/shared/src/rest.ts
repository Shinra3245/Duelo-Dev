/**
 * Contratos tipados de Request y Response para la API REST `/api/v1` (doc 04 §2).
 *
 * FRONTERA DE TIPOS Y RUNTIME:
 * TypeScript modela los esquemas en tiempo de compilación. Las validaciones de entrada
 * en la API utilizan JSON Schema (Fastify) y validación de tipos antes de procesar la solicitud.
 */
import type { Language } from './limits.js';
import type { Verdict } from './verdicts.js';
import type {
  GameModeName,
  MatchConfig,
  MatchFinishReason,
  MatchStatus,
  PlayerScore,
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

export type UserRole = 'user' | 'guest';

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

export type SubmissionStatus = 'queued' | 'judging' | 'completed';

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
