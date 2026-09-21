import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresYjsSnapshotStore } from '../src/yjs/postgres-snapshots.js';
import type { CodeSnapshot } from '../src/yjs/types.js';

const validSnapshot: CodeSnapshot = {
  id: 'a17c1958-b7ee-4508-afdd-6b4e5e799da7',
  matchId: '42a1f6d4-a05c-45a7-aa08-61c13c1c1dc8',
  roundId: 'fa4b0c75-266c-4cd0-814f-85b06c2d450e',
  userId: '7db59392-3310-4f80-9bb1-4dd1c8a14fbe',
  problemId: 'b45506e9-92fc-4a5b-a963-d0bc581f6a31',
  generation: 3,
  code: 'print("safe snapshot")',
  capturedAt: '2026-09-21T12:00:00.000Z',
  isRevealed: true,
};

describe('PostgresYjsSnapshotStore', () => {
  it('persiste los metadatos y el consentimiento de captura del snapshot', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const store = new PostgresYjsSnapshotStore({ query } as unknown as Pick<Pool, 'query'>);

    await store.persist(validSnapshot);

    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO match_code_snapshots');
    expect(sql).toContain('ON CONFLICT (id) DO UPDATE');
    expect(sql).toContain("'python'");
    expect(sql).toContain("status IN ('running', 'settling', 'finished', 'abandoned')");
    expect(params).toEqual([
      validSnapshot.id,
      validSnapshot.matchId,
      validSnapshot.roundId,
      validSnapshot.userId,
      validSnapshot.problemId,
      validSnapshot.code,
      true,
      validSnapshot.generation,
      new Date(validSnapshot.capturedAt),
    ]);
  });

  it('ignora IDs inválidos y snapshots sin problema antes de consultar PostgreSQL', async () => {
    const query = vi.fn();
    const store = new PostgresYjsSnapshotStore({ query } as unknown as Pick<Pool, 'query'>);

    await store.persist({ ...validSnapshot, roundId: 'round-1' });
    await store.persist({ ...validSnapshot, problemId: null });

    expect(query).not.toHaveBeenCalled();
  });
});
