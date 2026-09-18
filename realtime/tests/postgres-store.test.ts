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
