import type { Pool as PgPool } from 'pg';
import type {
  GameModeName,
  MatchConfig,
  MatchStatus,
  PlayerScore,
  RoundStatus,
} from '@duelodev/shared';
import type { ConnectedPlayer, PlayerConnection, RealtimeMatchSession } from '../types.js';
import type { MatchStore } from './types.js';

function clonePlayer(player: ConnectedPlayer): ConnectedPlayer {
  return { ...player };
}

function toPersistentConnection(connection: PlayerConnection): 'connected' | 'disconnected' {
  return connection === 'connected' ? 'connected' : 'disconnected';
}

function cloneSession(session: RealtimeMatchSession): RealtimeMatchSession {
  const clonedPlayers = new Map<string, ConnectedPlayer>();
  for (const [id, player] of session.players) {
    clonedPlayers.set(id, clonePlayer(player));
  }
  return {
    ...session,
    config: { ...session.config },
    players: clonedPlayers,
    scores: session.scores.map((s) => ({ ...s })),
    ...(session.winner_ids ? { winner_ids: [...session.winner_ids] } : {}),
    ...(session.problem_ids ? { problem_ids: [...session.problem_ids] } : {}),
  };
}

/**
 * Almacén de partidas en tiempo real respaldado de forma durable por PostgreSQL (doc 03, doc 04 §74-108).
 * Sincroniza estado de partida, membresías y presencia directamente con PostgreSQL.
 */
export class PostgresMatchStore implements MatchStore {
  private readonly cachedSessions = new Map<string, RealtimeMatchSession>();

  constructor(private readonly pool: PgPool) {}

  async getMatch(matchId: string): Promise<RealtimeMatchSession | null> {
    const cached = this.cachedSessions.get(matchId);
    if (cached && cached.status !== 'lobby') {
      return cloneSession(cached);
    }

    const matchRes = await this.pool.query('SELECT * FROM matches WHERE id = $1', [matchId]);
    if (!matchRes.rows[0]) {
      return null;
    }
    const matchRow = matchRes.rows[0];

    const playersRes = await this.pool.query(
      `SELECT mp.*, u.gamertag
       FROM match_players mp
       JOIN users u ON u.id = mp.user_id
       WHERE mp.match_id = $1
       ORDER BY mp.joined_at ASC`,
      [matchId],
    );

    const players = new Map<string, ConnectedPlayer>();
    const scores: PlayerScore[] = [];

    for (const p of playersRes.rows) {
      const conn: PlayerConnection =
        p.connection_status === 'connected'
          ? 'connected'
          : p.connection_status === 'disconnected'
            ? 'disconnected'
            : 'reconnecting';

      const connectedPlayer: ConnectedPlayer = {
        user_id: String(p.user_id),
        gamertag: String(p.gamertag),
        connection: conn,
        is_ready: Boolean(p.is_ready),
        is_revealed: Boolean(p.is_revealed),
        current_problem_idx: Number(p.current_problem_idx ?? 0),
        last_seen_at: Date.now(),
      };
      players.set(connectedPlayer.user_id, connectedPlayer);

      scores.push({
        user_id: connectedPlayer.user_id,
        gamertag: connectedPlayer.gamertag,
        score: Number(p.score ?? 0),
        cases_total: Number(p.cases_total ?? 0),
        time_total_ms: Number(p.time_total_ms ?? 0),
        current_problem_idx: connectedPlayer.current_problem_idx,
      });
    }

    const config =
      typeof matchRow.config === 'string'
        ? (JSON.parse(matchRow.config) as MatchConfig)
        : (matchRow.config as MatchConfig);

    const status = matchRow.status as MatchStatus;
    const startedAt = matchRow.started_at
      ? new Date(matchRow.started_at as string | Date).toISOString()
      : undefined;
    const startedAtMs = startedAt ? new Date(startedAt).getTime() : undefined;
    const instructionsEndsAt = matchRow.instructions_ends_at
      ? new Date(matchRow.instructions_ends_at as string | Date).getTime()
      : undefined;
    const playStartedAtMs = instructionsEndsAt ?? startedAtMs;
    const problemIds = status === 'lobby' ? [] : await this.findProblemIdsForConfig(config);

    const session: RealtimeMatchSession = {
      match_id: String(matchRow.id),
      room_code: String(matchRow.room_code),
      mode: matchRow.mode as GameModeName,
      config,
      status,
      round_status: 'open' as RoundStatus,
      current_round_id: String(matchRow.id),
      current_round_idx: 0,
      state_version: Number(matchRow.state_version ?? 1),
      players,
      scores,
      created_at: new Date(matchRow.created_at as string | Date).toISOString(),
      ...(playStartedAtMs !== undefined
        ? { started_at: new Date(playStartedAtMs).toISOString() }
        : {}),
      ...(instructionsEndsAt !== undefined ? { instructions_ends_at: instructionsEndsAt } : {}),
      ...(matchRow.finished_at
        ? { finished_at: new Date(matchRow.finished_at as string | Date).toISOString() }
        : {}),
      ...(Array.isArray(matchRow.winner_ids)
        ? { winner_ids: matchRow.winner_ids as string[] }
        : {}),
      ...(problemIds.length > 0 ? { problem_ids: problemIds } : {}),
      ...(playStartedAtMs !== undefined && status !== 'lobby'
        ? { round_opened_at: playStartedAtMs }
        : {}),
      ...(playStartedAtMs !== undefined && status !== 'lobby' && config.mode === 'puntos'
        ? { round_ends_at: playStartedAtMs + config.time_per_problem_s * 1000 }
        : {}),
      ...(playStartedAtMs !== undefined && status !== 'lobby' && config.mode === 'rondas'
        ? { match_ends_at: playStartedAtMs + config.match_duration_s * 1000 }
        : {}),
    };

    this.cachedSessions.set(matchId, cloneSession(session));
    return cloneSession(session);
  }

  private async findProblemIdsForConfig(config: MatchConfig): Promise<string[]> {
    const limit = Math.max(1, config.num_problems);
    const categories = config.categories.filter((category) => typeof category === 'string');
    const ids: string[] = [];

    if (categories.length > 0) {
      const categorized = await this.pool.query(
        `SELECT id
         FROM problems
         WHERE category = ANY($1::text[])
         ORDER BY created_at ASC, id ASC
         LIMIT $2`,
        [categories, limit],
      );
      ids.push(...categorized.rows.map((row) => String(row.id)));
    }

    if (ids.length < limit) {
      const fallback = await this.pool.query(
        `SELECT id
         FROM problems
         WHERE NOT (id = ANY($1::uuid[]))
         ORDER BY created_at ASC, id ASC
         LIMIT $2`,
        [ids, limit - ids.length],
      );
      ids.push(...fallback.rows.map((row) => String(row.id)));
    }

    return ids.slice(0, limit);
  }

  async saveMatch(session: RealtimeMatchSession): Promise<void> {
    this.cachedSessions.set(session.match_id, cloneSession(session));

    await this.pool.query(
      `UPDATE matches
       SET status = $1,
           state_version = $2,
           winner_ids = $3,
           winner_id = $4,
           started_at = COALESCE($5, started_at),
           finished_at = COALESCE($6, finished_at)
       WHERE id = $7`,
      [
        session.status,
        session.state_version,
        session.winner_ids ?? [],
        session.winner_ids && session.winner_ids.length === 1 ? session.winner_ids[0] : null,
        session.started_at ? new Date(session.started_at) : null,
        session.finished_at ? new Date(session.finished_at) : null,
        session.match_id,
      ],
    );

    for (const [userId, player] of session.players) {
      const pScore = session.scores.find((s) => s.user_id === userId);
      await this.pool.query(
        `UPDATE match_players
         SET score = $1,
             cases_total = $2,
             time_total_ms = $3,
             current_problem_idx = $4,
             is_ready = $5,
             is_revealed = $6,
             connection_status = $7
         WHERE match_id = $8 AND user_id = $9`,
        [
          pScore?.score ?? 0,
          pScore?.cases_total ?? 0,
          pScore?.time_total_ms ?? 0,
          player.current_problem_idx,
          player.is_ready,
          player.is_revealed,
          toPersistentConnection(player.connection),
          session.match_id,
          userId,
        ],
      );
    }
  }

  async deleteMatch(matchId: string): Promise<void> {
    this.cachedSessions.delete(matchId);
    await this.pool.query('DELETE FROM matches WHERE id = $1', [matchId]);
  }

  async setPlayerPresence(
    matchId: string,
    userId: string,
    connection: PlayerConnection,
    now = Date.now(),
  ): Promise<ConnectedPlayer | null> {
    const session = this.cachedSessions.get(matchId);
    let player: ConnectedPlayer | null = null;

    if (session) {
      const p = session.players.get(userId);
      if (p) {
        p.connection = connection;
        p.last_seen_at = now;
        player = clonePlayer(p);
      }
    }

    const res = await this.pool.query(
      `UPDATE match_players
       SET connection_status = $1
       WHERE match_id = $2 AND user_id = $3
       RETURNING *`,
      [toPersistentConnection(connection), matchId, userId],
    );

    if (res.rows.length === 0) {
      return null;
    }

    if (!player) {
      const userRes = await this.pool.query('SELECT gamertag FROM users WHERE id = $1', [userId]);
      player = {
        user_id: userId,
        gamertag: String(userRes.rows[0]?.gamertag ?? ''),
        connection,
        is_ready: Boolean(res.rows[0].is_ready),
        is_revealed: Boolean(res.rows[0].is_revealed),
        current_problem_idx: Number(res.rows[0].current_problem_idx ?? 0),
        last_seen_at: now,
      };
    }

    return player;
  }

  async countActiveMatches(): Promise<number> {
    const res = await this.pool.query(
      "SELECT COUNT(*)::int as count FROM matches WHERE status NOT IN ('finished', 'abandoned')",
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  async listActiveMatchIds(): Promise<string[]> {
    const res = await this.pool.query(
      "SELECT id FROM matches WHERE status NOT IN ('finished', 'abandoned')",
    );
    return res.rows.map((r) => String(r.id));
  }
}
