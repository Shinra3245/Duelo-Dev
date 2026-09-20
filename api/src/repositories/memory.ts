import { randomUUID } from 'node:crypto';
import type {
  MatchCodeSnapshotEntity,
  MatchEntity,
  MatchPlayerEntity,
  ProblemCategory,
  ProblemEntity,
  RefreshTokenEntity,
  SubmissionEntity,
  TestCaseEntity,
  UserEntity,
} from '@duelodev/shared';
import type {
  ClaimResult,
  CreateEventInput,
  CreateMatchCodeSnapshotInput,
  CreateMatchInput,
  CreateMatchPlayerInput,
  CreateRefreshTokenInput,
  CreateSubmissionInput,
  CreateUserInput,
  EventEntity,
  EventRepository,
  PersistStatus,
  PersistSubmissionResultInput,
  ProblemRepository,
  RefreshTokenRepository,
  RejectedMessageEntity,
  RejectedMessageRepository,
  RoomRepository,
  RoomCreationPolicyRepository,
  SubmissionRepository,
  SubmissionWithLeaseEntity,
  UpdateUserInput,
  UserRepository,
} from './types.js';

export class InMemoryRoomCreationPolicyRepository implements RoomCreationPolicyRepository {
  private enabled = true;

  async getRegisteredUsersCanCreateRooms(): Promise<boolean> {
    return this.enabled;
  }

  async setRegisteredUsersCanCreateRooms(enabled: boolean): Promise<void> {
    this.enabled = enabled;
  }
}

/**
 * Repositorio de usuarios en memoria para pruebas e inicialización sin base de datos viva.
 */
export class InMemoryUserRepository implements UserRepository {
  private readonly users = new Map<string, UserEntity>();

  async findById(id: string): Promise<UserEntity | null> {
    const user = this.users.get(id);
    return user ? { ...user } : null;
  }

  async findByEmail(email: string): Promise<UserEntity | null> {
    const normalized = email.trim().toLowerCase();
    for (const user of this.users.values()) {
      if (user.email && user.email.toLowerCase() === normalized) {
        return { ...user };
      }
    }
    return null;
  }

  async findByGamertag(gamertag: string): Promise<UserEntity | null> {
    const normalized = gamertag.trim().toLowerCase();
    for (const user of this.users.values()) {
      if (user.gamertag.toLowerCase() === normalized) {
        return { ...user };
      }
    }
    return null;
  }

  async findAll(limit = 100, offset = 0): Promise<UserEntity[]> {
    return [...this.users.values()]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(offset, offset + limit)
      .map((user) => ({ ...user }));
  }

  async create(input: CreateUserInput): Promise<UserEntity> {
    const now = new Date().toISOString();
    const user: UserEntity = {
      id: input.id ?? randomUUID(),
      email: input.email ? input.email.trim().toLowerCase() : null,
      password_hash: input.password_hash ?? null,
      gamertag: input.gamertag.trim(),
      role: input.role,
      created_at: input.created_at ?? now,
      updated_at: input.updated_at ?? now,
    };

    this.users.set(user.id, user);
    return { ...user };
  }

  async update(id: string, input: UpdateUserInput): Promise<UserEntity | null> {
    const existing = this.users.get(id);
    if (!existing) {
      return null;
    }

    const updated: UserEntity = {
      ...existing,
      ...(input.email !== undefined
        ? { email: input.email ? input.email.trim().toLowerCase() : null }
        : {}),
      ...(input.password_hash !== undefined ? { password_hash: input.password_hash } : {}),
      ...(input.gamertag !== undefined ? { gamertag: input.gamertag.trim() } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      updated_at: input.updated_at ?? new Date().toISOString(),
    };

    this.users.set(id, updated);
    return { ...updated };
  }

  async count(): Promise<number> {
    return this.users.size;
  }

  async findInactiveGuests(olderThanIso: string): Promise<UserEntity[]> {
    const threshold = new Date(olderThanIso).getTime();
    const result: UserEntity[] = [];
    for (const user of this.users.values()) {
      if (user.role === 'guest' && new Date(user.updated_at).getTime() <= threshold) {
        result.push({ ...user });
      }
    }
    return result;
  }

  async anonymizeGuest(
    id: string,
    tombstoneGamertag: string,
    updatedAtIso?: string,
  ): Promise<UserEntity | null> {
    const existing = this.users.get(id);
    if (!existing) {
      return null;
    }

    const updated: UserEntity = {
      ...existing,
      gamertag: tombstoneGamertag.trim(),
      email: null,
      password_hash: null,
      updated_at: updatedAtIso ?? new Date().toISOString(),
    };

    this.users.set(id, updated);
    return { ...updated };
  }

  /** Limpia todos los registros (útil entre pruebas). */
  clear(): void {
    this.users.clear();
  }
}

/**
 * Repositorio de refresh tokens en memoria con soporte de rotación y detección de reuso familiar.
 */
export class InMemoryRefreshTokenRepository implements RefreshTokenRepository {
  private readonly tokens = new Map<string, RefreshTokenEntity>();
  private readonly tokenHashToId = new Map<string, string>();

  async create(input: CreateRefreshTokenInput): Promise<RefreshTokenEntity> {
    const now = new Date().toISOString();
    const token: RefreshTokenEntity = {
      id: input.id ?? randomUUID(),
      user_id: input.user_id,
      token_hash: input.token_hash,
      family_id: input.family_id,
      expires_at: input.expires_at,
      revoked: input.revoked ?? false,
      created_at: input.created_at ?? now,
    };

    this.tokens.set(token.id, token);
    this.tokenHashToId.set(token.token_hash, token.id);
    return { ...token };
  }

  async findByTokenHash(tokenHash: string): Promise<RefreshTokenEntity | null> {
    const id = this.tokenHashToId.get(tokenHash);
    if (!id) {
      return null;
    }
    const token = this.tokens.get(id);
    return token ? { ...token } : null;
  }

  async revoke(id: string): Promise<void> {
    const token = this.tokens.get(id);
    if (token) {
      token.revoked = true;
    }
  }

  async revokeFamily(userId: string, familyId: string): Promise<number> {
    let count = 0;
    for (const token of this.tokens.values()) {
      if (token.user_id === userId && token.family_id === familyId) {
        if (!token.revoked) {
          token.revoked = true;
          count++;
        }
      }
    }
    return count;
  }

  async deleteExpired(nowIso?: string): Promise<number> {
    const reference = nowIso ? new Date(nowIso).getTime() : Date.now();
    let deleted = 0;

    for (const [id, token] of this.tokens.entries()) {
      if (new Date(token.expires_at).getTime() <= reference) {
        this.tokenHashToId.delete(token.token_hash);
        this.tokens.delete(id);
        deleted++;
      }
    }

    return deleted;
  }

  async revokeAllForUser(userId: string): Promise<number> {
    let count = 0;
    for (const token of this.tokens.values()) {
      if (token.user_id === userId && !token.revoked) {
        token.revoked = true;
        count++;
      }
    }
    return count;
  }

  /** Limpia todos los tokens (útil entre pruebas). */
  clear(): void {
    this.tokens.clear();
    this.tokenHashToId.clear();
  }
}

/**
 * Repositorio de salas y jugadores de partida en memoria (doc 04 §2).
 */
export class InMemoryRoomRepository implements RoomRepository {
  private readonly matches = new Map<string, MatchEntity>();
  private readonly roomCodeToId = new Map<string, string>();
  private readonly players = new Map<string, MatchPlayerEntity[]>();
  private readonly snapshots = new Map<string, MatchCodeSnapshotEntity[]>();

  async createMatch(input: CreateMatchInput): Promise<MatchEntity> {
    const now = new Date().toISOString();
    const match: MatchEntity = {
      id: input.id ?? randomUUID(),
      room_code: input.room_code.trim().toUpperCase(),
      mode: input.mode,
      status: input.status ?? 'lobby',
      config: input.config,
      host_id: input.host_id,
      state_version: input.state_version ?? 1,
      admission_seq: input.admission_seq ?? 0,
      winner_ids: input.winner_ids ?? [],
      winner_id: input.winner_id ?? null,
      finish_reason: input.finish_reason ?? null,
      started_at: input.started_at ?? null,
      instructions_ends_at: input.instructions_ends_at ?? null,
      ends_at: input.ends_at ?? null,
      finished_at: input.finished_at ?? null,
      created_at: input.created_at ?? now,
    };

    this.matches.set(match.id, match);
    this.roomCodeToId.set(match.room_code, match.id);
    this.players.set(match.id, []);
    return { ...match };
  }

  async findMatchById(id: string): Promise<MatchEntity | null> {
    const match = this.matches.get(id);
    return match ? { ...match } : null;
  }

  async deleteMatch(id: string): Promise<boolean> {
    const match = this.matches.get(id);
    if (!match) return false;
    this.matches.delete(id);
    this.roomCodeToId.delete(match.room_code);
    this.players.delete(id);
    this.snapshots.delete(id);
    return true;
  }

  async findMatchByRoomCode(roomCode: string): Promise<MatchEntity | null> {
    const id = this.roomCodeToId.get(roomCode.trim().toUpperCase());
    if (!id) return null;
    const match = this.matches.get(id);
    return match ? { ...match } : null;
  }

  async findAllMatches(
    options: {
      limit?: number;
      offset?: number;
      status?: MatchEntity['status'];
    } = {},
  ): Promise<MatchEntity[]> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    return [...this.matches.values()]
      .filter((match) => options.status === undefined || match.status === options.status)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(offset, offset + limit)
      .map((match) => ({ ...match }));
  }

  async updateMatch(
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
  ): Promise<MatchEntity | null> {
    const existing = this.matches.get(id);
    if (!existing) return null;

    const updated: MatchEntity = {
      ...existing,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.started_at !== undefined ? { started_at: input.started_at } : {}),
      ...(input.instructions_ends_at !== undefined
        ? { instructions_ends_at: input.instructions_ends_at }
        : {}),
      ...(input.ends_at !== undefined ? { ends_at: input.ends_at } : {}),
      ...(input.finished_at !== undefined ? { finished_at: input.finished_at } : {}),
      ...(input.winner_id !== undefined ? { winner_id: input.winner_id } : {}),
      ...(input.winner_ids !== undefined ? { winner_ids: input.winner_ids } : {}),
      ...(input.finish_reason !== undefined ? { finish_reason: input.finish_reason } : {}),
      ...(input.host_id !== undefined ? { host_id: input.host_id } : {}),
      ...(input.state_version !== undefined ? { state_version: input.state_version } : {}),
      ...(input.admission_seq !== undefined ? { admission_seq: input.admission_seq } : {}),
    };

    this.matches.set(id, updated);
    return { ...updated };
  }

  async addPlayer(input: CreateMatchPlayerInput): Promise<MatchPlayerEntity> {
    const now = new Date().toISOString();
    const player: MatchPlayerEntity = {
      id: input.id ?? randomUUID(),
      match_id: input.match_id,
      user_id: input.user_id,
      score: input.score ?? 0,
      cases_total: input.cases_total ?? 0,
      time_total_ms: input.time_total_ms ?? 0,
      current_problem_idx: input.current_problem_idx ?? 0,
      is_ready: input.is_ready ?? true,
      is_revealed: input.is_revealed ?? false,
      connection_status: input.connection_status ?? 'connected',
      joined_at: input.joined_at ?? now,
      left_at: input.left_at ?? null,
    };

    const matchPlayers = this.players.get(input.match_id) ?? [];
    matchPlayers.push(player);
    this.players.set(input.match_id, matchPlayers);

    return { ...player };
  }

  async joinLobby(input: CreateMatchPlayerInput, maxPlayers: number) {
    const match = this.matches.get(input.match_id);
    if (!match || match.status !== 'lobby') return { status: 'not_lobby' as const };

    const matchPlayers = this.players.get(input.match_id) ?? [];
    const existing = matchPlayers.find((player) => player.user_id === input.user_id);
    if (existing)
      return { status: 'existing' as const, match: { ...match }, player: { ...existing } };
    if (matchPlayers.filter((player) => player.connection_status !== 'left').length >= maxPlayers) {
      return { status: 'full' as const };
    }

    if (matchPlayers.length === 0 && match.host_id !== input.user_id) {
      this.matches.set(match.id, { ...match, host_id: input.user_id });
    }

    const player = await this.addPlayer(input);
    return {
      status: 'joined' as const,
      match: { ...this.matches.get(match.id)! },
      player,
    };
  }

  async findPlayersByMatchId(matchId: string): Promise<MatchPlayerEntity[]> {
    const matchPlayers = this.players.get(matchId) ?? [];
    return matchPlayers.map((p) => ({ ...p }));
  }

  async findPlayer(matchId: string, userId: string): Promise<MatchPlayerEntity | null> {
    const matchPlayers = this.players.get(matchId) ?? [];
    const player = matchPlayers.find((p) => p.user_id === userId);
    return player ? { ...player } : null;
  }

  async updatePlayer(
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
  ): Promise<MatchPlayerEntity | null> {
    for (const matchPlayers of this.players.values()) {
      const idx = matchPlayers.findIndex((p) => p.id === id);
      if (idx >= 0) {
        const existing = matchPlayers[idx]!;
        const updated: MatchPlayerEntity = {
          ...existing,
          ...(input.score !== undefined ? { score: input.score } : {}),
          ...(input.cases_total !== undefined ? { cases_total: input.cases_total } : {}),
          ...(input.time_total_ms !== undefined ? { time_total_ms: input.time_total_ms } : {}),
          ...(input.current_problem_idx !== undefined
            ? { current_problem_idx: input.current_problem_idx }
            : {}),
          ...(input.is_ready !== undefined ? { is_ready: input.is_ready } : {}),
          ...(input.is_revealed !== undefined ? { is_revealed: input.is_revealed } : {}),
          ...(input.connection_status !== undefined
            ? { connection_status: input.connection_status }
            : {}),
          ...(input.left_at !== undefined ? { left_at: input.left_at } : {}),
        };
        matchPlayers[idx] = updated;
        return { ...updated };
      }
    }
    return null;
  }

  async saveSnapshot(input: CreateMatchCodeSnapshotInput): Promise<MatchCodeSnapshotEntity> {
    const now = new Date().toISOString();
    const snapshot: MatchCodeSnapshotEntity = {
      id: input.id ?? randomUUID(),
      match_id: input.match_id,
      round_id: input.round_id,
      user_id: input.user_id,
      problem_id: input.problem_id,
      language: input.language,
      source_code: input.source_code,
      version: input.version ?? 1,
      captured_at: input.captured_at ?? now,
    };

    const list = this.snapshots.get(input.match_id) ?? [];
    list.push(snapshot);
    this.snapshots.set(input.match_id, list);
    return { ...snapshot };
  }

  async findSnapshotsByMatch(matchId: string): Promise<MatchCodeSnapshotEntity[]> {
    const list = this.snapshots.get(matchId) ?? [];
    return list.map((s) => ({ ...s }));
  }

  async deleteSnapshotsByUser(userId: string, onlyUnrevealed = false): Promise<number> {
    let deleted = 0;
    for (const [matchId, snapshotList] of this.snapshots.entries()) {
      if (onlyUnrevealed) {
        const matchPlayers = this.players.get(matchId) ?? [];
        const player = matchPlayers.find((p) => p.user_id === userId);
        if (player?.is_revealed) {
          continue;
        }
      }

      const remaining: MatchCodeSnapshotEntity[] = [];
      for (const snap of snapshotList) {
        if (snap.user_id === userId) {
          deleted++;
        } else {
          remaining.push(snap);
        }
      }
      this.snapshots.set(matchId, remaining);
    }
    return deleted;
  }

  async countActiveRooms(): Promise<number> {
    let count = 0;
    for (const match of this.matches.values()) {
      if (match.status === 'lobby' || match.status === 'running' || match.status === 'settling') {
        count++;
      }
    }
    return count;
  }

  async allocateNextAdmissionSeq(matchId: string): Promise<number> {
    const match = this.matches.get(matchId);
    if (!match) return 1;
    const nextSeq = (match.admission_seq ?? 0) + 1;
    match.admission_seq = nextSeq;
    return nextSeq;
  }

  clear(): void {
    this.matches.clear();
    this.roomCodeToId.clear();
    this.players.clear();
    this.snapshots.clear();
  }
}

/**
 * Repositorio de envíos durable en memoria (doc 04 §1).
 */
export class InMemorySubmissionRepository implements SubmissionRepository {
  private readonly submissions = new Map<string, SubmissionWithLeaseEntity>();

  constructor(private readonly roomRepo?: Pick<RoomRepository, 'findPlayer'>) {}

  async createSubmissionForActivePlayer(
    input: CreateSubmissionInput,
  ): Promise<SubmissionEntity | null> {
    if (this.roomRepo) {
      const player = await this.roomRepo.findPlayer(input.match_id, input.user_id);
      if (!player || player.connection_status === 'left') return null;
    }

    return this.createSubmission(input);
  }

  async createSubmission(input: CreateSubmissionInput): Promise<SubmissionEntity> {
    const now = new Date().toISOString();
    const submission: SubmissionWithLeaseEntity = {
      id: input.id ?? randomUUID(),
      match_id: input.match_id,
      round_id: input.round_id,
      user_id: input.user_id,
      problem_id: input.problem_id,
      language: input.language,
      source_code: input.source_code,
      time_limit_ms: input.time_limit_ms,
      memory_limit_mb: input.memory_limit_mb,
      received_at: input.received_at ?? now,
      admission_seq: input.admission_seq,
      status: input.status ?? 'queued',
      verdict: input.verdict ?? null,
      passed_cases: input.passed_cases ?? null,
      total_cases: input.total_cases ?? null,
      exec_time_ms: input.exec_time_ms ?? null,
      compile_output: input.compile_output ?? null,
      judge_error: input.judge_error ?? null,
      judged_at: input.judged_at ?? null,
      attempt_token: null,
      worker_id: null,
      lease_until: null,
    };

    this.submissions.set(submission.id, submission);
    return { ...submission };
  }

  async findSubmissionById(id: string): Promise<SubmissionEntity | null> {
    const sub = this.submissions.get(id);
    return sub ? { ...sub } : null;
  }

  async findSubmissionsByMatch(matchId: string): Promise<SubmissionEntity[]> {
    const list: SubmissionEntity[] = [];
    for (const sub of this.submissions.values()) {
      if (sub.match_id === matchId) list.push({ ...sub });
    }
    return list;
  }

  async findSubmissionsByUser(matchId: string, userId: string): Promise<SubmissionEntity[]> {
    const list: SubmissionEntity[] = [];
    for (const sub of this.submissions.values()) {
      if (sub.match_id === matchId && sub.user_id === userId) list.push({ ...sub });
    }
    return list;
  }

  async findPendingSubmissions(limit = 100): Promise<SubmissionEntity[]> {
    const list: SubmissionEntity[] = [];
    for (const sub of this.submissions.values()) {
      if (sub.status === 'queued') {
        list.push({ ...sub });
        if (list.length >= limit) break;
      }
    }
    return list;
  }

  async updateSubmission(
    id: string,
    input: Partial<SubmissionEntity>,
  ): Promise<SubmissionEntity | null> {
    const existing = this.submissions.get(id);
    if (!existing) return null;

    const updated: SubmissionWithLeaseEntity = {
      ...existing,
      ...input,
    };

    this.submissions.set(id, updated);
    return { ...updated };
  }

  async claimSubmission(
    submissionId: string,
    workerId: string,
    leaseDurationMs = 120000,
    nowIso?: string,
  ): Promise<ClaimResult> {
    const sub = this.submissions.get(submissionId);
    if (!sub) {
      throw new Error(`Envío no encontrado: ${submissionId}`);
    }

    if (sub.status === 'completed') {
      return { status: 'completed' };
    }

    const now = nowIso ? new Date(nowIso).getTime() : Date.now();

    if (sub.status === 'judging') {
      const leaseExpiry = sub.lease_until ? new Date(sub.lease_until).getTime() : 0;
      if (leaseExpiry > now) {
        return { status: 'busy' };
      }
    }

    // Adquirir o renovar lease con attempt_token nuevo
    const attemptToken = randomUUID();
    const leaseUntil = new Date(now + leaseDurationMs).toISOString();

    sub.status = 'judging';
    sub.attempt_token = attemptToken;
    sub.worker_id = workerId;
    sub.lease_until = leaseUntil;

    return {
      status: 'acquired',
      attempt_token: attemptToken,
    };
  }

  async persistIfCurrent(
    result: PersistSubmissionResultInput,
    attemptToken: string,
  ): Promise<PersistStatus> {
    const sub = this.submissions.get(result.submission_id);
    if (!sub) {
      throw new Error(`Envío no encontrado: ${result.submission_id}`);
    }

    if (sub.status === 'completed') {
      return 'completed';
    }

    if (sub.status !== 'judging' || sub.attempt_token !== attemptToken) {
      return 'fenced';
    }

    const now = result.judged_at ?? new Date().toISOString();
    sub.status = 'completed';
    sub.verdict = result.verdict;
    sub.passed_cases = result.passed_cases;
    sub.total_cases = result.total_cases;
    sub.exec_time_ms = result.exec_time_ms;
    sub.compile_output = result.compile_output ?? null;
    sub.judge_error = result.judge_error ?? null;
    sub.judged_at = now;

    // Limpiar attempt_token, worker_id, lease_until al completar para mantener invariante
    sub.attempt_token = null;
    sub.worker_id = null;
    sub.lease_until = null;

    return 'stored';
  }

  clear(): void {
    this.submissions.clear();
  }
}

/**
 * Repositorio de problemas y casos de prueba en memoria (doc 04 §1).
 */
export class InMemoryProblemRepository implements ProblemRepository {
  private readonly problems = new Map<string, ProblemEntity>();
  private readonly testCases = new Map<string, TestCaseEntity[]>();

  async findProblemById(id: string): Promise<ProblemEntity | null> {
    const prob = this.problems.get(id);
    return prob ? { ...prob } : null;
  }

  async findProblemByContentHash(contentHash: string): Promise<ProblemEntity | null> {
    for (const prob of this.problems.values()) {
      if (prob.content_hash === contentHash) {
        return { ...prob };
      }
    }
    return null;
  }

  async findAllProblems(limit = 100): Promise<ProblemEntity[]> {
    const list: ProblemEntity[] = [];
    for (const prob of this.problems.values()) {
      list.push({ ...prob });
      if (list.length >= limit) break;
    }
    return list;
  }

  async countProblemsByCategories(
    categories: readonly ProblemCategory[],
  ): Promise<Partial<Record<ProblemCategory, number>>> {
    const selected = new Set(categories);
    const counts: Partial<Record<ProblemCategory, number>> = {};
    for (const problem of this.problems.values()) {
      if (selected.has(problem.category)) {
        counts[problem.category] = (counts[problem.category] ?? 0) + 1;
      }
    }
    return counts;
  }

  async findTestCasesByProblemId(problemId: string): Promise<TestCaseEntity[]> {
    const cases = this.testCases.get(problemId) ?? [];
    return cases.map((c) => ({ ...c }));
  }

  async createProblem(problem: ProblemEntity): Promise<ProblemEntity> {
    this.problems.set(problem.id, { ...problem });
    return { ...problem };
  }

  async createTestCase(testCase: TestCaseEntity): Promise<TestCaseEntity> {
    const raw = testCase as unknown as { ordinal?: number; order_idx?: number };
    const ordinal = raw.ordinal ?? raw.order_idx ?? 0;
    const normalized: TestCaseEntity = {
      ...testCase,
      ordinal,
    };
    const cases = this.testCases.get(testCase.problem_id) ?? [];
    const existingIdx =
      raw.ordinal !== undefined || raw.order_idx !== undefined
        ? cases.findIndex((c) => c.ordinal === ordinal)
        : -1;

    if (existingIdx >= 0) {
      cases[existingIdx] = { ...normalized };
    } else {
      cases.push({ ...normalized });
      cases.sort((a, b) => a.ordinal - b.ordinal);
    }
    this.testCases.set(testCase.problem_id, cases);
    return { ...normalized };
  }

  clear(): void {
    this.problems.clear();
    this.testCases.clear();
  }
}

/**
 * Repositorio de eventos de auditoría y producto en memoria (doc 04 §1, doc 08 § Métricas de producto).
 */
export class InMemoryEventRepository implements EventRepository {
  private readonly events: EventEntity[] = [];

  async recordEvent(input: CreateEventInput): Promise<EventEntity> {
    const now = new Date().toISOString();
    const event: EventEntity = {
      id: input.id ?? randomUUID(),
      aggregate_type: input.aggregate_type,
      aggregate_id: input.aggregate_id,
      event_name: input.event_name,
      payload: { ...input.payload },
      created_at: input.created_at ?? now,
    };

    this.events.push(event);
    return { ...event, payload: { ...event.payload } };
  }

  async findEventsByAggregate(aggregateType: string, aggregateId: string): Promise<EventEntity[]> {
    return this.events
      .filter((e) => e.aggregate_type === aggregateType && e.aggregate_id === aggregateId)
      .map((e) => ({ ...e, payload: { ...e.payload } }));
  }

  async findEventsByName(eventName: string, limit?: number): Promise<EventEntity[]> {
    const matched = this.events.filter((e) => e.event_name === eventName);
    const sliced = typeof limit === 'number' && limit >= 0 ? matched.slice(0, limit) : matched;
    return sliced.map((e) => ({ ...e, payload: { ...e.payload } }));
  }

  async countEvents(eventName?: string): Promise<number> {
    if (eventName !== undefined) {
      return this.events.filter((e) => e.event_name === eventName).length;
    }
    return this.events.length;
  }

  clear(): void {
    this.events.length = 0;
  }
}

/**
 * Repositorio en memoria para mensajes rechazados del juez (S19, doc 04 §135).
 * Registra exclusivamente message_id y motivo saneado; nunca código fuente ni casos.
 */
export class InMemoryRejectedMessageRepository implements RejectedMessageRepository {
  private readonly messages = new Map<string, RejectedMessageEntity>();

  async recordRejected(messageId: string, reason: string): Promise<boolean> {
    const sanitizedReason = reason.length > 1024 ? reason.slice(0, 1024) : reason;
    if (this.messages.has(messageId)) {
      // Idempotencia exitosa: si ya existe durablemente, confirma éxito (true)
      // para permitir al consumidor del juez realizar XACK de forma segura en Redis
      return true;
    }
    const entry: RejectedMessageEntity = {
      message_id: messageId,
      reason: sanitizedReason,
      rejected_at: new Date().toISOString(),
    };
    this.messages.set(messageId, entry);
    return true;
  }

  async findRejectedMessageById(messageId: string): Promise<RejectedMessageEntity | null> {
    const entry = this.messages.get(messageId);
    return entry ? { ...entry } : null;
  }

  async countRejectedMessages(): Promise<number> {
    return this.messages.size;
  }

  clear(): void {
    this.messages.clear();
  }
}
