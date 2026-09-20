import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  ERROR_CODES,
  type ApiError,
  type AuthUserResponse,
  type ProblemPublicResponse,
  type RoomCreatedResponse,
  type SubmissionAcceptedResponse,
  type SubmissionDetailsResponse,
} from '@duelodev/shared';
import { createApp, type ApiApp } from '../src/app.js';
import { AUTH_COOKIE_NAMES } from '../src/plugins/cookies.js';

describe('Submissions and Problems REST API (/api/v1)', () => {
  let app: ApiApp;
  let baseUrl: string;

  const testProblemId = randomUUID();
  const testRoundId = randomUUID();

  const validPuntosConfig = {
    mode: 'puntos' as const,
    max_players: 2,
    categories: ['facil' as const],
    num_problems: 3,
    time_per_problem_s: 60,
  };

  beforeAll(async () => {
    app = createApp({
      serviceName: 'api-submissions-test',
      authSecret: 'test-submission-secret-duelodev-1234567890',
      rateLimitConfig: { enabled: false },
    });

    // Cargar problema y casos de prueba (públicos y ocultos)
    await app.ctx.problemRepo.createProblem({
      id: testProblemId,
      title: 'Suma Simple',
      description: 'Calcula la suma de dos enteros a y b.',
      time_limit_ms: 1000,
      memory_limit_mb: 128,
      category: 'facil',
      created_at: new Date().toISOString(),
    });

    await app.ctx.problemRepo.createTestCase({
      id: randomUUID(),
      problem_id: testProblemId,
      input: '1 2\n',
      expected_output: '3\n',
      is_example: true,
      order_idx: 1,
    });

    await app.ctx.problemRepo.createTestCase({
      id: randomUUID(),
      problem_id: testProblemId,
      input: '100 200\n',
      expected_output: '300\n',
      is_example: true,
      order_idx: 2,
    });

    // Caso de prueba oculto (NUNCA debe revelarse en /problems/:id/public)
    await app.ctx.problemRepo.createTestCase({
      id: randomUUID(),
      problem_id: testProblemId,
      input: '999999999 1\n',
      expected_output: '1000000000\n',
      is_example: false,
      order_idx: 3,
    });

    await app.start(0, '127.0.0.1');
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function extractCookies(res: Response): Record<string, string> {
    const rawCookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie') ?? ''];

    const result: Record<string, string> = {};
    for (const str of rawCookies) {
      if (!str) continue;
      const firstPart = str.split(';')[0];
      if (firstPart) {
        const idx = firstPart.indexOf('=');
        if (idx > 0) {
          const key = firstPart.slice(0, idx).trim();
          const val = firstPart.slice(idx + 1).trim();
          result[key] = decodeURIComponent(val);
        }
      }
    }
    return result;
  }

  async function registerUser(
    email: string,
    gamertag: string,
  ): Promise<{ accessToken: string; userId: string; cookieHeader: string }> {
    const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'Password123!',
        gamertag,
      }),
    });
    const data = (await res.json()) as AuthUserResponse;
    const cookies = extractCookies(res);
    const token = cookies[AUTH_COOKIE_NAMES.ACCESS_TOKEN]!;
    return {
      accessToken: token,
      userId: data.user.id,
      cookieHeader: `${AUTH_COOKIE_NAMES.ACCESS_TOKEN}=${token}`,
    };
  }

  describe('POST /api/v1/submissions', () => {
    it('rechaza con 401 si no hay autenticación', async () => {
      const res = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          match_id: randomUUID(),
          round_id: testRoundId,
          problem_id: testProblemId,
          language: 'python',
          source_code: 'print(3)',
        }),
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.UNAUTHENTICATED);
    });

    it('rechaza con 405 si el método no es POST', async () => {
      const user = await registerUser('sub-meth@test.com', 'SubMethodTester');
      const res = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'GET',
        headers: { Cookie: user.cookieHeader },
      });

      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    });

    it('rechaza con 400 si la carga útil no es válida', async () => {
      const user = await registerUser('sub-val@test.com', 'SubValTester');

      // Falta language
      const res1 = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: user.cookieHeader,
        },
        body: JSON.stringify({
          match_id: randomUUID(),
          round_id: testRoundId,
          problem_id: testProblemId,
          source_code: 'print(1)',
        }),
      });
      expect(res1.status).toBe(400);

      // Lenguaje no soportado
      const res2 = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: user.cookieHeader,
        },
        body: JSON.stringify({
          match_id: randomUUID(),
          round_id: testRoundId,
          problem_id: testProblemId,
          language: 'ruby',
          source_code: 'puts 1',
        }),
      });
      expect(res2.status).toBe(400);

      // Código vacío
      const res3 = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: user.cookieHeader,
        },
        body: JSON.stringify({
          match_id: randomUUID(),
          round_id: testRoundId,
          problem_id: testProblemId,
          language: 'python',
          source_code: '',
        }),
      });
      expect(res3.status).toBe(400);
    });

    it('rechaza si el código fuente excede 64 KiB', async () => {
      const user = await registerUser('sub-large@test.com', 'SubLargeTester');
      const hugeCode = 'a'.repeat(65 * 1024);

      const res = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: user.cookieHeader,
        },
        body: JSON.stringify({
          match_id: randomUUID(),
          round_id: testRoundId,
          problem_id: testProblemId,
          language: 'python',
          source_code: hugeCode,
        }),
      });

      // Debe ser rechazado por tamaño (400 por validación de esquema o 413 por body parser)
      expect([400, 413]).toContain(res.status);
    });

    it('rechaza con 404 si la partida no existe', async () => {
      const user = await registerUser('sub-notfound@test.com', 'SubNotFound');
      const res = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: user.cookieHeader,
        },
        body: JSON.stringify({
          match_id: randomUUID(),
          round_id: testRoundId,
          problem_id: testProblemId,
          language: 'python',
          source_code: 'print(42)',
        }),
      });

      expect(res.status).toBe(404);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.ROOM_NOT_FOUND);
    });

    it('rechaza con 409 si la partida está en lobby (no iniciada)', async () => {
      const host = await registerUser('sub-lobby-host@test.com', 'SubLobbyHost');
      const createRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: host.cookieHeader,
        },
        body: JSON.stringify({
          config: validPuntosConfig,
        }),
      });
      const room = (await createRes.json()) as RoomCreatedResponse;

      const subRes = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: host.cookieHeader,
        },
        body: JSON.stringify({
          match_id: room.match_id,
          round_id: testRoundId,
          problem_id: testProblemId,
          language: 'python',
          source_code: 'print(42)',
        }),
      });

      expect(subRes.status).toBe(409);
      const data = (await subRes.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.CONFLICT);
    });

    it('rechaza con 403 NOT_A_PLAYER si el usuario no pertenece a la partida', async () => {
      const host = await registerUser('sub-nop-host@test.com', 'SubNopHost');
      const outsider = await registerUser('sub-outsider@test.com', 'SubOutsider');
      const player2 = await registerUser('sub-nop-p2@test.com', 'SubNopP2');

      const createRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: host.cookieHeader,
        },
        body: JSON.stringify({
          config: validPuntosConfig,
        }),
      });
      const room = (await createRes.json()) as RoomCreatedResponse;

      // Unir p2 y arrancar partida
      await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/join`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: player2.cookieHeader,
        },
        body: JSON.stringify({ gamertag: 'SubNopP2' }),
      });
      await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/start`, {
        method: 'POST',
        headers: { Cookie: host.cookieHeader },
      });

      // Outsider intenta enviar solución
      const subRes = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: outsider.cookieHeader,
        },
        body: JSON.stringify({
          match_id: room.match_id,
          round_id: testRoundId,
          problem_id: testProblemId,
          language: 'python',
          source_code: 'print("hacked")',
        }),
      });

      expect(subRes.status).toBe(403);
      const data = (await subRes.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.NOT_A_PLAYER);
    });

    it('rechaza con 403 a un jugador que ya abandonó la partida', async () => {
      const player = await registerUser('sub-left@test.com', 'SubLeftPlayer');
      const match = await app.ctx.roomRepo.createMatch({
        room_code: randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase(),
        mode: 'puntos',
        status: 'running',
        config: validPuntosConfig,
        host_id: player.userId,
      });
      await app.ctx.roomRepo.addPlayer({
        match_id: match.id,
        user_id: player.userId,
        connection_status: 'left',
        left_at: new Date().toISOString(),
      });

      const response = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Cookie: player.cookieHeader },
        body: JSON.stringify({
          match_id: match.id,
          round_id: testRoundId,
          problem_id: testProblemId,
          language: 'python',
          source_code: 'print("late")',
        }),
      });

      expect(response.status).toBe(403);
      expect(((await response.json()) as ApiError).error.code).toBe(ERROR_CODES.NOT_A_PLAYER);
      expect(await app.ctx.submissionRepo.findSubmissionsByMatch(match.id)).toHaveLength(0);
    });

    it('revalida la membresía justo antes de persistir frente a una salida concurrente', async () => {
      const player = await registerUser('sub-race-left@test.com', 'SubRaceLeft');
      const match = await app.ctx.roomRepo.createMatch({
        room_code: randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase(),
        mode: 'puntos',
        status: 'running',
        config: validPuntosConfig,
        host_id: player.userId,
      });
      const matchPlayer = await app.ctx.roomRepo.addPlayer({
        match_id: match.id,
        user_id: player.userId,
      });
      const createIfActive = app.ctx.submissionRepo.createSubmissionForActivePlayer.bind(
        app.ctx.submissionRepo,
      );
      vi.spyOn(app.ctx.submissionRepo, 'createSubmissionForActivePlayer').mockImplementationOnce(
        async (input) => {
          await app.ctx.roomRepo.updatePlayer(matchPlayer.id, {
            connection_status: 'left',
            left_at: new Date().toISOString(),
          });
          return createIfActive(input);
        },
      );

      const response = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Cookie: player.cookieHeader },
        body: JSON.stringify({
          match_id: match.id,
          round_id: testRoundId,
          problem_id: testProblemId,
          language: 'python',
          source_code: 'print("racing leave")',
        }),
      });

      expect(response.status).toBe(403);
      expect(((await response.json()) as ApiError).error.code).toBe(ERROR_CODES.NOT_A_PLAYER);
      expect(await app.ctx.submissionRepo.findSubmissionsByMatch(match.id)).toHaveLength(0);
    });

    it('rechaza envíos durante la ventana de instrucciones sin consumir el cooldown', async () => {
      const host = await registerUser('sub-instructions-host@test.com', 'SubInstructionsHost');
      const rival = await registerUser('sub-instructions-rival@test.com', 'SubInstructionsRival');
      const createRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: host.cookieHeader,
        },
        body: JSON.stringify({ config: validPuntosConfig }),
      });
      const room = (await createRes.json()) as RoomCreatedResponse;
      await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/join`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: rival.cookieHeader,
        },
        body: JSON.stringify({ gamertag: 'SubInstructionsRival' }),
      });
      await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/start`, {
        method: 'POST',
        headers: { Cookie: host.cookieHeader },
      });
      await app.ctx.roomRepo.updateMatch(room.match_id, {
        instructions_ends_at: new Date(Date.now() + 30_000).toISOString(),
      });

      const payload = {
        match_id: room.match_id,
        round_id: testRoundId,
        problem_id: testProblemId,
        language: 'python',
        source_code: 'print("ready")',
      };
      const early = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Cookie: host.cookieHeader },
        body: JSON.stringify(payload),
      });
      expect(early.status).toBe(409);
      expect(((await early.json()) as ApiError).error.code).toBe(
        ERROR_CODES.MATCH_INSTRUCTIONS_ACTIVE,
      );

      await app.ctx.roomRepo.updateMatch(room.match_id, {
        instructions_ends_at: new Date(Date.now() - 1_000).toISOString(),
      });
      const onTime = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Cookie: host.cookieHeader },
        body: JSON.stringify(payload),
      });
      expect(onTime.status).toBe(202);
    });

    it('admite el envío exitosamente con 202 Accepted, secuencia atómica e idempotencia', async () => {
      const host = await registerUser('sub-ok-host@test.com', 'SubOkHost');
      const guest = await registerUser('sub-ok-guest@test.com', 'SubOkGuest');

      const createRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: host.cookieHeader,
        },
        body: JSON.stringify({
          config: validPuntosConfig,
        }),
      });
      const room = (await createRes.json()) as RoomCreatedResponse;

      await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/join`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: guest.cookieHeader,
        },
        body: JSON.stringify({ gamertag: 'SubOkGuest' }),
      });

      await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/start`, {
        method: 'POST',
        headers: { Cookie: host.cookieHeader },
      });

      const submissionPayload = {
        match_id: room.match_id,
        round_id: testRoundId,
        problem_id: testProblemId,
        language: 'python' as const,
        source_code: 'print("solution")',
      };

      const idempotencyKey = 'idem-sub-key-1';

      // Primer envío con Idempotency-Key
      const subRes1 = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: host.cookieHeader,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(submissionPayload),
      });

      expect(subRes1.status).toBe(202);
      const subData1 = (await subRes1.json()) as SubmissionAcceptedResponse;
      expect(subData1.status).toBe('queued');
      expect(subData1.admission_seq).toBe(1);
      expect(subData1.match_id).toBe(room.match_id);
      expect(subData1.problem_id).toBe(testProblemId);
      expect(typeof subData1.submission_id).toBe('string');
      expect(typeof subData1.received_at).toBe('number');

      // Reintento idéntico con la misma clave de idempotencia -> debe retornar misma respuesta sin consumir cooldown
      const subResIdem = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: host.cookieHeader,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(submissionPayload),
      });

      expect(subResIdem.status).toBe(202);
      const subDataIdem = (await subResIdem.json()) as SubmissionAcceptedResponse;
      expect(subDataIdem.submission_id).toBe(subData1.submission_id);
      expect(subDataIdem.admission_seq).toBe(1);

      // Reintento con misma clave pero cuerpo diferente -> 409 CONFLICT
      const subResConflict = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: host.cookieHeader,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          ...submissionPayload,
          source_code: 'print("different")',
        }),
      });
      expect(subResConflict.status).toBe(409);
      const conflictData = (await subResConflict.json()) as ApiError;
      expect(conflictData.error.code).toBe(ERROR_CODES.CONFLICT);

      // Intento inmediato con clave distinta (o sin clave) por el mismo host -> 429 SUBMIT_COOLDOWN
      const subResCooldown = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: host.cookieHeader,
          'Idempotency-Key': 'idem-sub-key-2',
        },
        body: JSON.stringify(submissionPayload),
      });
      expect(subResCooldown.status).toBe(429);
      const cooldownData = (await subResCooldown.json()) as ApiError;
      expect(cooldownData.error.code).toBe(ERROR_CODES.SUBMIT_COOLDOWN);
      expect(cooldownData.error.details).toBeDefined();

      // En cambio, el segundo jugador (guest) que NO ha enviado código puede enviar su envío
      const guestSubRes = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: guest.cookieHeader,
        },
        body: JSON.stringify({
          match_id: room.match_id,
          round_id: testRoundId,
          problem_id: testProblemId,
          language: 'cpp',
          source_code: 'int main() { return 0; }',
        }),
      });

      expect(guestSubRes.status).toBe(202);
      const guestSubData = (await guestSubRes.json()) as SubmissionAcceptedResponse;
      expect(guestSubData.admission_seq).toBe(2);
      expect(guestSubData.status).toBe('queued');
    });

    it('criterio F2: 5 envíos concurrentes del mismo jugador -> exactamente 1 admitido y 4 con 429', async () => {
      const host = await registerUser('sub-conc-host@test.com', 'SubConcHost');
      const guest = await registerUser('sub-conc-guest@test.com', 'SubConcGuest');

      const createRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: host.cookieHeader,
        },
        body: JSON.stringify({ config: validPuntosConfig }),
      });
      const room = (await createRes.json()) as RoomCreatedResponse;

      await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/join`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: guest.cookieHeader,
        },
        body: JSON.stringify({ gamertag: 'SubConcGuest' }),
      });

      await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/start`, {
        method: 'POST',
        headers: { Cookie: host.cookieHeader },
      });

      // Disparar 5 peticiones simultáneas con Promise.all
      const requests = Array.from({ length: 5 }, (_, i) =>
        fetch(`${baseUrl}/api/v1/submissions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Cookie: host.cookieHeader,
          },
          body: JSON.stringify({
            match_id: room.match_id,
            round_id: testRoundId,
            problem_id: testProblemId,
            language: 'python',
            source_code: `print("concurrent-${i}")`,
          }),
        }),
      );

      const responses = await Promise.all(requests);
      const statuses = responses.map((r) => r.status);

      const accepted = statuses.filter((s) => s === 202);
      const throttled = statuses.filter((s) => s === 429);

      expect(accepted).toHaveLength(1);
      expect(throttled).toHaveLength(4);
    });
  });

  describe('GET /api/v1/submissions/:id', () => {
    it('rechaza con 401 si no está autenticado', async () => {
      const res = await fetch(`${baseUrl}/api/v1/submissions/${randomUUID()}`);
      expect(res.status).toBe(401);
    });

    it('rechaza con 405 si el método no es GET ni HEAD', async () => {
      const user = await registerUser('sub-get-meth@test.com', 'SubGetMeth');
      const res = await fetch(`${baseUrl}/api/v1/submissions/${randomUUID()}`, {
        method: 'POST',
        headers: { Cookie: user.cookieHeader },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
    });

    it('rechaza con 404 si el envío no existe', async () => {
      const user = await registerUser('sub-get-404@test.com', 'SubGet404');
      const res = await fetch(`${baseUrl}/api/v1/submissions/${randomUUID()}`, {
        headers: { Cookie: user.cookieHeader },
      });
      expect(res.status).toBe(404);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.NOT_FOUND);
    });

    it('rechaza con 403 si un usuario distinto al autor consulta el envío', async () => {
      const author = await registerUser('sub-author@test.com', 'SubAuthor');
      const spy = await registerUser('sub-spy@test.com', 'SubSpy');
      const dummyMatchId = randomUUID();

      const submission = await app.ctx.submissionRepo.createSubmission({
        match_id: dummyMatchId,
        round_id: testRoundId,
        user_id: author.userId,
        problem_id: testProblemId,
        language: 'python',
        source_code: 'def solve(): pass',
        time_limit_ms: 1000,
        memory_limit_mb: 128,
        admission_seq: 1,
        status: 'queued',
      });

      // El espía no tiene derecho a ver el envío del autor
      const res = await fetch(`${baseUrl}/api/v1/submissions/${submission.id}`, {
        headers: { Cookie: spy.cookieHeader },
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('retorna 200 OK y detalles completos para el dueño del envío', async () => {
      const owner = await registerUser('sub-owner@test.com', 'SubOwner');
      const dummyMatchId = randomUUID();

      const submission = await app.ctx.submissionRepo.createSubmission({
        match_id: dummyMatchId,
        round_id: testRoundId,
        user_id: owner.userId,
        problem_id: testProblemId,
        language: 'python',
        source_code: 'print(10)',
        time_limit_ms: 1000,
        memory_limit_mb: 128,
        admission_seq: 1,
        status: 'completed',
        verdict: 'AC',
        passed_cases: 3,
        total_cases: 3,
        exec_time_ms: 45,
        compile_output: 'Built successfully',
      });

      const res = await fetch(`${baseUrl}/api/v1/submissions/${submission.id}`, {
        headers: { Cookie: owner.cookieHeader },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as SubmissionDetailsResponse;
      expect(data.submission_id).toBe(submission.id);
      expect(data.status).toBe('completed');
      expect(data.verdict).toBe('AC');
      expect(data.passed).toBe(3);
      expect(data.total).toBe(3);
      expect(data.exec_time_ms).toBe(45);
      expect(data.compile_output).toBe('Built successfully');
      expect(typeof data.received_at).toBe('number');

      // Soporte para HEAD
      const headRes = await fetch(`${baseUrl}/api/v1/submissions/${submission.id}`, {
        method: 'HEAD',
        headers: { Cookie: owner.cookieHeader },
      });
      expect(headRes.status).toBe(200);
    });
  });

  describe('GET /api/v1/problems/:id/public', () => {
    it('rechaza con 401 si no está autenticado', async () => {
      const res = await fetch(`${baseUrl}/api/v1/problems/${testProblemId}/public`);
      expect(res.status).toBe(401);
    });

    it('rechaza con 405 si el método no es GET ni HEAD', async () => {
      const user = await registerUser('prob-meth@test.com', 'ProbMeth');
      const res = await fetch(`${baseUrl}/api/v1/problems/${testProblemId}/public`, {
        method: 'POST',
        headers: { Cookie: user.cookieHeader },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
    });

    it('rechaza con 404 si el problema no existe', async () => {
      const user = await registerUser('prob-404@test.com', 'Prob404');
      const res = await fetch(`${baseUrl}/api/v1/problems/${randomUUID()}/public`, {
        headers: { Cookie: user.cookieHeader },
      });
      expect(res.status).toBe(404);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.NOT_FOUND);
    });

    it('retorna 200 OK con metadata y ejemplos públicos sin revelar casos ocultos', async () => {
      const user = await registerUser('prob-ok@test.com', 'ProbOk');
      const res = await fetch(`${baseUrl}/api/v1/problems/${testProblemId}/public`, {
        headers: { Cookie: user.cookieHeader },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as ProblemPublicResponse;
      expect(data.problem_id).toBe(testProblemId);
      expect(data.category).toBe('facil');
      expect(data.title).toBe('Suma Simple');
      expect(data.description).toBe('Calcula la suma de dos enteros a y b.');
      expect(data.time_limit_ms).toBe(1000);
      expect(data.memory_limit_mb).toBe(128);

      // Invariante de seguridad crítico: Solo 2 ejemplos públicos, el caso oculto (is_example: false) no debe existir
      expect(data.examples).toHaveLength(2);
      expect(data.examples[0]).toEqual({
        input: '1 2\n',
        output: '3\n',
      });
      expect(data.examples[1]).toEqual({
        input: '100 200\n',
        output: '300\n',
      });

      // Verificar que ningún caso contenga el input oculto
      const hasHiddenCase = data.examples.some((ex) => ex.input.includes('999999999'));
      expect(hasHiddenCase).toBe(false);

      // Verificar HEAD
      const headRes = await fetch(`${baseUrl}/api/v1/problems/${testProblemId}/public`, {
        method: 'HEAD',
        headers: { Cookie: user.cookieHeader },
      });
      expect(headRes.status).toBe(200);
    });
  });
});
