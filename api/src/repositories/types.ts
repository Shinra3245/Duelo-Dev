import type {
  Language,
  MatchCodeSnapshotEntity,
  MatchEntity,
  MatchPlayerEntity,
  ProblemEntity,
  RefreshTokenEntity,
  SubmissionEntity,
  TestCaseEntity,
  UserEntity,
  UserRole,
} from '@duelodev/shared';

export interface CreateUserInput {
  id?: string;
  email?: string | null;
  password_hash?: string | null;
  gamertag: string;
  role: UserRole;
  created_at?: string;
  updated_at?: string;
}

export interface UpdateUserInput {
  email?: string | null;
  password_hash?: string | null;
  gamertag?: string;
  role?: UserRole;
  updated_at?: string;
}

export interface UserRepository {
  findById(id: string): Promise<UserEntity | null>;
  findByEmail(email: string): Promise<UserEntity | null>;
  findByGamertag(gamertag: string): Promise<UserEntity | null>;
  create(input: CreateUserInput): Promise<UserEntity>;
  update(id: string, input: UpdateUserInput): Promise<UserEntity | null>;
  count(): Promise<number>;
  findInactiveGuests?(olderThanIso: string): Promise<UserEntity[]>;
  anonymizeGuest?(
    id: string,
    tombstoneGamertag: string,
    updatedAtIso?: string,
  ): Promise<UserEntity | null>;
}

export interface CreateRefreshTokenInput {
  id?: string;
  user_id: string;
  token_hash: string;
  family_id: string;
  expires_at: string;
  revoked?: boolean;
  created_at?: string;
}

export interface RefreshTokenRepository {
  create(input: CreateRefreshTokenInput): Promise<RefreshTokenEntity>;
  findByTokenHash(tokenHash: string): Promise<RefreshTokenEntity | null>;
  revoke(id: string): Promise<void>;
  revokeFamily(userId: string, familyId: string): Promise<number>;
  deleteExpired(nowIso?: string): Promise<number>;
  revokeAllForUser?(userId: string): Promise<number>;
}

export interface CreateMatchInput {
  id?: string;
  room_code: string;
  mode: 'puntos' | 'rondas';
  status?: 'lobby' | 'running' | 'settling' | 'finished' | 'abandoned';
  config: MatchEntity['config'];
  host_id: string;
  state_version?: number;
  admission_seq?: number;
  winner_ids?: string[];
  winner_id?: string | null;
  finish_reason?: MatchEntity['finish_reason'];
  started_at?: string | null;
  ends_at?: string | null;
  finished_at?: string | null;
  created_at?: string;
}

export interface CreateMatchPlayerInput {
  id?: string;
  match_id: string;
  user_id: string;
  score?: number;
  cases_total?: number;
  time_total_ms?: number;
  current_problem_idx?: number;
  is_ready?: boolean;
  is_revealed?: boolean;
  connection_status?: MatchPlayerEntity['connection_status'];
  joined_at?: string;
  left_at?: string | null;
}

export interface RoomRepository {
  createMatch(input: CreateMatchInput): Promise<MatchEntity>;
  findMatchById(id: string): Promise<MatchEntity | null>;
  findMatchByRoomCode(roomCode: string): Promise<MatchEntity | null>;
  updateMatch(
    id: string,
    input: Partial<
      Pick<
        MatchEntity,
        | 'status'
        | 'started_at'
        | 'ends_at'
        | 'finished_at'
        | 'winner_id'
        | 'winner_ids'
        | 'finish_reason'
        | 'state_version'
        | 'admission_seq'
      >
    >,
  ): Promise<MatchEntity | null>;
  addPlayer(input: CreateMatchPlayerInput): Promise<MatchPlayerEntity>;
  findPlayersByMatchId(matchId: string): Promise<MatchPlayerEntity[]>;
  findPlayer(matchId: string, userId: string): Promise<MatchPlayerEntity | null>;
  updatePlayer(
    id: string,
    input: Partial<
      Pick<
        MatchPlayerEntity,
        | 'score'
        | 'cases_total'
        | 'time_total_ms'
        | 'current_problem_idx'
        | 'is_ready'
        | 'is_revealed'
        | 'connection_status'
        | 'left_at'
      >
    >,
  ): Promise<MatchPlayerEntity | null>;
  saveSnapshot(input: CreateMatchCodeSnapshotInput): Promise<MatchCodeSnapshotEntity>;
  findSnapshotsByMatch(matchId: string): Promise<MatchCodeSnapshotEntity[]>;
  deleteSnapshotsByUser?(userId: string, onlyUnrevealed?: boolean): Promise<number>;
}

export interface CreateMatchCodeSnapshotInput {
  id?: string;
  match_id: string;
  round_id: string;
  user_id: string;
  problem_id: string;
  language: Language;
  source_code: string;
  version?: number;
  captured_at?: string;
}

export interface CreateSubmissionInput {
  id?: string;
  match_id: string;
  round_id: string;
  user_id: string;
  problem_id: string;
  language: SubmissionEntity['language'];
  source_code: string;
  time_limit_ms: number;
  memory_limit_mb: number;
  received_at?: string;
  admission_seq: number;
  status?: SubmissionEntity['status'];
  verdict?: SubmissionEntity['verdict'];
  passed_cases?: number | null;
  total_cases?: number | null;
  exec_time_ms?: number | null;
  compile_output?: string | null;
  judge_error?: string | null;
  judged_at?: string | null;
}

export interface SubmissionRepository {
  createSubmission(input: CreateSubmissionInput): Promise<SubmissionEntity>;
  findSubmissionById(id: string): Promise<SubmissionEntity | null>;
  findSubmissionsByMatch(matchId: string): Promise<SubmissionEntity[]>;
  findSubmissionsByUser(matchId: string, userId: string): Promise<SubmissionEntity[]>;
  findPendingSubmissions(limit?: number): Promise<SubmissionEntity[]>;
  updateSubmission(id: string, input: Partial<SubmissionEntity>): Promise<SubmissionEntity | null>;
}

export interface ProblemRepository {
  findProblemById(id: string): Promise<ProblemEntity | null>;
  findProblemByContentHash?(contentHash: string): Promise<ProblemEntity | null>;
  findAllProblems?(limit?: number): Promise<ProblemEntity[]>;
  findTestCasesByProblemId(problemId: string): Promise<TestCaseEntity[]>;
  createProblem(problem: ProblemEntity): Promise<ProblemEntity>;
  createTestCase(testCase: TestCaseEntity): Promise<TestCaseEntity>;
}
