import { describe, expect, it } from 'vitest';
import {
  GAMERTAG_REGEX,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_WINDOW_S,
  isCreateSubmissionRequest,
  isSubmissionAcceptedResponse,
  isSubmissionDetailsResponse,
  isSubmissionStatus,
  isUserRole,
  isValidGamertag,
  type AuthUserResponse,
  type CreateRoomRequest,
  type CreateSubmissionRequest,
  type JoinRoomRequest,
  type JoinRoomResponse,
  type LoginRequest,
  type MatchSummaryResponse,
  type ProblemPublicResponse,
  type RegisterRequest,
  type RoomDetailsResponse,
  type StartRoomResponse,
  type SubmissionAcceptedResponse,
  type SubmissionDetailsResponse,
} from '../src/rest.js';
import { SOURCE_CODE_MAX_BYTES } from '../src/limits.js';
import { MAX_COMPILE_OUTPUT_BYTES } from '../src/events.js';

describe('contratos REST de /api/v1', () => {
  it('valida formato canónico de gamertags (3-20 alfanuméricos y guión medio)', () => {
    expect(GAMERTAG_REGEX).toBeInstanceOf(RegExp);
    expect(isValidGamertag('dev-1')).toBe(true);
    expect(isValidGamertag('Alice99')).toBe(true);
    expect(isValidGamertag('abc')).toBe(true);
    expect(isValidGamertag('a'.repeat(20))).toBe(true);

    // Inválidos
    expect(isValidGamertag('ab')).toBe(false); // muy corto
    expect(isValidGamertag('a'.repeat(21))).toBe(false); // muy largo
    expect(isValidGamertag('user_name')).toBe(false); // guion bajo no permitido
    expect(isValidGamertag('user name')).toBe(false); // espacio no permitido
    expect(isValidGamertag('user@host')).toBe(false); // caracteres especiales
    expect(isValidGamertag('')).toBe(false);
  });

  it('valida roles de usuario y estados de envío', () => {
    expect(isUserRole('user')).toBe(true);
    expect(isUserRole('guest')).toBe(true);
    expect(isUserRole('admin')).toBe(false);

    expect(isSubmissionStatus('queued')).toBe(true);
    expect(isSubmissionStatus('judging')).toBe(true);
    expect(isSubmissionStatus('completed')).toBe(true);
    expect(isSubmissionStatus('failed')).toBe(false);
  });

  it('constantes de idempotencia definidas según doc 04', () => {
    expect(IDEMPOTENCY_KEY_HEADER).toBe('idempotency-key');
    expect(IDEMPOTENCY_WINDOW_S).toBe(60);
  });

  it('estructura de request y response de autenticación', () => {
    const registerReq: RegisterRequest = {
      email: 'coder@duelodev.com',
      password: 'secretPassword123',
      gamertag: 'coder-pro',
    };
    expect(registerReq.email).toBe('coder@duelodev.com');

    const loginReq: LoginRequest = {
      email: 'coder@duelodev.com',
      password: 'secretPassword123',
    };
    expect(loginReq.password).toBe('secretPassword123');

    const authRes: AuthUserResponse = {
      user: {
        id: 'u-123',
        email: 'coder@duelodev.com',
        gamertag: 'coder-pro',
        role: 'user',
        created_at: '2026-09-12T00:00:00Z',
      },
    };
    expect(authRes.user.role).toBe('user');
  });

  it('estructura de request y response para salas y lobby', () => {
    const createReq: CreateRoomRequest = {
      config: {
        mode: 'puntos',
        num_problems: 3,
        time_per_problem_s: 180,
        categories: ['facil'],
        max_players: 2,
      },
    };
    expect(createReq.config.mode).toBe('puntos');

    const joinReq: JoinRoomRequest = {
      gamertag: 'challenger-1',
    };
    expect(joinReq.gamertag).toBe('challenger-1');

    const joinRes: JoinRoomResponse = {
      match_id: 'm-abc',
      user_id: 'u-guest',
      gamertag: 'challenger-1',
      role: 'player',
      room_code: 'ROOM42',
    };
    expect(joinRes.role).toBe('player');

    const detailsRes: RoomDetailsResponse = {
      match_id: 'm-abc',
      room_code: 'ROOM42',
      status: 'lobby',
      config: createReq.config,
      host_id: 'u-host',
      players: [
        { user_id: 'u-host', gamertag: 'host-player', is_ready: true, is_host: true },
        { user_id: 'u-guest', gamertag: 'challenger-1', is_ready: false, is_host: false },
      ],
      created_at: '2026-09-12T01:00:00Z',
    };
    expect(detailsRes.players).toHaveLength(2);

    const startRes: StartRoomResponse = {
      match_id: 'm-abc',
      started: true,
      status: 'running',
    };
    expect(startRes.started).toBe(true);
  });

  it('estructura de envío y consulta de resultado con guardias de invariantes', () => {
    const subReq: CreateSubmissionRequest = {
      match_id: 'm-1',
      round_id: 'r-1',
      problem_id: 'prob-suma',
      language: 'python',
      source_code: 'print(sum(map(int, input().split())))',
    };
    expect(isCreateSubmissionRequest(subReq)).toBe(true);

    // Invariante violado: código fuente mayor a 64 KiB
    expect(
      isCreateSubmissionRequest({
        ...subReq,
        source_code: 'a'.repeat(SOURCE_CODE_MAX_BYTES + 1),
      }),
    ).toBe(false);

    // Invariante violado: lenguaje desconocido
    expect(
      isCreateSubmissionRequest({
        ...subReq,
        language: 'ruby' as unknown,
      }),
    ).toBe(false);

    const subAccepted: SubmissionAcceptedResponse = {
      submission_id: 'sub-789',
      match_id: 'm-1',
      round_id: 'r-1',
      problem_id: 'prob-suma',
      admission_seq: 1,
      received_at: 1700000000000,
      status: 'queued',
    };
    expect(isSubmissionAcceptedResponse(subAccepted)).toBe(true);
    expect(isSubmissionAcceptedResponse({ ...subAccepted, admission_seq: 0 })).toBe(false);

    const subDetails: SubmissionDetailsResponse = {
      submission_id: 'sub-789',
      match_id: 'm-1',
      round_id: 'r-1',
      problem_id: 'prob-suma',
      language: 'python',
      status: 'completed',
      verdict: 'AC',
      passed: 12,
      total: 12,
      exec_time_ms: 85,
      received_at: 1700000000000,
      judged_at: 1700000001500,
    };
    expect(isSubmissionDetailsResponse(subDetails)).toBe(true);

    // Invariante violado: passed > total
    expect(isSubmissionDetailsResponse({ ...subDetails, passed: 13, total: 12 })).toBe(false);

    // Invariante violado: compile_output > 4 KiB
    expect(
      isSubmissionDetailsResponse({
        ...subDetails,
        compile_output: 'x'.repeat(MAX_COMPILE_OUTPUT_BYTES + 1),
      }),
    ).toBe(false);

    // Invariante violado: exec_time_ms negativo
    expect(isSubmissionDetailsResponse({ ...subDetails, exec_time_ms: -1 })).toBe(false);
  });

  it('estructura de problema público sin revelar casos ocultos', () => {
    const problemRes: ProblemPublicResponse = {
      problem_id: 'prob-suma',
      title: 'Suma de dos números',
      description: 'Dado dos enteros en una línea, imprime su suma.',
      time_limit_ms: 2000,
      memory_limit_mb: 256,
      examples: [{ input: '2 3\n', output: '5\n', explanation: '2 + 3 = 5' }],
    };
    expect(problemRes.examples).toHaveLength(1);
    expect((problemRes as Record<string, unknown>).test_cases).toBeUndefined();
  });

  it('estructura de resumen final de partida con snapshots y múltiples ganadores', () => {
    const summary: MatchSummaryResponse = {
      match_id: 'm-1',
      mode: 'puntos',
      status: 'finished',
      finish_reason: 'problems_exhausted',
      winner_ids: ['u-1'],
      final_scores: [
        {
          user_id: 'u-1',
          gamertag: 'alice',
          score: 3,
          cases_total: 30,
          time_total_ms: 12000,
          current_problem_idx: 3,
        },
      ],
      started_at: '2026-09-12T02:00:00Z',
      finished_at: '2026-09-12T02:15:00Z',
      snapshots: [
        {
          user_id: 'u-1',
          round_id: 'r-1',
          problem_id: 'p-1',
          language: 'cpp',
          source_code: '#include <iostream>\nint main(){return 0;}',
          captured_at: '2026-09-12T02:05:00Z',
        },
      ],
    };
    expect(summary.finish_reason).toBe('problems_exhausted');
    expect(summary.snapshots).toHaveLength(1);
  });
});
