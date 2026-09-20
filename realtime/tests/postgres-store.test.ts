import { describe, expect, it } from 'vitest';
import type { Pool as PgPool } from 'pg';
import { PostgresMatchStore } from '../src/store/postgres.js';
import type { RealtimeMatchSession } from '../src/types.js';

class FakePgPool {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];

  async query(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.calls.push({ sql, values });

    if (sql.includes('RETURNING *')) {
      return {
        rows: [
          {
            is_ready: true,
            is_revealed: false,
            current_problem_idx: 0,
          },
        ],
      };
    }

    if (sql.includes('SELECT gamertag FROM users')) {
      return { rows: [{ gamertag: 'coder1' }] };
    }

    return { rows: [] };
  }
}

describe('PostgresMatchStore', () => {
  it('solo asigna retos de las dificultades seleccionadas, sin completar con otras', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      async query(sql: string, values: unknown[] = []) {
        calls.push({ sql, values });
        if (sql.includes('SELECT * FROM matches')) {
          return {
            rows: [
              {
                id: 'match-difficulty',
                room_code: 'DIFF1',
                mode: 'puntos',
                status: 'running',
                config: {
                  mode: 'puntos',
                  num_problems: 3,
                  categories: ['facil'],
                  max_players: 2,
                  time_per_problem_s: 60,
                },
                state_version: 2,
                created_at: new Date('2026-09-19T20:00:00.000Z'),
              },
            ],
          };
        }
        if (sql.includes('FROM match_players')) return { rows: [] };
        if (sql.includes('FROM problems')) return { rows: [{ id: 'easy-1' }, { id: 'easy-2' }] };
        return { rows: [] };
      },
    };
    const store = new PostgresMatchStore(pool as unknown as PgPool);

    const session = await store.getMatch('match-difficulty');

    expect(session?.problem_ids).toEqual(['easy-1', 'easy-2']);
    const problemQueries = calls.filter(({ sql }) => sql.includes('FROM problems'));
    expect(problemQueries).toHaveLength(1);
    expect(problemQueries[0]?.sql).toContain('WHERE category = ANY');
    expect(problemQueries[0]?.values).toEqual([['facil'], 3]);
  });

  it('inicia el reloj después de la ventana persistida de instrucciones', async () => {
    const instructionsEndsAt = new Date('2026-09-19T20:00:30.000Z');
    const startedAt = new Date('2026-09-19T20:00:00.000Z');
    const pool = {
      async query(sql: string) {
        if (sql.includes('SELECT * FROM matches')) {
          return {
            rows: [
              {
                id: 'match-countdown',
                room_code: 'COUNT1',
                mode: 'puntos',
                status: 'running',
                config: {
                  mode: 'puntos',
                  num_problems: 1,
                  categories: ['facil'],
                  max_players: 2,
                  time_per_problem_s: 60,
                },
                state_version: 2,
                started_at: startedAt,
                instructions_ends_at: instructionsEndsAt,
                created_at: startedAt,
              },
            ],
          };
        }
        if (sql.includes('FROM match_players')) {
          return {
            rows: [
              {
                user_id: 'player-1',
                gamertag: 'PlayerOne',
                connection_status: 'connected',
                is_ready: true,
                is_revealed: false,
                current_problem_idx: 0,
                score: 0,
                cases_total: 0,
                time_total_ms: 0,
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const store = new PostgresMatchStore(pool as unknown as PgPool);

    const session = await store.getMatch('match-countdown');

    expect(session?.instructions_ends_at).toBe(instructionsEndsAt.getTime());
    expect(session?.started_at).toBe(instructionsEndsAt.toISOString());
    expect(session?.round_opened_at).toBe(instructionsEndsAt.getTime());
    expect(session?.round_ends_at).toBe(instructionsEndsAt.getTime() + 60_000);
  });

  it('persiste reconnecting como disconnected sin perder el estado interno devuelto', async () => {
    const pool = new FakePgPool();
    const store = new PostgresMatchStore(pool as unknown as PgPool);

    const player = await store.setPlayerPresence('match-1', 'user-1', 'reconnecting', 1234);

    expect(player).toMatchObject({
      user_id: 'user-1',
      gamertag: 'coder1',
      connection: 'reconnecting',
      last_seen_at: 1234,
    });

    const updateCall = pool.calls.find((call) => call.sql.includes('UPDATE match_players'));
    expect(updateCall?.values).toEqual(['disconnected', 'match-1', 'user-1']);
  });

  it('restaura y persiste la salida explícita sin confundirla con una desconexión', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      async query(sql: string, values: unknown[] = []) {
        calls.push({ sql, values });
        if (sql.includes('SELECT * FROM matches')) {
          return {
            rows: [
              {
                id: 'match-left',
                room_code: 'LEFT01',
                mode: 'puntos',
                status: 'running',
                config: {
                  mode: 'puntos',
                  num_problems: 1,
                  categories: ['facil'],
                  max_players: 2,
                  time_per_problem_s: 60,
                },
                state_version: 2,
                created_at: new Date('2026-09-19T20:00:00.000Z'),
              },
            ],
          };
        }
        if (sql.includes('FROM match_players')) {
          return {
            rows: [
              {
                user_id: 'user-left',
                gamertag: 'LeavingPlayer',
                connection_status: 'left',
                is_ready: true,
                is_revealed: false,
                current_problem_idx: 0,
                score: 0,
                cases_total: 0,
                time_total_ms: 0,
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const store = new PostgresMatchStore(pool as unknown as PgPool);
    const restored = await store.getMatch('match-left');

    expect(restored?.players.get('user-left')?.connection).toBe('left');

    const leavingSession: RealtimeMatchSession = {
      match_id: 'match-left',
      room_code: 'LEFT01',
      mode: 'puntos',
      config: {
        mode: 'puntos',
        num_problems: 1,
        categories: ['facil'],
        max_players: 2,
        time_per_problem_s: 60,
      },
      status: 'running',
      round_status: 'open',
      current_round_id: 'round-left',
      current_round_idx: 0,
      state_version: 3,
      players: new Map([
        [
          'user-left',
          {
            user_id: 'user-left',
            gamertag: 'LeavingPlayer',
            connection: 'left',
            is_ready: true,
            is_revealed: false,
            current_problem_idx: 0,
            last_seen_at: Date.now(),
          },
        ],
      ]),
      scores: [],
      created_at: new Date('2026-09-19T20:00:00.000Z').toISOString(),
    };
    const savingPool = new FakePgPool();
    const savingStore = new PostgresMatchStore(savingPool as unknown as PgPool);
    await savingStore.saveMatch(leavingSession);

    const playerUpdate = savingPool.calls.find((call) => call.sql.includes('UPDATE match_players'));
    expect(playerUpdate?.values[6]).toBe('left');
    expect(playerUpdate?.sql).toContain('connection_status = $7::varchar(20)');
    expect(playerUpdate?.sql).toContain("WHEN $7::varchar(20) = 'left'");
    expect(playerUpdate?.sql).toContain('COALESCE(left_at, clock_timestamp())');
  });
});
