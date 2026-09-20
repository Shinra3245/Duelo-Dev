import { randomUUID } from 'node:crypto';
import type { Pool as PgPool, PoolClient } from 'pg';
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
  UpdateUserInput,
  UserRepository,
} from './types.js';

export class PostgresRoomCreationPolicyRepository implements RoomCreationPolicyRepository {
  constructor(private readonly pool: PgPool) {}

  async getRegisteredUsersCanCreateRooms(): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT enabled FROM application_settings WHERE setting_key = 'registered_room_creation'",
    );
    return result.rows[0]?.['enabled'] === true;
  }

  async setRegisteredUsersCanCreateRooms(enabled: boolean): Promise<void> {
    await this.pool.query(
      `INSERT INTO application_settings (setting_key, enabled, updated_at)
       VALUES ('registered_room_creation', $1, clock_timestamp())
       ON CONFLICT (setting_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at`,
      [enabled],
    );
  }
}

function mapUserRow(row: Record<string, unknown>): UserEntity {
  return {
    id: String(row['id']),
    email: row['email'] ? String(row['email']) : null,
    password_hash: row['password_hash'] ? String(row['password_hash']) : null,
    gamertag: String(row['gamertag']),
    role: row['role'] as UserEntity['role'],
    created_at: new Date(row['created_at'] as string | Date).toISOString(),
    updated_at: new Date(row['updated_at'] as string | Date).toISOString(),
  };
}

function mapRefreshTokenRow(row: Record<string, unknown>): RefreshTokenEntity {
  return {
    id: String(row['id']),
    user_id: String(row['user_id']),
    token_hash: String(row['token_hash']),
    family_id: String(row['family_id']),
    expires_at: new Date(row['expires_at'] as string | Date).toISOString(),
    revoked: Boolean(row['revoked']),
    created_at: new Date(row['created_at'] as string | Date).toISOString(),
  };
}

function mapMatchRow(row: Record<string, unknown>): MatchEntity {
  const config =
    typeof row['config'] === 'string'
      ? (JSON.parse(row['config']) as MatchEntity['config'])
      : (row['config'] as MatchEntity['config']);

  return {
    id: String(row['id']),
    room_code: String(row['room_code']),
    mode: row['mode'] as MatchEntity['mode'],
    status: row['status'] as MatchEntity['status'],
    config,
    host_id: String(row['host_id']),
    state_version: Number(row['state_version']),
    admission_seq: Number(row['admission_seq'] ?? 0),
    winner_ids: Array.isArray(row['winner_ids']) ? (row['winner_ids'] as string[]) : [],
    winner_id: row['winner_id'] ? String(row['winner_id']) : null,
    finish_reason: (row['finish_reason'] as MatchEntity['finish_reason']) ?? null,
    started_at: row['started_at']
      ? new Date(row['started_at'] as string | Date).toISOString()
      : null,
    instructions_ends_at: row['instructions_ends_at']
      ? new Date(row['instructions_ends_at'] as string | Date).toISOString()
      : null,
    ends_at: row['ends_at'] ? new Date(row['ends_at'] as string | Date).toISOString() : null,
    finished_at: row['finished_at']
      ? new Date(row['finished_at'] as string | Date).toISOString()
      : null,
    created_at: new Date(row['created_at'] as string | Date).toISOString(),
  };
}

function mapMatchPlayerRow(row: Record<string, unknown>): MatchPlayerEntity {
  return {
    id: String(row['id']),
    match_id: String(row['match_id']),
    user_id: String(row['user_id']),
    score: Number(row['score']),
    cases_total: Number(row['cases_total']),
    time_total_ms: Number(row['time_total_ms']),
    current_problem_idx: Number(row['current_problem_idx']),
    is_ready: Boolean(row['is_ready']),
    is_revealed: Boolean(row['is_revealed']),
    connection_status: row['connection_status'] as MatchPlayerEntity['connection_status'],
    joined_at: new Date(row['joined_at'] as string | Date).toISOString(),
    left_at: row['left_at'] ? new Date(row['left_at'] as string | Date).toISOString() : null,
  };
}

function mapProblemRow(row: Record<string, unknown>): ProblemEntity {
  return {
    id: String(row['id']),
    title: String(row['title']),
    description: String(row['description']),
    category: row['category'] as ProblemEntity['category'],
    time_limit_ms: Number(row['time_limit_ms']),
    memory_limit_mb: Number(row['memory_limit_mb']),
    version: Number(row['version'] ?? 1),
    content_hash: String(row['content_hash']),
    created_at: new Date(row['created_at'] as string | Date).toISOString(),
  };
}

function mapTestCaseRow(row: Record<string, unknown>): TestCaseEntity {
  return {
    id: String(row['id']),
    problem_id: String(row['problem_id']),
    ordinal: Number(row['ordinal']),
    input: String(row['input']),
    expected_output: String(row['expected_output']),
    is_example: Boolean(row['is_example']),
    created_at: new Date(row['created_at'] as string | Date).toISOString(),
  };
}

function mapSubmissionRow(row: Record<string, unknown>): SubmissionEntity {
  return {
    id: String(row['id']),
    match_id: String(row['match_id']),
    round_id: String(row['round_id']),
    user_id: String(row['user_id']),
    problem_id: String(row['problem_id']),
    language: row['language'] as SubmissionEntity['language'],
    source_code: String(row['source_code']),
    time_limit_ms: Number(row['time_limit_ms']),
    memory_limit_mb: Number(row['memory_limit_mb']),
    received_at: new Date(row['received_at'] as string | Date).toISOString(),
    admission_seq: Number(row['admission_seq']),
    status: row['status'] as SubmissionEntity['status'],
    verdict: (row['verdict'] as SubmissionEntity['verdict']) ?? null,
    passed_cases:
      row['passed_cases'] !== null && row['passed_cases'] !== undefined
        ? Number(row['passed_cases'])
        : null,
    total_cases:
      row['total_cases'] !== null && row['total_cases'] !== undefined
        ? Number(row['total_cases'])
        : null,
    exec_time_ms:
      row['exec_time_ms'] !== null && row['exec_time_ms'] !== undefined
        ? Number(row['exec_time_ms'])
        : null,
    compile_output: row['compile_output'] ? String(row['compile_output']) : null,
    judge_error: row['judge_error'] ? String(row['judge_error']) : null,
    judged_at: row['judged_at'] ? new Date(row['judged_at'] as string | Date).toISOString() : null,
  };
}

function mapSnapshotRow(row: Record<string, unknown>): MatchCodeSnapshotEntity {
  return {
    id: String(row['id']),
    match_id: String(row['match_id']),
    round_id: String(row['round_id']),
    user_id: String(row['user_id']),
    problem_id: String(row['problem_id']),
    language: row['language'] as MatchCodeSnapshotEntity['language'],
    source_code: String(row['source_code']),
    version: Number(row['version'] ?? 1),
    captured_at: new Date(row['captured_at'] as string | Date).toISOString(),
  };
}

function mapEventRow(row: Record<string, unknown>): EventEntity {
  const payload =
    typeof row['payload'] === 'string'
      ? (JSON.parse(row['payload']) as Record<string, unknown>)
      : (row['payload'] as Record<string, unknown>);

  return {
    id: String(row['id']),
    aggregate_type: String(row['aggregate_type']),
    aggregate_id: String(row['aggregate_id']),
    event_name: String(row['event_name']),
    payload,
    created_at: new Date(row['created_at'] as string | Date).toISOString(),
  };
}

/**
 * Adaptador PostgreSQL para el repositorio de usuarios (doc 04 §1).
 */
export class PostgresUserRepository implements UserRepository {
  constructor(private readonly pool: PgPool) {}

  async findById(id: string): Promise<UserEntity | null> {
    const res = await this.pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return res.rows[0] ? mapUserRow(res.rows[0]) : null;
  }

  async findByEmail(email: string): Promise<UserEntity | null> {
    const res = await this.pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [
      email.trim(),
    ]);
    return res.rows[0] ? mapUserRow(res.rows[0]) : null;
  }

  async findByGamertag(gamertag: string): Promise<UserEntity | null> {
    const res = await this.pool.query('SELECT * FROM users WHERE LOWER(gamertag) = LOWER($1)', [
      gamertag.trim(),
    ]);
    return res.rows[0] ? mapUserRow(res.rows[0]) : null;
  }

  async findAll(limit = 100, offset = 0): Promise<UserEntity[]> {
    const res = await this.pool.query(
      'SELECT * FROM users ORDER BY created_at ASC LIMIT $1 OFFSET $2',
      [limit, offset],
    );
    return res.rows.map(mapUserRow);
  }

  async create(input: CreateUserInput): Promise<UserEntity> {
    const id = input.id ?? randomUUID();
    const email = input.email ? input.email.trim().toLowerCase() : null;
    const res = await this.pool.query(
      `INSERT INTO users (id, email, password_hash, gamertag, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, clock_timestamp()), COALESCE($7, clock_timestamp()))
       RETURNING *`,
      [
        id,
        email,
        input.password_hash ?? null,
        input.gamertag,
        input.role,
        input.created_at ? new Date(input.created_at) : null,
        input.updated_at ? new Date(input.updated_at) : null,
      ],
    );
    return mapUserRow(res.rows[0]!);
  }

  async update(id: string, input: UpdateUserInput): Promise<UserEntity | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (input.email !== undefined) {
      fields.push(`email = $${idx++}`);
      values.push(input.email ? input.email.trim().toLowerCase() : null);
    }
    if (input.password_hash !== undefined) {
      fields.push(`password_hash = $${idx++}`);
      values.push(input.password_hash);
    }
    if (input.gamertag !== undefined) {
      fields.push(`gamertag = $${idx++}`);
      values.push(input.gamertag);
    }
    if (input.role !== undefined) {
      fields.push(`role = $${idx++}`);
      values.push(input.role);
    }
    fields.push(`updated_at = COALESCE($${idx++}, clock_timestamp())`);
    values.push(input.updated_at ? new Date(input.updated_at) : null);

    values.push(id);
    const res = await this.pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    return res.rows[0] ? mapUserRow(res.rows[0]) : null;
  }

  async count(): Promise<number> {
    const res = await this.pool.query('SELECT COUNT(*)::int as count FROM users');
    return Number(res.rows[0]?.count ?? 0);
  }

  async findInactiveGuests(olderThanIso: string): Promise<UserEntity[]> {
    const res = await this.pool.query(
      "SELECT * FROM users WHERE role = 'guest' AND updated_at <= $1 ORDER BY updated_at ASC",
      [new Date(olderThanIso)],
    );
    return res.rows.map(mapUserRow);
  }

  async anonymizeGuest(
    id: string,
    tombstoneGamertag: string,
    updatedAtIso?: string,
  ): Promise<UserEntity | null> {
    const res = await this.pool.query(
      `UPDATE users
       SET gamertag = $2, email = NULL, password_hash = NULL, updated_at = COALESCE($3, clock_timestamp())
       WHERE id = $1 AND role = 'guest'
       RETURNING *`,
      [id, tombstoneGamertag, updatedAtIso ? new Date(updatedAtIso) : null],
    );
    return res.rows[0] ? mapUserRow(res.rows[0]) : null;
  }
}

/**
 * Adaptador PostgreSQL para refresh tokens (doc 04 §1).
 */
export class PostgresRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly pool: PgPool) {}

  async create(input: CreateRefreshTokenInput): Promise<RefreshTokenEntity> {
    const id = input.id ?? randomUUID();
    const res = await this.pool.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, revoked, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, clock_timestamp()))
       RETURNING *`,
      [
        id,
        input.user_id,
        input.token_hash,
        input.family_id,
        new Date(input.expires_at),
        input.revoked ?? false,
        input.created_at ? new Date(input.created_at) : null,
      ],
    );
    return mapRefreshTokenRow(res.rows[0]!);
  }

  async findByTokenHash(tokenHash: string): Promise<RefreshTokenEntity | null> {
    const res = await this.pool.query('SELECT * FROM refresh_tokens WHERE token_hash = $1', [
      tokenHash,
    ]);
    return res.rows[0] ? mapRefreshTokenRow(res.rows[0]) : null;
  }

  async revoke(id: string): Promise<void> {
    await this.pool.query('UPDATE refresh_tokens SET revoked = true WHERE id = $1', [id]);
  }

  async revokeFamily(userId: string, familyId: string): Promise<number> {
    const res = await this.pool.query(
      'UPDATE refresh_tokens SET revoked = true WHERE user_id = $1 AND family_id = $2 AND revoked = false',
      [userId, familyId],
    );
    return res.rowCount ?? 0;
  }

  async deleteExpired(nowIso?: string): Promise<number> {
    const reference = nowIso ? new Date(nowIso) : new Date();
    const res = await this.pool.query('DELETE FROM refresh_tokens WHERE expires_at <= $1', [
      reference,
    ]);
    return res.rowCount ?? 0;
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const res = await this.pool.query(
      'UPDATE refresh_tokens SET revoked = true WHERE user_id = $1 AND revoked = false',
      [userId],
    );
    return res.rowCount ?? 0;
  }
}

/**
 * Adaptador PostgreSQL para salas, jugadores y snapshots (doc 04 §2).
 */
export class PostgresRoomRepository implements RoomRepository {
  constructor(private readonly pool: PgPool) {}

  async createMatch(input: CreateMatchInput): Promise<MatchEntity> {
    const id = input.id ?? randomUUID();
    const res = await this.pool.query(
      `INSERT INTO matches (
        id, room_code, mode, status, config, host_id, state_version, admission_seq,
        winner_ids, winner_id, finish_reason, started_at, instructions_ends_at, ends_at, finished_at, created_at
      ) VALUES (
        $1, UPPER($2), $3, $4, $5::jsonb, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, COALESCE($16, clock_timestamp())
      ) RETURNING *`,
      [
        id,
        input.room_code.trim(),
        input.mode,
        input.status ?? 'lobby',
        JSON.stringify(input.config),
        input.host_id,
        input.state_version ?? 1,
        input.admission_seq ?? 0,
        input.winner_ids ?? [],
        input.winner_id ?? null,
        input.finish_reason ?? null,
        input.started_at ? new Date(input.started_at) : null,
        input.instructions_ends_at ? new Date(input.instructions_ends_at) : null,
        input.ends_at ? new Date(input.ends_at) : null,
        input.finished_at ? new Date(input.finished_at) : null,
        input.created_at ? new Date(input.created_at) : null,
      ],
    );
    return mapMatchRow(res.rows[0]!);
  }

  async findMatchById(id: string): Promise<MatchEntity | null> {
    const res = await this.pool.query('SELECT * FROM matches WHERE id = $1', [id]);
    return res.rows[0] ? mapMatchRow(res.rows[0]) : null;
  }

  async deleteMatch(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM matches WHERE id = $1 RETURNING id', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async findMatchByRoomCode(roomCode: string): Promise<MatchEntity | null> {
    const res = await this.pool.query('SELECT * FROM matches WHERE UPPER(room_code) = UPPER($1)', [
      roomCode.trim(),
    ]);
    return res.rows[0] ? mapMatchRow(res.rows[0]) : null;
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
    const values: unknown[] = [];
    let statusClause = '';
    if (options.status !== undefined) {
      values.push(options.status);
      statusClause = `WHERE status = $${values.length}`;
    }
    values.push(limit, offset);
    const res = await this.pool.query(
      `SELECT * FROM matches ${statusClause}
       ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return res.rows.map(mapMatchRow);
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
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (input.status !== undefined) {
      fields.push(`status = $${idx++}`);
      values.push(input.status);
    }
    if (input.started_at !== undefined) {
      fields.push(`started_at = $${idx++}`);
      values.push(input.started_at ? new Date(input.started_at) : null);
    }
    if (input.instructions_ends_at !== undefined) {
      fields.push(`instructions_ends_at = $${idx++}`);
      values.push(input.instructions_ends_at ? new Date(input.instructions_ends_at) : null);
    }
    if (input.ends_at !== undefined) {
      fields.push(`ends_at = $${idx++}`);
      values.push(input.ends_at ? new Date(input.ends_at) : null);
    }
    if (input.finished_at !== undefined) {
      fields.push(`finished_at = $${idx++}`);
      values.push(input.finished_at ? new Date(input.finished_at) : null);
    }
    if (input.winner_id !== undefined) {
      fields.push(`winner_id = $${idx++}`);
      values.push(input.winner_id);
    }
    if (input.winner_ids !== undefined) {
      fields.push(`winner_ids = $${idx++}`);
      values.push(input.winner_ids);
    }
    if (input.finish_reason !== undefined) {
      fields.push(`finish_reason = $${idx++}`);
      values.push(input.finish_reason);
    }
    if (input.host_id !== undefined) {
      fields.push(`host_id = $${idx++}`);
      values.push(input.host_id);
    }
    if (input.state_version !== undefined) {
      fields.push(`state_version = $${idx++}`);
      values.push(input.state_version);
    }
    if (input.admission_seq !== undefined) {
      fields.push(`admission_seq = $${idx++}`);
      values.push(input.admission_seq);
    }

    if (fields.length === 0) {
      return this.findMatchById(id);
    }

    values.push(id);
    const res = await this.pool.query(
      `UPDATE matches SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    return res.rows[0] ? mapMatchRow(res.rows[0]) : null;
  }

  async addPlayer(input: CreateMatchPlayerInput): Promise<MatchPlayerEntity> {
    const id = input.id ?? randomUUID();
    const res = await this.pool.query(
      `INSERT INTO match_players (
        id, match_id, user_id, score, cases_total, time_total_ms, current_problem_idx,
        is_ready, is_revealed, connection_status, joined_at, left_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, COALESCE($11, clock_timestamp()), $12
      ) RETURNING *`,
      [
        id,
        input.match_id,
        input.user_id,
        input.score ?? 0,
        input.cases_total ?? 0,
        input.time_total_ms ?? 0,
        input.current_problem_idx ?? 0,
        input.is_ready ?? true,
        input.is_revealed ?? false,
        input.connection_status ?? 'connected',
        input.joined_at ? new Date(input.joined_at) : null,
        input.left_at ? new Date(input.left_at) : null,
      ],
    );
    return mapMatchPlayerRow(res.rows[0]!);
  }

  async joinLobby(input: CreateMatchPlayerInput, maxPlayers: number) {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const matchResult = await client.query('SELECT * FROM matches WHERE id = $1 FOR UPDATE', [
        input.match_id,
      ]);
      if (!matchResult.rows[0] || matchResult.rows[0]['status'] !== 'lobby') {
        await client.query('COMMIT');
        return { status: 'not_lobby' as const };
      }

      const existingResult = await client.query(
        'SELECT * FROM match_players WHERE match_id = $1 AND user_id = $2',
        [input.match_id, input.user_id],
      );
      if (existingResult.rows[0]) {
        await client.query('COMMIT');
        return {
          status: 'existing' as const,
          match: mapMatchRow(matchResult.rows[0]),
          player: mapMatchPlayerRow(existingResult.rows[0]),
        };
      }

      const countResult = await client.query(
        `SELECT count(*)::integer AS count FROM match_players
         WHERE match_id = $1 AND connection_status <> 'left'`,
        [input.match_id],
      );
      const playerCount = Number(countResult.rows[0]?.['count'] ?? 0);
      if (playerCount >= maxPlayers) {
        await client.query('COMMIT');
        return { status: 'full' as const };
      }

      let matchRow = matchResult.rows[0];
      if (playerCount === 0 && String(matchRow['host_id']) !== input.user_id) {
        const promoted = await client.query(
          'UPDATE matches SET host_id = $2 WHERE id = $1 RETURNING *',
          [input.match_id, input.user_id],
        );
        matchRow = promoted.rows[0]!;
      }

      const playerId = input.id ?? randomUUID();
      const playerResult = await client.query(
        `INSERT INTO match_players (
          id, match_id, user_id, score, cases_total, time_total_ms, current_problem_idx,
          is_ready, is_revealed, connection_status, joined_at, left_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          COALESCE($11, clock_timestamp()), $12
        ) RETURNING *`,
        [
          playerId,
          input.match_id,
          input.user_id,
          input.score ?? 0,
          input.cases_total ?? 0,
          input.time_total_ms ?? 0,
          input.current_problem_idx ?? 0,
          input.is_ready ?? true,
          input.is_revealed ?? false,
          input.connection_status ?? 'connected',
          input.joined_at ? new Date(input.joined_at) : null,
          input.left_at ? new Date(input.left_at) : null,
        ],
      );

      await client.query('COMMIT');
      return {
        status: 'joined' as const,
        match: mapMatchRow(matchRow),
        player: mapMatchPlayerRow(playerResult.rows[0]!),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findPlayersByMatchId(matchId: string): Promise<MatchPlayerEntity[]> {
    const res = await this.pool.query(
      'SELECT * FROM match_players WHERE match_id = $1 ORDER BY joined_at ASC',
      [matchId],
    );
    return res.rows.map(mapMatchPlayerRow);
  }

  async findPlayer(matchId: string, userId: string): Promise<MatchPlayerEntity | null> {
    const res = await this.pool.query(
      'SELECT * FROM match_players WHERE match_id = $1 AND user_id = $2',
      [matchId, userId],
    );
    return res.rows[0] ? mapMatchPlayerRow(res.rows[0]) : null;
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
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (input.score !== undefined) {
      fields.push(`score = $${idx++}`);
      values.push(input.score);
    }
    if (input.cases_total !== undefined) {
      fields.push(`cases_total = $${idx++}`);
      values.push(input.cases_total);
    }
    if (input.time_total_ms !== undefined) {
      fields.push(`time_total_ms = $${idx++}`);
      values.push(input.time_total_ms);
    }
    if (input.current_problem_idx !== undefined) {
      fields.push(`current_problem_idx = $${idx++}`);
      values.push(input.current_problem_idx);
    }
    if (input.is_ready !== undefined) {
      fields.push(`is_ready = $${idx++}`);
      values.push(input.is_ready);
    }
    if (input.is_revealed !== undefined) {
      fields.push(`is_revealed = $${idx++}`);
      values.push(input.is_revealed);
    }
    if (input.connection_status !== undefined) {
      fields.push(`connection_status = $${idx++}`);
      values.push(input.connection_status);
    }
    if (input.left_at !== undefined) {
      fields.push(`left_at = $${idx++}`);
      values.push(input.left_at ? new Date(input.left_at) : null);
    }

    if (fields.length === 0) {
      const existing = await this.pool.query('SELECT * FROM match_players WHERE id = $1', [id]);
      return existing.rows[0] ? mapMatchPlayerRow(existing.rows[0]) : null;
    }

    values.push(id);
    const res = await this.pool.query(
      `UPDATE match_players SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    return res.rows[0] ? mapMatchPlayerRow(res.rows[0]) : null;
  }

  async saveSnapshot(input: CreateMatchCodeSnapshotInput): Promise<MatchCodeSnapshotEntity> {
    const id = input.id ?? randomUUID();
    const res = await this.pool.query(
      `INSERT INTO match_code_snapshots (
        id, match_id, round_id, user_id, problem_id, language, source_code, version, captured_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, clock_timestamp()))
      RETURNING *`,
      [
        id,
        input.match_id,
        input.round_id,
        input.user_id,
        input.problem_id,
        input.language,
        input.source_code,
        input.version ?? 1,
        input.captured_at ? new Date(input.captured_at) : null,
      ],
    );
    return mapSnapshotRow(res.rows[0]!);
  }

  async findSnapshotsByMatch(matchId: string): Promise<MatchCodeSnapshotEntity[]> {
    const res = await this.pool.query(
      'SELECT * FROM match_code_snapshots WHERE match_id = $1 ORDER BY captured_at ASC',
      [matchId],
    );
    return res.rows.map(mapSnapshotRow);
  }

  async deleteSnapshotsByUser(userId: string, onlyUnrevealed = false): Promise<number> {
    if (onlyUnrevealed) {
      const res = await this.pool.query(
        `DELETE FROM match_code_snapshots
         WHERE user_id = $1
           AND match_id NOT IN (
             SELECT match_id FROM match_players WHERE user_id = $1 AND is_revealed = true
           )`,
        [userId],
      );
      return res.rowCount ?? 0;
    }

    const res = await this.pool.query('DELETE FROM match_code_snapshots WHERE user_id = $1', [
      userId,
    ]);
    return res.rowCount ?? 0;
  }

  async countActiveRooms(): Promise<number> {
    const res = await this.pool.query(
      "SELECT COUNT(*)::int as count FROM matches WHERE status IN ('lobby', 'running', 'settling')",
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  async allocateNextAdmissionSeq(matchId: string): Promise<number> {
    const res = await this.pool.query(
      'UPDATE matches SET admission_seq = admission_seq + 1 WHERE id = $1 RETURNING admission_seq',
      [matchId],
    );
    return Number(res.rows[0]?.admission_seq ?? 1);
  }
}

/**
 * Adaptador PostgreSQL para el catálogo de problemas y casos de prueba (doc 04 §1).
 */
export class PostgresProblemRepository implements ProblemRepository {
  constructor(private readonly pool: PgPool) {}

  async findProblemById(id: string): Promise<ProblemEntity | null> {
    const res = await this.pool.query('SELECT * FROM problems WHERE id = $1', [id]);
    return res.rows[0] ? mapProblemRow(res.rows[0]) : null;
  }

  async findProblemByContentHash(contentHash: string): Promise<ProblemEntity | null> {
    const res = await this.pool.query('SELECT * FROM problems WHERE content_hash = $1', [
      contentHash,
    ]);
    return res.rows[0] ? mapProblemRow(res.rows[0]) : null;
  }

  async findAllProblems(limit = 100): Promise<ProblemEntity[]> {
    const res = await this.pool.query('SELECT * FROM problems ORDER BY created_at ASC LIMIT $1', [
      limit,
    ]);
    return res.rows.map(mapProblemRow);
  }

  async countProblemsByCategories(
    categories: readonly ProblemCategory[],
  ): Promise<Partial<Record<ProblemCategory, number>>> {
    const res = await this.pool.query(
      `SELECT category, COUNT(*)::int AS count
       FROM problems
       WHERE category = ANY($1::text[])
       GROUP BY category`,
      [[...categories]],
    );
    return Object.fromEntries(
      res.rows.map((row) => [String(row['category']) as ProblemCategory, Number(row['count'])]),
    );
  }

  async findTestCasesByProblemId(problemId: string): Promise<TestCaseEntity[]> {
    const res = await this.pool.query(
      'SELECT * FROM test_cases WHERE problem_id = $1 ORDER BY ordinal ASC',
      [problemId],
    );
    return res.rows.map(mapTestCaseRow);
  }

  async createProblem(problem: ProblemEntity): Promise<ProblemEntity> {
    const res = await this.pool.query(
      `INSERT INTO problems (
        id, title, description, category, time_limit_ms, memory_limit_mb, version, content_hash, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, clock_timestamp()))
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        category = EXCLUDED.category,
        time_limit_ms = EXCLUDED.time_limit_ms,
        memory_limit_mb = EXCLUDED.memory_limit_mb,
        version = EXCLUDED.version,
        content_hash = EXCLUDED.content_hash
      RETURNING *`,
      [
        problem.id,
        problem.title,
        problem.description,
        problem.category,
        problem.time_limit_ms,
        problem.memory_limit_mb,
        problem.version,
        problem.content_hash,
        problem.created_at ? new Date(problem.created_at) : null,
      ],
    );
    return mapProblemRow(res.rows[0]!);
  }

  async createTestCase(testCase: TestCaseEntity): Promise<TestCaseEntity> {
    const id = testCase.id ?? randomUUID();
    const res = await this.pool.query(
      `INSERT INTO test_cases (
        id, problem_id, ordinal, input, expected_output, is_example, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, clock_timestamp()))
      ON CONFLICT (problem_id, ordinal) DO UPDATE SET
        input = EXCLUDED.input,
        expected_output = EXCLUDED.expected_output,
        is_example = EXCLUDED.is_example
      RETURNING *`,
      [
        id,
        testCase.problem_id,
        testCase.ordinal,
        testCase.input,
        testCase.expected_output,
        testCase.is_example,
        testCase.created_at ? new Date(testCase.created_at) : null,
      ],
    );
    return mapTestCaseRow(res.rows[0]!);
  }
}

/**
 * Adaptador PostgreSQL para envíos, con reserva atómica de admission_seq,
 * lease acquisition y persistencia cercada con fencing S19 (doc 04 §1, §130, §140).
 */
export class PostgresSubmissionRepository implements SubmissionRepository {
  constructor(private readonly pool: PgPool) {}

  async createSubmission(input: CreateSubmissionInput): Promise<SubmissionEntity> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      let admissionSeq = input.admission_seq;
      if (!admissionSeq || admissionSeq <= 0) {
        const seqRes = await client.query(
          'UPDATE matches SET admission_seq = admission_seq + 1 WHERE id = $1 RETURNING admission_seq',
          [input.match_id],
        );
        if (seqRes.rows.length > 0) {
          admissionSeq = Number(seqRes.rows[0].admission_seq);
        } else {
          admissionSeq = 1;
        }
      } else {
        await client.query(
          'UPDATE matches SET admission_seq = GREATEST(admission_seq, $1) WHERE id = $2',
          [admissionSeq, input.match_id],
        );
      }

      const id = input.id ?? randomUUID();
      const insertRes = await client.query(
        `INSERT INTO submissions (
          id, match_id, round_id, user_id, problem_id, language, source_code,
          time_limit_ms, memory_limit_mb, admission_seq, status,
          verdict, passed_cases, total_cases, exec_time_ms, compile_output, judge_error, judged_at,
          received_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11,
          $12, $13, $14, $15, $16, $17, $18,
          COALESCE($19, clock_timestamp())
        ) RETURNING *`,
        [
          id,
          input.match_id,
          input.round_id,
          input.user_id,
          input.problem_id,
          input.language,
          input.source_code,
          input.time_limit_ms,
          input.memory_limit_mb,
          admissionSeq,
          input.status ?? 'queued',
          input.verdict ?? null,
          input.passed_cases ?? null,
          input.total_cases ?? null,
          input.exec_time_ms ?? null,
          input.compile_output ?? null,
          input.judge_error ?? null,
          input.judged_at ? new Date(input.judged_at) : null,
          input.received_at ? new Date(input.received_at) : null,
        ],
      );

      await client.query('COMMIT');
      return mapSubmissionRow(insertRes.rows[0]!);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async findSubmissionById(id: string): Promise<SubmissionEntity | null> {
    const res = await this.pool.query('SELECT * FROM submissions WHERE id = $1', [id]);
    return res.rows[0] ? mapSubmissionRow(res.rows[0]) : null;
  }

  async findSubmissionsByMatch(matchId: string): Promise<SubmissionEntity[]> {
    const res = await this.pool.query(
      'SELECT * FROM submissions WHERE match_id = $1 ORDER BY admission_seq ASC, received_at ASC',
      [matchId],
    );
    return res.rows.map(mapSubmissionRow);
  }

  async findSubmissionsByUser(matchId: string, userId: string): Promise<SubmissionEntity[]> {
    const res = await this.pool.query(
      'SELECT * FROM submissions WHERE match_id = $1 AND user_id = $2 ORDER BY received_at ASC',
      [matchId, userId],
    );
    return res.rows.map(mapSubmissionRow);
  }

  async findPendingSubmissions(limit = 100): Promise<SubmissionEntity[]> {
    const res = await this.pool.query(
      "SELECT * FROM submissions WHERE status = 'queued' ORDER BY received_at ASC LIMIT $1",
      [limit],
    );
    return res.rows.map(mapSubmissionRow);
  }

  async updateSubmission(
    id: string,
    input: Partial<SubmissionEntity>,
  ): Promise<SubmissionEntity | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (input.status !== undefined) {
      fields.push(`status = $${idx++}`);
      values.push(input.status);
    }
    if (input.verdict !== undefined) {
      fields.push(`verdict = $${idx++}`);
      values.push(input.verdict);
    }
    if (input.passed_cases !== undefined) {
      fields.push(`passed_cases = $${idx++}`);
      values.push(input.passed_cases);
    }
    if (input.total_cases !== undefined) {
      fields.push(`total_cases = $${idx++}`);
      values.push(input.total_cases);
    }
    if (input.exec_time_ms !== undefined) {
      fields.push(`exec_time_ms = $${idx++}`);
      values.push(input.exec_time_ms);
    }
    if (input.compile_output !== undefined) {
      fields.push(`compile_output = $${idx++}`);
      values.push(input.compile_output);
    }
    if (input.judge_error !== undefined) {
      fields.push(`judge_error = $${idx++}`);
      values.push(input.judge_error);
    }
    if (input.judged_at !== undefined) {
      fields.push(`judged_at = $${idx++}`);
      values.push(input.judged_at ? new Date(input.judged_at) : null);
    }

    if (fields.length === 0) {
      return this.findSubmissionById(id);
    }

    values.push(id);
    const res = await this.pool.query(
      `UPDATE submissions SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    return res.rows[0] ? mapSubmissionRow(res.rows[0]) : null;
  }

  async claimSubmission(
    submissionId: string,
    workerId: string,
    leaseDurationMs = 120000,
    nowIso?: string,
  ): Promise<ClaimResult> {
    const attemptToken = randomUUID();
    const updateRes = await this.pool.query(
      `UPDATE submissions AS submission
       SET status = 'judging',
           attempt_token = $1,
           worker_id = $2,
           lease_until = COALESCE($5::timestamptz, clock_timestamp()) + ($3 * interval '1 millisecond')
       WHERE submission.id = $4
         AND (
           submission.status = 'queued'
           OR (submission.status = 'judging' AND submission.lease_until <= COALESCE($5::timestamptz, clock_timestamp()))
         )
       RETURNING submission.attempt_token`,
      [attemptToken, workerId, leaseDurationMs, submissionId, nowIso ?? null],
    );

    if (updateRes.rows.length > 0) {
      return {
        status: 'acquired',
        attempt_token: attemptToken,
      };
    }

    const checkRes = await this.pool.query('SELECT status FROM submissions WHERE id = $1', [
      submissionId,
    ]);

    if (checkRes.rows.length === 0) {
      throw new Error(`Envío no encontrado: ${submissionId}`);
    }

    const status = String(checkRes.rows[0]?.status);
    if (status === 'completed') {
      return { status: 'completed' };
    }
    return { status: 'busy' };
  }

  async persistIfCurrent(
    result: PersistSubmissionResultInput,
    attemptToken: string,
  ): Promise<PersistStatus> {
    const judgedAtDate = result.judged_at ? new Date(result.judged_at) : new Date();
    const updateRes = await this.pool.query(
      `UPDATE submissions
       SET status = 'completed',
           verdict = $1,
           passed_cases = $2,
           total_cases = $3,
           exec_time_ms = $4,
           compile_output = $5,
           judge_error = $6,
           judged_at = $7,
           attempt_token = NULL,
           worker_id = NULL,
           lease_until = NULL
       WHERE id = $8
         AND status = 'judging'
         AND attempt_token = $9
       RETURNING id`,
      [
        result.verdict,
        result.passed_cases,
        result.total_cases,
        result.exec_time_ms,
        result.compile_output ?? null,
        result.judge_error ?? null,
        judgedAtDate,
        result.submission_id,
        attemptToken,
      ],
    );

    if (updateRes.rows.length > 0) {
      return 'stored';
    }

    const checkRes = await this.pool.query('SELECT status FROM submissions WHERE id = $1', [
      result.submission_id,
    ]);

    if (checkRes.rows.length === 0) {
      throw new Error(`Envío no encontrado: ${result.submission_id}`);
    }

    return String(checkRes.rows[0]?.status) === 'completed' ? 'completed' : 'fenced';
  }
}

/**
 * Adaptador PostgreSQL para eventos de auditoría y producto (doc 04 §1).
 */
export class PostgresEventRepository implements EventRepository {
  constructor(private readonly pool: PgPool) {}

  async recordEvent(input: CreateEventInput): Promise<EventEntity> {
    const id = input.id ?? randomUUID();
    const res = await this.pool.query(
      `INSERT INTO events (id, aggregate_type, aggregate_id, event_name, payload, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6, clock_timestamp()))
       RETURNING *`,
      [
        id,
        input.aggregate_type,
        input.aggregate_id,
        input.event_name,
        JSON.stringify(input.payload),
        input.created_at ? new Date(input.created_at) : null,
      ],
    );
    return mapEventRow(res.rows[0]!);
  }

  async findEventsByAggregate(aggregateType: string, aggregateId: string): Promise<EventEntity[]> {
    const res = await this.pool.query(
      'SELECT * FROM events WHERE aggregate_type = $1 AND aggregate_id = $2 ORDER BY created_at ASC',
      [aggregateType, aggregateId],
    );
    return res.rows.map(mapEventRow);
  }

  async findEventsByName(eventName: string, limit = 100): Promise<EventEntity[]> {
    const res = await this.pool.query(
      'SELECT * FROM events WHERE event_name = $1 ORDER BY created_at ASC LIMIT $2',
      [eventName, limit],
    );
    return res.rows.map(mapEventRow);
  }

  async countEvents(eventName?: string): Promise<number> {
    if (eventName !== undefined) {
      const res = await this.pool.query(
        'SELECT COUNT(*)::int as count FROM events WHERE event_name = $1',
        [eventName],
      );
      return Number(res.rows[0]?.count ?? 0);
    }
    const res = await this.pool.query('SELECT COUNT(*)::int as count FROM events');
    return Number(res.rows[0]?.count ?? 0);
  }
}

/**
 * Adaptador PostgreSQL para mensajes rechazados del juez (S19, doc 04 §135).
 */
export class PostgresRejectedMessageRepository implements RejectedMessageRepository {
  constructor(private readonly pool: PgPool) {}

  async recordRejected(messageId: string, reason: string): Promise<boolean> {
    const sanitizedReason = reason.length > 1024 ? reason.slice(0, 1024) : reason;
    try {
      await this.pool.query(
        `INSERT INTO judge_rejected_messages (message_id, reason, rejected_at)
         VALUES ($1, $2, clock_timestamp())
         ON CONFLICT (message_id) DO NOTHING`,
        [messageId, sanitizedReason],
      );
      return true;
    } catch {
      return false;
    }
  }

  async findRejectedMessageById(messageId: string): Promise<RejectedMessageEntity | null> {
    const res = await this.pool.query(
      'SELECT message_id, reason, rejected_at FROM judge_rejected_messages WHERE message_id = $1',
      [messageId],
    );
    if (!res.rows[0]) return null;
    return {
      message_id: String(res.rows[0].message_id),
      reason: String(res.rows[0].reason),
      rejected_at: new Date(res.rows[0].rejected_at as string | Date).toISOString(),
    };
  }

  async countRejectedMessages(): Promise<number> {
    const res = await this.pool.query('SELECT COUNT(*)::int as count FROM judge_rejected_messages');
    return Number(res.rows[0]?.count ?? 0);
  }
}
