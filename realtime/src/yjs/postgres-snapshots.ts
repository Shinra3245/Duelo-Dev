import type { Pool } from 'pg';
import type { CodeSnapshot } from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Persistencia durable de snapshots Yjs con validación de pertenencia y consentimiento. */
export class PostgresYjsSnapshotStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async persist(snapshot: CodeSnapshot): Promise<void> {
    const problemId = snapshot.problemId;
    if (!problemId) return;
    const identifiers = [
      snapshot.id,
      snapshot.matchId,
      snapshot.roundId,
      snapshot.userId,
      problemId,
    ];
    if (!identifiers.every((value) => UUID_PATTERN.test(value))) return;

    await this.pool.query(
      `INSERT INTO match_code_snapshots (
         id, match_id, round_id, user_id, problem_id, language, source_code,
         is_revealed, version, captured_at
       )
       SELECT $1, $2, $3, $4, $5, 'python', $6, $7, $8, $9
       WHERE EXISTS (
         SELECT 1 FROM matches
         WHERE id = $2 AND status IN ('running', 'settling', 'finished', 'abandoned')
       )
         AND EXISTS (
           SELECT 1 FROM match_players WHERE match_id = $2 AND user_id = $4
         )
         AND EXISTS (SELECT 1 FROM problems WHERE id = $5)
       ON CONFLICT (id) DO UPDATE SET
         source_code = EXCLUDED.source_code,
         is_revealed = EXCLUDED.is_revealed,
         version = EXCLUDED.version,
         captured_at = EXCLUDED.captured_at`,
      [
        snapshot.id,
        snapshot.matchId,
        snapshot.roundId,
        snapshot.userId,
        problemId,
        snapshot.code,
        snapshot.isRevealed,
        snapshot.generation,
        new Date(snapshot.capturedAt),
      ],
    );
  }
}
