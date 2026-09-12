import { describe, expect, it } from 'vitest';
import {
  JUDGE_CONSUMER_GROUP,
  JUDGE_RESULTS_CHANNEL,
  JUDGE_STREAM_KEY,
  JUDGE_STREAM_SCHEMA_VERSION,
  isJudgeJobStreamMessage,
  isJudgeResultNotification,
  type JudgeDurableResult,
  type JudgeJobStreamMessage,
  type JudgeResultNotification,
} from '../src/queue.js';

describe('contratos de cola del juez y Redis Streams', () => {
  it('las constantes de stream, grupo y canal respetan doc 04', () => {
    expect(JUDGE_STREAM_KEY).toBe('judge:stream');
    expect(JUDGE_CONSUMER_GROUP).toBe('judges');
    expect(JUDGE_RESULTS_CHANNEL).toBe('judge:results');
    expect(JUDGE_STREAM_SCHEMA_VERSION).toBe(1);
  });

  it('valida mensajes de trabajo del juez en el stream', () => {
    const validJob: JudgeJobStreamMessage = {
      schema_version: 1,
      submission_id: 'sub-100',
      problem_id: 'prob-facil',
      problem_version: 1,
      language: 'python',
      source_code: 'print("hello")',
      time_limit_ms: 6000,
      memory_limit_mb: 256,
      cases_ref: '/var/duelodev/cases/prob-facil-v1',
      enqueued_at_ms: 1700000000000,
      request_id: 'req-abc',
    };

    expect(isJudgeJobStreamMessage(validJob)).toBe(true);

    // Faltan campos obligatorios
    expect(isJudgeJobStreamMessage({ submission_id: 'sub-100' })).toBe(false);
    expect(isJudgeJobStreamMessage(null)).toBe(false);
    expect(isJudgeJobStreamMessage('invalid')).toBe(false);
    expect(
      isJudgeJobStreamMessage({
        ...validJob,
        time_limit_ms: '6000', // debe ser number
      }),
    ).toBe(false);
  });

  it('valida notificaciones livianas de resultado en Redis Pub/Sub', () => {
    const validNotification: JudgeResultNotification = {
      submission_id: 'sub-100',
      match_id: 'match-1',
      round_id: 'round-1',
      user_id: 'user-1',
      verdict: 'AC',
      passed: 5,
      total: 5,
      exec_time_ms: 45,
      request_id: 'req-abc',
    };

    expect(isJudgeResultNotification(validNotification)).toBe(true);

    expect(isJudgeResultNotification({ submission_id: 'sub-100' })).toBe(false);
    expect(isJudgeResultNotification(undefined)).toBe(false);
    expect(
      isJudgeResultNotification({
        ...validNotification,
        passed: '5', // debe ser number
      }),
    ).toBe(false);
  });

  it('estructura del resultado durable en PostgreSQL', () => {
    const durableResult: JudgeDurableResult = {
      submission_id: 'sub-100',
      verdict: 'WA',
      passed: 3,
      total: 5,
      exec_time_ms: 120,
      judged_at: 1700000003000,
      compile_output: undefined,
      judge_error: undefined,
    };

    expect(durableResult.verdict).toBe('WA');
    expect(durableResult.passed).toBe(3);
    expect(durableResult.total).toBe(5);
  });
});
