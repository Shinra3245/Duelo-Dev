import type {
  Language,
  MatchCodeSnapshotEntity,
  MatchEntity,
  MatchPlayerEntity,
  MatchStatus,
  ProblemCategory,
  ProblemEntity,
  RefreshTokenEntity,
  SubmissionEntity,
  TestCaseEntity,
  UserEntity,
  UserRole,
  Verdict,
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
  findAll?(limit?: number, offset?: number): Promise<UserEntity[]>;
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
  instructions_ends_at?: string | null;
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

export type JoinLobbyResult =
  | { status: 'joined' | 'existing'; match: MatchEntity; player: MatchPlayerEntity }
  | { status: 'not_lobby' }
  | { status: 'full' };

export interface RoomRepository {
  createMatch(input: CreateMatchInput): Promise<MatchEntity>;
  findMatchById(id: string): Promise<MatchEntity | null>;
  findMatchByRoomCode(roomCode: string): Promise<MatchEntity | null>;
  deleteMatch?(id: string): Promise<boolean>;
  findAllMatches?(options?: {
    limit?: number;
    offset?: number;
    status?: MatchStatus;
  }): Promise<MatchEntity[]>;
  updateMatch(
    id: string,
    input: Partial<
      Pick<
        MatchEntity,
        | 'status'
        | 'started_at'
        | 'instructions_ends_at'
        | 'ends_at'
        | 'finished_at'
        | 'winner_id'
        | 'winner_ids'
        | 'finish_reason'
        | 'host_id'
        | 'state_version'
        | 'admission_seq'
      >
    >,
  ): Promise<MatchEntity | null>;
  addPlayer(input: CreateMatchPlayerInput): Promise<MatchPlayerEntity>;
  /** Inserta un jugador con el lobby bloqueado y asigna host al primer miembro de sala vacía. */
  joinLobby(input: CreateMatchPlayerInput, maxPlayers: number): Promise<JoinLobbyResult>;
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
  countActiveRooms?(): Promise<number>;
  allocateNextAdmissionSeq?(matchId: string): Promise<number>;
}

export interface RoomCreationPolicyRepository {
  getRegisteredUsersCanCreateRooms(): Promise<boolean>;
  setRegisteredUsersCanCreateRooms(enabled: boolean): Promise<void>;
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

export interface SubmissionWithLeaseEntity extends SubmissionEntity {
  attempt_token?: string | null;
  worker_id?: string | null;
  lease_until?: string | null;
}

export type ClaimStatus = 'acquired' | 'completed' | 'busy';

export interface ClaimResult {
  status: ClaimStatus;
  attempt_token?: string | null;
}

export type PersistStatus = 'stored' | 'completed' | 'fenced';

export interface PersistSubmissionResultInput {
  submission_id: string;
  verdict: Verdict;
  passed_cases: number;
  total_cases: number;
  exec_time_ms: number;
  compile_output?: string | null;
  judge_error?: string | null;
  judged_at?: string | null;
}

export interface SubmissionRepository {
  createSubmission(input: CreateSubmissionInput): Promise<SubmissionEntity>;
  /** Crea el envío solo si el jugador sigue activo; null significa inexistente o ya abandonó. */
  createSubmissionForActivePlayer(input: CreateSubmissionInput): Promise<SubmissionEntity | null>;
  findSubmissionById(id: string): Promise<SubmissionEntity | null>;
  findSubmissionsByMatch(matchId: string): Promise<SubmissionEntity[]>;
  findSubmissionsByUser(matchId: string, userId: string): Promise<SubmissionEntity[]>;
  findPendingSubmissions(limit?: number): Promise<SubmissionEntity[]>;
  updateSubmission(id: string, input: Partial<SubmissionEntity>): Promise<SubmissionEntity | null>;
  claimSubmission?(
    submissionId: string,
    workerId: string,
    leaseDurationMs?: number,
    nowIso?: string,
  ): Promise<ClaimResult>;
  persistIfCurrent?(
    result: PersistSubmissionResultInput,
    attemptToken: string,
  ): Promise<PersistStatus>;
}

export interface ProblemRepository {
  findProblemById(id: string): Promise<ProblemEntity | null>;
  findProblemByContentHash?(contentHash: string): Promise<ProblemEntity | null>;
  findAllProblems?(limit?: number): Promise<ProblemEntity[]>;
  countProblemsByCategories(
    categories: readonly ProblemCategory[],
  ): Promise<Partial<Record<ProblemCategory, number>>>;
  findTestCasesByProblemId(problemId: string): Promise<TestCaseEntity[]>;
  createProblem(problem: ProblemEntity): Promise<ProblemEntity>;
  createTestCase(testCase: TestCaseEntity): Promise<TestCaseEntity>;
}

export interface EventEntity {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_name: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface CreateEventInput {
  id?: string;
  aggregate_type: string;
  aggregate_id: string;
  event_name: string;
  payload: Record<string, unknown>;
  created_at?: string;
}

export interface EventRepository {
  recordEvent(input: CreateEventInput): Promise<EventEntity>;
  findEventsByAggregate(aggregateType: string, aggregateId: string): Promise<EventEntity[]>;
  findEventsByName(eventName: string, limit?: number): Promise<EventEntity[]>;
  countEvents(eventName?: string): Promise<number>;
}

export interface RejectedMessageEntity {
  message_id: string;
  reason: string;
  rejected_at: string;
}

export interface RejectedMessageRepository {
  /**
   * Registra un mensaje rechazado de forma durable e idempotente.
   * Retorna true si el mensaje quedó persistido (sea nuevo o preexistente),
   * permitiendo al consumidor del juez realizar XACK de forma segura en Redis.
   */
  recordRejected(messageId: string, reason: string): Promise<boolean>;
  findRejectedMessageById(messageId: string): Promise<RejectedMessageEntity | null>;
  countRejectedMessages(): Promise<number>;
}
