import type { Pool as PgPool } from 'pg';
import type { Verdict } from '@duelodev/shared';
import type {
  JudgedSubmissionRecord,
  ProcessedSubmissionStore,
  SubmissionProvider,
} from './types.js';

/**
 * Proveedor de envíos juzgados durable desde PostgreSQL para reconciliación y validación (doc 04 §131).
 */
export class PostgresSubmissionProvider implements SubmissionProvider {
  constructor(private readonly pool: PgPool) {}

  async findJudgedSubmissionsByMatch(matchId: string): Promise<JudgedSubmissionRecord[]> {
    const res = await this.pool.query(
      `SELECT id, match_id, round_id, user_id, problem_id, admission_seq,
              received_at, verdict, passed_cases, total_cases, exec_time_ms, compile_output
       FROM submissions
       WHERE match_id = $1 AND status = 'completed' AND verdict IS NOT NULL
       ORDER BY admission_seq ASC, received_at ASC`,
      [matchId],
    );

    return res.rows.map((row) => ({
      id: String(row.id),
      match_id: String(row.match_id),
      round_id: String(row.round_id),
      user_id: String(row.user_id),
      problem_id: String(row.problem_id),
      admission_seq: Number(row.admission_seq),
      received_at: new Date(row.received_at as string | Date).toISOString(),
      verdict: row.verdict as Verdict,
      passed_cases: Number(row.passed_cases ?? 0),
      total_cases: Number(row.total_cases ?? 0),
      exec_time_ms: Number(row.exec_time_ms ?? 0),
      compile_output:
        row.compile_output !== null && row.compile_output !== undefined
          ? String(row.compile_output)
          : undefined,
    }));
  }

  async findJudgedSubmissionById(submissionId: string): Promise<JudgedSubmissionRecord | null> {
    const res = await this.pool.query(
      `SELECT id, match_id, round_id, user_id, problem_id, admission_seq,
              received_at, verdict, passed_cases, total_cases, exec_time_ms, compile_output
       FROM submissions
       WHERE id = $1 AND status = 'completed' AND verdict IS NOT NULL`,
      [submissionId],
    );

    if (!res.rows[0]) {
      return null;
    }
    const row = res.rows[0];

    return {
      id: String(row.id),
      match_id: String(row.match_id),
      round_id: String(row.round_id),
      user_id: String(row.user_id),
      problem_id: String(row.problem_id),
      admission_seq: Number(row.admission_seq),
      received_at: new Date(row.received_at as string | Date).toISOString(),
      verdict: row.verdict as Verdict,
      passed_cases: Number(row.passed_cases ?? 0),
      total_cases: Number(row.total_cases ?? 0),
      exec_time_ms: Number(row.exec_time_ms ?? 0),
      compile_output:
        row.compile_output !== null && row.compile_output !== undefined
          ? String(row.compile_output)
          : undefined,
    };
  }

  async getCompileOutput(submissionId: string): Promise<string | undefined> {
    const res = await this.pool.query('SELECT compile_output FROM submissions WHERE id = $1', [
      submissionId,
    ]);
    if (!res.rows[0] || res.rows[0].compile_output === null) {
      return undefined;
    }
    return String(res.rows[0].compile_output);
  }
}

/**
 * Almacén durable de control de idempotencia respaldado por la tabla `match_processed_submissions`
 * de PostgreSQL (doc 04 §132).
 */
export class PostgresProcessedSubmissionStore implements ProcessedSubmissionStore {
  constructor(private readonly pool: PgPool) {}

  async hasBeenProcessed(matchId: string, submissionId: string): Promise<boolean> {
    const res = await this.pool.query(
      'SELECT 1 FROM match_processed_submissions WHERE match_id = $1 AND submission_id = $2',
      [matchId, submissionId],
    );
    return res.rows.length > 0;
  }

  async claimProcessing(matchId: string, submissionId: string): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO match_processed_submissions (match_id, submission_id, processed_at)
       VALUES ($1, $2, clock_timestamp())
       ON CONFLICT (submission_id) DO NOTHING
       RETURNING id`,
      [matchId, submissionId],
    );
    return res.rows.length > 0;
  }

  async releaseProcessing(matchId: string, submissionId: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM match_processed_submissions WHERE match_id = $1 AND submission_id = $2',
      [matchId, submissionId],
    );
  }

  async markProcessed(matchId: string, submissionId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO match_processed_submissions (match_id, submission_id, processed_at)
       VALUES ($1, $2, clock_timestamp())
       ON CONFLICT (submission_id) DO NOTHING`,
      [matchId, submissionId],
    );
  }

  async countProcessed(matchId?: string): Promise<number> {
    if (matchId) {
      const res = await this.pool.query(
        'SELECT COUNT(*)::int as count FROM match_processed_submissions WHERE match_id = $1',
        [matchId],
      );
      return Number(res.rows[0]?.count ?? 0);
    }
    const res = await this.pool.query(
      'SELECT COUNT(*)::int as count FROM match_processed_submissions',
    );
    return Number(res.rows[0]?.count ?? 0);
  }
}
