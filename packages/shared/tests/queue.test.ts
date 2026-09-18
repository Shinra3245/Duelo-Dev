import { describe, expect, it } from 'vitest';
import {
  JUDGE_CONSUMER_GROUP,
  MATCH_CONTROL_CHANNEL,
  MATCH_CONTROL_SCHEMA_VERSION,
  JUDGE_RESULTS_CHANNEL,
  JUDGE_STREAM_KEY,
  JUDGE_STREAM_SCHEMA_VERSION,
  isMatchControlNotification,
  isJudgeDurableResult,
  isJudgeJobStreamMessage,
  isJudgeResultNotification,
  type JudgeDurableResult,
  type JudgeJobStreamMessage,
  type JudgeResultNotification,
} from '../src/queue.js';
import { SOURCE_CODE_MAX_BYTES } from '../src/limits.js';
import { MAX_COMPILE_OUTPUT_BYTES } from '../src/events.js';

describe('contratos de cola del juez y Redis Streams', () => {
  it('las constantes de stream, grupo y canal respetan doc 04', () => {
    expect(JUDGE_STREAM_KEY).toBe('judge:stream');
    expect(JUDGE_CONSUMER_GROUP).toBe('judges');
    expect(JUDGE_RESULTS_CHANNEL).toBe('judge:results');
    expect(JUDGE_STREAM_SCHEMA_VERSION).toBe(1);
    expect(MATCH_CONTROL_CHANNEL).toBe('match:control');
    expect(MATCH_CONTROL_SCHEMA_VERSION).toBe(1);
  });

  it('valida avisos internos de control administrativo sin aceptar datos incompletos', () => {
    const notification = {
      schema_version: MATCH_CONTROL_SCHEMA_VERSION,
      type: 'match_closed' as const,
      match_id: 'match-1',
      state_version: 2,
      issued_at_ms: 1700000000000,
    };

    expect(isMatchControlNotification(notification)).toBe(true);
    expect(isMatchControlNotification({ ...notification, state_version: 0 })).toBe(false);
    expect(isMatchControlNotification({ ...notification, type: 'unknown' })).toBe(false);
    expect(isMatchControlNotification({ ...notification, match_id: '' })).toBe(false);
    expect(isMatchControlNotification(null)).toBe(false);
  });

  it('valida mensajes de trabajo del juez en el stream e invariantes de seguridad', () => {
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

    // Invariante violado: lenguaje no soportado
    expect(isJudgeJobStreamMessage({ ...validJob, language: 'rust' })).toBe(false);

    // Invariante violado: schema_version distinta de 1
    expect(isJudgeJobStreamMessage({ ...validJob, schema_version: 2 })).toBe(false);

    // Invariante violado: código fuente superior a 64 KiB
    expect(
      isJudgeJobStreamMessage({
        ...validJob,
        source_code: 'a'.repeat(SOURCE_CODE_MAX_BYTES + 1),
      }),
    ).toBe(false);

    // Invariante violado: límites no positivos o inválidos
    expect(isJudgeJobStreamMessage({ ...validJob, time_limit_ms: 0 })).toBe(false);
    expect(isJudgeJobStreamMessage({ ...validJob, memory_limit_mb: -1 })).toBe(false);
    expect(isJudgeJobStreamMessage({ ...validJob, problem_version: 0 })).toBe(false);

    // Faltan campos obligatorios
    expect(isJudgeJobStreamMessage({ submission_id: 'sub-100' })).toBe(false);
    expect(isJudgeJobStreamMessage(null)).toBe(false);
    expect(isJudgeJobStreamMessage('invalid')).toBe(false);
  });

  it('valida notificaciones livianas de resultado en Redis Pub/Sub e invariantes', () => {
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

    // Invariante violado: passed > total
    expect(isJudgeResultNotification({ ...validNotification, passed: 6, total: 5 })).toBe(false);

    // Invariante violado: veredicto desconocido
    expect(
      isJudgeResultNotification({
        ...validNotification,
        verdict: 'UNKNOWN' as unknown,
      }),
    ).toBe(false);

    // Invariante violado: exec_time_ms negativo
    expect(isJudgeResultNotification({ ...validNotification, exec_time_ms: -1 })).toBe(false);

    expect(isJudgeResultNotification({ submission_id: 'sub-100' })).toBe(false);
    expect(isJudgeResultNotification(undefined)).toBe(false);
  });

  it('valida el resultado durable en PostgreSQL con guardia e invariantes', () => {
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

    expect(isJudgeDurableResult(durableResult)).toBe(true);

    // Invariante violado: passed > total
    expect(isJudgeDurableResult({ ...durableResult, passed: 7, total: 5 })).toBe(false);

    // Invariante violado: compile_output superior a 4 KiB
    expect(
      isJudgeDurableResult({
        ...durableResult,
        compile_output: 'x'.repeat(MAX_COMPILE_OUTPUT_BYTES + 1),
      }),
    ).toBe(false);

    // Invariante violado: veredicto no canónico
    expect(
      isJudgeDurableResult({
        ...durableResult,
        verdict: 'PASSED' as unknown,
      }),
    ).toBe(false);

    // Invariante violado: tiempo de ejecución negativo
    expect(isJudgeDurableResult({ ...durableResult, exec_time_ms: -5 })).toBe(false);
  });
});
