import { describe, expect, it } from 'vitest';
import type { Pool as PgPool } from 'pg';
import { PostgresMatchStore } from '../src/store/postgres.js';

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
});
