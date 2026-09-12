/**
 * Contratos de entidades del modelo de datos durable en PostgreSQL (doc 04 §1).
 *
 * Convenciones:
 * - UUID para identificadores de entidad pública.
 * - TIMESTAMPTZ mapeado a ISO string (`string`).
 * - Enums estrictos coincidentes con los CHECK constraints de SQL.
 */
import type { Language } from './limits.js';
import type { Verdict } from './verdicts.js';
import type {
  GameModeName,
  MatchConfig,
  MatchFinishReason,
  MatchStatus,
  PlayerConnection,
  ProblemCategory,
  RoundStatus,
} from './events.js';
import type { SubmissionStatus, UserRole } from './rest.js';

export interface UserEntity {
  id: string;
  email: string | null;
  password_hash: string | null;
  gamertag: string;
  role: UserRole;
  created_at: string;
  updated_at: string;
}

export interface RefreshTokenEntity {
  id: string;
  user_id: string;
  token_hash: string;
  family_id: string;
  expires_at: string;
  revoked: boolean;
  created_at: string;
}

export interface ProblemEntity {
  id: string;
  title: string;
  description: string;
  category: ProblemCategory;
  time_limit_ms: number;
  memory_limit_mb: number;
  version: number;
  content_hash: string;
  created_at: string;
}

export interface TestCaseEntity {
  id: string;
  problem_id: string;
  ordinal: number;
  input: string;
  expected_output: string;
  is_example: boolean;
  created_at: string;
}

export interface MatchEntity {
  id: string;
  room_code: string;
  mode: GameModeName;
  status: MatchStatus;
  config: MatchConfig;
  host_id: string;
  state_version: number;
  admission_seq: number;
  winner_ids: string[];
  winner_id: string | null;
  finish_reason: MatchFinishReason | null;
  started_at: string | null;
  ends_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface MatchPlayerEntity {
  id: string;
  match_id: string;
  user_id: string;
  score: number;
  cases_total: number;
  time_total_ms: number;
  current_problem_idx: number;
  is_ready: boolean;
  is_revealed: boolean;
  connection_status: PlayerConnection;
  joined_at: string;
  left_at: string | null;
}

export interface MatchRoundEntity {
  id: string;
  match_id: string;
  round_id: string;
  user_id: string | null;
  problem_id: string;
  problem_version: number;
  status: RoundStatus;
  opened_at: string;
  cutoff_at: string | null;
  closed_at: string | null;
  winner_id: string | null;
  created_at: string;
}

export interface SubmissionEntity {
  id: string;
  match_id: string;
  round_id: string;
  user_id: string;
  problem_id: string;
  language: Language;
  source_code: string;
  time_limit_ms: number;
  memory_limit_mb: number;
  received_at: string;
  admission_seq: number;
  status: SubmissionStatus;
  verdict: Verdict | null;
  passed_cases: number | null;
  total_cases: number | null;
  exec_time_ms: number | null;
  compile_output: string | null;
  judge_error: string | null;
  judged_at: string | null;
}

export interface MatchSolveEntity {
  id: string;
  match_id: string;
  user_id: string;
  round_id: string;
  submission_id: string;
  solve_elapsed_ms: number;
  created_at: string;
}

export interface MatchRoundResultEntity {
  id: string;
  match_id: string;
  round_id: string;
  winner_id: string | null;
  winning_submission_id: string | null;
  resolved_at: string;
}

export interface MatchProcessedSubmissionEntity {
  id: string;
  match_id: string;
  submission_id: string;
  processed_at: string;
}

export interface MatchCodeSnapshotEntity {
  id: string;
  match_id: string;
  round_id: string;
  user_id: string;
  problem_id: string;
  language: Language;
  source_code: string;
  version: number;
  captured_at: string;
}
