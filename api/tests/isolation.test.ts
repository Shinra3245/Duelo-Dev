import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  ERROR_CODES,
  ERROR_MESSAGES,
  type ApiError,
  type AuthUserResponse,
  type JoinRoomResponse,
  type LogoutResponse,
  type MatchSummaryResponse,
  type PuntosMatchConfig,
  type RoomCreatedResponse,
  type RoomDetailsResponse,
  type StartRoomResponse,
  type SubmissionAcceptedResponse,
} from '@duelodev/shared';
import { createApp, type ApiApp } from '../src/app.js';
import { AUTH_COOKIE_NAMES } from '../src/plugins/cookies.js';

describe('Aislamiento y Seguridad Multijugador (doc 04 §2, §5 y doc 06)', () => {
  let app: ApiApp;
  let baseUrl: string;

  const testProblemId = randomUUID();
  const testRoundId = randomUUID();

  const standardPuntosConfig: PuntosMatchConfig = {
    mode: 'puntos',
    max_players: 3,
    categories: ['facil'],
    num_problems: 2,
    time_per_problem_s: 60,
  };

  beforeAll(async () => {
    app = createApp({
      serviceName: 'api-isolation-test',
      authSecret: 'test-isolation-secret-duelodev-1234567890',
    });

    // Cargar problema piloto con casos de prueba públicos y ocultos
    await app.ctx.problemRepo.createProblem({
      id: testProblemId,
      title: 'Aislamiento de Cómputo',
      description: 'Calcula el producto de dos números sin interferencia de estado.',
      time_limit_ms: 1000,
      memory_limit_mb: 128,
      category: 'facil',
      created_at: new Date().toISOString(),
    });

    await app.ctx.problemRepo.createTestCase({
      id: randomUUID(),
      problem_id: testProblemId,
      input: '2 3\n',
      expected_output: '6\n',
      is_example: true,
      order_idx: 1,
    });

    await app.ctx.problemRepo.createTestCase({
      id: randomUUID(),
      problem_id: testProblemId,
      input: '10 10\n',
      expected_output: '100\n',
      is_example: false,
      order_idx: 2,
    });

    await app.start(0, '127.0.0.1');
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
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
  ): Promise<{ accessToken: string; refreshToken: string; userId: string; cookieHeader: string }> {
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
    const refresh = cookies[AUTH_COOKIE_NAMES.REFRESH_TOKEN]!;
    return {
      accessToken: token,
      refreshToken: refresh,
      userId: data.user.id,
      cookieHeader: `${AUTH_COOKIE_NAMES.ACCESS_TOKEN}=${token}; ${AUTH_COOKIE_NAMES.REFRESH_TOKEN}=${refresh}`,
    };
  }

  interface GuestSession {
    userId: string;
    accessToken: string;
    refreshToken: string;
    cookieHeader: string;
    gamertag: string;
  }

  async function joinAsGuest(roomCode: string, gamertag: string): Promise<GuestSession> {
    const res = await fetch(`${baseUrl}/api/v1/rooms/${roomCode}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gamertag }),
    });

    if (res.status !== 200) {
      const err = (await res.json()) as ApiError;
      throw new Error(`Failed to join room: ${res.status} ${err.error.code}`);
    }

    const data = (await res.json()) as JoinRoomResponse;
    const cookies = extractCookies(res);
    const accessToken = cookies[AUTH_COOKIE_NAMES.ACCESS_TOKEN]!;
    const refreshToken = cookies[AUTH_COOKIE_NAMES.REFRESH_TOKEN]!;

    return {
      userId: data.user_id,
      accessToken,
      refreshToken,
      cookieHeader: `${AUTH_COOKIE_NAMES.ACCESS_TOKEN}=${accessToken}; ${AUTH_COOKIE_NAMES.REFRESH_TOKEN}=${refreshToken}`,
      gamertag: data.gamertag,
    };
  }

  // =========================================================================
  // 1. Identidad y Sesiones Separadas
  // =========================================================================
  describe('1. Identidad y Sesiones Separadas (Aislamiento Guest A/B)', () => {
    it('Guest A y Guest B reciben UUIDs distintos, cookies separadas y access tokens únicos al unirse a una sala', async () => {
      const host = await registerUser('host-ident@test.com', 'host-ident');

      const roomRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${host.accessToken}`,
        },
        body: JSON.stringify({ config: standardPuntosConfig }),
      });
      expect(roomRes.status).toBe(201);
      const room = (await roomRes.json()) as RoomCreatedResponse;

      // Guest A se une
      const guestA = await joinAsGuest(room.room_code, 'guest-alpha');
      // Guest B se une
      const guestB = await joinAsGuest(room.room_code, 'guest-beta');

      // UUIDs estrictamente distintos
      expect(guestA.userId).toBeDefined();
      expect(guestB.userId).toBeDefined();
      expect(guestA.userId).not.toBe(guestB.userId);

      // Tokens y cookies completamente disjuntos
      expect(guestA.accessToken).toBeDefined();
      expect(guestB.accessToken).toBeDefined();
      expect(guestA.accessToken).not.toBe(guestB.accessToken);

      expect(guestA.refreshToken).toBeDefined();
      expect(guestB.refreshToken).toBeDefined();
      expect(guestA.refreshToken).not.toBe(guestB.refreshToken);

      // Verificación en repositorio de usuarios: ambos tienen role: 'guest', email nulo
      const userA = await app.ctx.userRepo.findById(guestA.userId);
      const userB = await app.ctx.userRepo.findById(guestB.userId);
      expect(userA?.role).toBe('guest');
      expect(userA?.email).toBeNull();
      expect(userB?.role).toBe('guest');
      expect(userB?.email).toBeNull();
    });

    it('los tokens de Guest A no pueden autenticar peticiones pretendiendo ser Guest B ni acceder a recursos privativos', async () => {
      const host = await registerUser('host-sec@test.com', 'host-sec');
      const roomRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${host.accessToken}`,
        },
        body: JSON.stringify({ config: standardPuntosConfig }),
      });
      const room = (await roomRes.json()) as RoomCreatedResponse;

      const guestA = await joinAsGuest(room.room_code, 'sec-guest-a');
      const guestB = await joinAsGuest(room.room_code, 'sec-guest-b');

      // Iniciar la sala para permitir envíos
      await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${host.accessToken}` },
      });

      // Guest B envía una solución privada
      const subBRes = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${guestB.accessToken}`,
        },
        body: JSON.stringify({
          match_id: room.match_id,
          round_id: testRoundId,
          problem_id: testProblemId,
          language: 'python',
          source_code: 'print("confidential-b")',
        }),
      });
      expect(subBRes.status).toBe(202);
      const subBData = (await subBRes.json()) as SubmissionAcceptedResponse;

      // Guest B puede consultar su propia sumisión
      const getBRes = await fetch(`${baseUrl}/api/v1/submissions/${subBData.submission_id}`, {
        headers: { Authorization: `Bearer ${guestB.accessToken}` },
      });
      expect(getBRes.status).toBe(200);

      // Guest A intenta acceder al envío privativo de Guest B -> debe ser denegado con 403 FORBIDDEN
      const getARes = await fetch(`${baseUrl}/api/v1/submissions/${subBData.submission_id}`, {
        headers: { Authorization: `Bearer ${guestA.accessToken}` },
      });
      expect(getARes.status).toBe(403);
      const errA = (await getARes.json()) as ApiError;
      expect(errA.error.code).toBe(ERROR_CODES.FORBIDDEN);

      // Intento de manipular el token de Guest A cambiando la firma o cabecera -> 401 UNAUTHENTICATED
      const tamperedToken = `${guestA.accessToken.slice(0, -5)}XXXXX`;
      const tamperedRes = await fetch(`${baseUrl}/api/v1/submissions/${subBData.submission_id}`, {
        headers: { Authorization: `Bearer ${tamperedToken}` },
      });
      expect(tamperedRes.status).toBe(401);
      const errTampered = (await tamperedRes.json()) as ApiError;
      expect(errTampered.error.code).toBe(ERROR_CODES.UNAUTHENTICATED);
    });
  });

  // =========================================================================
  // 2. Cero IDOR en Conversión de Cuentas
  // =========================================================================
  describe('2. Cero IDOR en Conversión de Cuentas (/api/v1/auth/convert-guest)', () => {
    it('Guest A convierte su cuenta vía POST /api/v1/auth/convert-guest de forma legítima', async () => {
      const guestResult = await app.ctx.authService.createGuest('convert-guest-a');
      const guestAId = guestResult.user.id;

      const convertRes = await fetch(`${baseUrl}/api/v1/auth/convert-guest`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${guestResult.accessToken}`,
        },
        body: JSON.stringify({
          email: 'converted-a@example.com',
          password: 'Password123!',
        }),
      });

      expect(convertRes.status).toBe(200);
      const data = (await convertRes.json()) as AuthUserResponse;
      expect(data.user.id).toBe(guestAId);
      expect(data.user.role).toBe('user');
      expect(data.user.email).toBe('converted-a@example.com');
      expect(data.user.gamertag).toBe('convert-guest-a');

      // Se emiten nuevas cookies
      const cookies = extractCookies(convertRes);
      expect(cookies[AUTH_COOKIE_NAMES.ACCESS_TOKEN]).toBeDefined();
      expect(cookies[AUTH_COOKIE_NAMES.REFRESH_TOKEN]).toBeDefined();

      // El usuario puede iniciar sesión normalmente con sus nuevas credenciales
      const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'converted-a@example.com',
          password: 'Password123!',
        }),
      });
      expect(loginRes.status).toBe(200);
    });

    it('garantiza cero IDOR: el endpoint extrae userId exclusivamente del token criptográfico y rechaza campos manipulados', async () => {
      const guestA = await app.ctx.authService.createGuest('idor-guest-a');
      const guestB = await app.ctx.authService.createGuest('idor-guest-b');

      // Guest A intenta enviar un payload malicioso inyectando user_id de Guest B
      const maliciousRes = await fetch(`${baseUrl}/api/v1/auth/convert-guest`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${guestA.accessToken}`,
        },
        body: JSON.stringify({
          user_id: guestB.user.id, // Intento de IDOR
          email: 'hacked-b@example.com',
          password: 'MaliciousPassword123!',
        }),
      });

      // El schema estricto rechaza propiedades no autorizadas con 400 VALIDATION_FAILED
      expect(maliciousRes.status).toBe(400);
      const maliciousData = (await maliciousRes.json()) as ApiError;
      expect(maliciousData.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);

      // Verificar que Guest B NUNCA fue modificado
      const reloadB = await app.ctx.userRepo.findById(guestB.user.id);
      expect(reloadB?.role).toBe('guest');
      expect(reloadB?.email).toBeNull();
    });

    it('la conversión de Guest A no altera el rol (guest), sesión ni identificador de Guest B', async () => {
      const guestA = await app.ctx.authService.createGuest('iso-guest-a');
      const guestB = await app.ctx.authService.createGuest('iso-guest-b');

      // Guest A convierte su cuenta legítimamente
      const convertRes = await fetch(`${baseUrl}/api/v1/auth/convert-guest`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${guestA.accessToken}`,
        },
        body: JSON.stringify({
          email: 'legit-a@example.com',
          password: 'Password123!',
        }),
      });
      expect(convertRes.status).toBe(200);

      // Verificación exhaustiva de Guest B en almacenamiento:
      const reloadedB = await app.ctx.userRepo.findById(guestB.user.id);
      expect(reloadedB).toBeDefined();
      expect(reloadedB!.id).toBe(guestB.user.id);
      expect(reloadedB!.role).toBe('guest');
      expect(reloadedB!.email).toBeNull();
      expect(reloadedB!.gamertag).toBe('iso-guest-b');

      // La sesión de Guest B sigue siendo completamente válida para refrescar
      const refreshB = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          Cookie: `${AUTH_COOKIE_NAMES.REFRESH_TOKEN}=${guestB.refreshToken}`,
        },
      });
      expect(refreshB.status).toBe(200);
    });

    it('rechaza con 409 EMAIL_TAKEN si Guest A intenta registrar un email ya tomado por otro usuario registrado', async () => {
      await registerUser('already-taken@test.com', 'taken-owner');
      const guestA = await app.ctx.authService.createGuest('guest-email-conflict');

      const conflictRes = await fetch(`${baseUrl}/api/v1/auth/convert-guest`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${guestA.accessToken}`,
        },
        body: JSON.stringify({
          email: 'already-taken@test.com',
          password: 'Password123!',
        }),
      });

      expect(conflictRes.status).toBe(409);
      const conflictData = (await conflictRes.json()) as ApiError;
      expect(conflictData.error.code).toBe(ERROR_CODES.EMAIL_TAKEN);

      // El usuario permanece en estado guest
      const userA = await app.ctx.userRepo.findById(guestA.user.id);
      expect(userA?.role).toBe('guest');
      expect(userA?.email).toBeNull();
    });
  });

  // =========================================================================
  // 3. Aislamiento de Permisos en Salas (Host vs. Guest)
  // =========================================================================
  describe('3. Aislamiento de Permisos en Salas (Host vs. Guest)', () => {
    it('solo el host legítimo puede iniciar la partida; Guest B recibe 403 FORBIDDEN con mensaje normalizado', async () => {
      const host = await registerUser('host-perm-iso@test.com', 'host-perm-iso');

      const roomRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${host.accessToken}`,
        },
        body: JSON.stringify({ config: standardPuntosConfig }),
      });
      const room = (await roomRes.json()) as RoomCreatedResponse;

      const guestB = await joinAsGuest(room.room_code, 'guest-non-host');

      // Guest B (participante pero no host) intenta arrancar la sala
      const guestStartRes = await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${guestB.accessToken}` },
      });

      expect(guestStartRes.status).toBe(403);
      const errData = (await guestStartRes.json()) as ApiError;
      expect(errData.error.code).toBe(ERROR_CODES.FORBIDDEN);
      expect(errData.error.message).toBe(ERROR_MESSAGES.FORBIDDEN);

      // Host legítimo inicia la partida exitosamente
      const hostStartRes = await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${host.accessToken}` },
      });

      expect(hostStartRes.status).toBe(200);
      const startData = (await hostStartRes.json()) as StartRoomResponse;
      expect(startData.started).toBe(true);
      expect(startData.status).toBe('running');
    });

    it('usuarios ajenos a la partida no pueden consultar los detalles de la sala (403 FORBIDDEN)', async () => {
      const host = await registerUser('host-details-iso@test.com', 'host-det-iso');
      const roomRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${host.accessToken}`,
        },
        body: JSON.stringify({ config: standardPuntosConfig }),
      });
      const room = (await roomRes.json()) as RoomCreatedResponse;

      const stranger = await registerUser('stranger-iso@test.com', 'stranger-iso');

      const strangerRes = await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}`, {
        headers: { Authorization: `Bearer ${stranger.accessToken}` },
      });

      expect(strangerRes.status).toBe(403);
      const strangerErr = (await strangerRes.json()) as ApiError;
      expect(strangerErr.error.code).toBe(ERROR_CODES.FORBIDDEN);
      expect(strangerErr.error.message).toBe(ERROR_MESSAGES.FORBIDDEN);

      // En cambio, el host puede consultar los detalles normalmente
      const hostDetailsRes = await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}`, {
        headers: { Authorization: `Bearer ${host.accessToken}` },
      });
      expect(hostDetailsRes.status).toBe(200);
      const details = (await hostDetailsRes.json()) as RoomDetailsResponse;
      expect(details.room_code).toBe(room.room_code);
    });
  });

  // =========================================================================
  // 4. Inmunidad Cruzada de Cooldown en Admisión
  // =========================================================================
  describe('4. Inmunidad Cruzada de Cooldown en Admisión (/api/v1/submissions)', () => {
    it('el cooldown de 10s activado por Guest A no bloquea la admisión de Guest B en la misma partida', async () => {
      const host = await registerUser('host-cool-iso@test.com', 'host-cool-iso');

      const roomRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${host.accessToken}`,
        },
        body: JSON.stringify({ config: standardPuntosConfig }),
      });
      const room = (await roomRes.json()) as RoomCreatedResponse;

      const guestA = await joinAsGuest(room.room_code, 'cool-guest-a');
      const guestB = await joinAsGuest(room.room_code, 'cool-guest-b');

      // Iniciar la partida a running
      await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${host.accessToken}` },
      });

      // 1. Guest A envía código legítimo -> 202 Accepted y entra en cooldown de 10s
      const subResA1 = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${guestA.accessToken}`,
          'Idempotency-Key': 'sub-a-key-1',
        },
        body: JSON.stringify({
          match_id: room.match_id,
          round_id: testRoundId,
          problem_id: testProblemId,
          language: 'python',
          source_code: 'print("guest a code")',
        }),
      });
      expect(subResA1.status).toBe(202);
      const dataA1 = (await subResA1.json()) as SubmissionAcceptedResponse;
      expect(dataA1.admission_seq).toBe(1);

      // 2. Guest A intenta enviar nuevamente de inmediato -> 429 SUBMIT_COOLDOWN
      const subResA2 = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${guestA.accessToken}`,
          'Idempotency-Key': 'sub-a-key-2',
        },
        body: JSON.stringify({
          match_id: room.match_id,
          round_id: testRoundId,
          problem_id: testProblemId,
          language: 'python',
          source_code: 'print("guest a retry")',
        }),
      });
      expect(subResA2.status).toBe(429);
      const cooldownData = (await subResA2.json()) as ApiError;
      expect(cooldownData.error.code).toBe(ERROR_CODES.SUBMIT_COOLDOWN);

      // 3. INMUNIDAD CRUZADA: Guest B en la misma partida envía código simultáneamente o inmediatamente después
      // No debe ser afectado por el cooldown de Guest A -> 202 Accepted
      const subResB = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${guestB.accessToken}`,
          'Idempotency-Key': 'sub-b-key-1',
        },
        body: JSON.stringify({
          match_id: room.match_id,
          round_id: testRoundId,
          problem_id: testProblemId,
          language: 'cpp',
          source_code: 'int main() { return 0; }',
        }),
      });
      expect(subResB.status).toBe(202);
      const dataB = (await subResB.json()) as SubmissionAcceptedResponse;
      expect(dataB.admission_seq).toBe(2);
    });

    it('el user_id en la sumisión se deriva estrictamente del token verificado de la sesión (cero suplantación)', async () => {
      const host = await registerUser('host-spoof-iso@test.com', 'host-spoof');
      const roomRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${host.accessToken}`,
        },
        body: JSON.stringify({ config: standardPuntosConfig }),
      });
      const room = (await roomRes.json()) as RoomCreatedResponse;

      const guestA = await joinAsGuest(room.room_code, 'spoof-guest-a');
      const guestB = await joinAsGuest(room.room_code, 'spoof-guest-b');

      await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${host.accessToken}` },
      });

      // Atacante (Guest A) intenta falsificar la sumisión inyectando user_id de Guest B en el cuerpo
      const maliciousRes = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${guestA.accessToken}`,
        },
        body: JSON.stringify({
          match_id: room.match_id,
          round_id: testRoundId,
          problem_id: testProblemId,
          language: 'python',
          source_code: 'print("spoofed")',
          user_id: guestB.userId, // Propiedad prohibida
        }),
      });

      // El schema rechaza con 400 VALIDATION_FAILED por ADDITIONAL_PROPERTY
      expect(maliciousRes.status).toBe(400);
      const err = (await maliciousRes.json()) as ApiError;
      expect(err.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);

      // Verificamos que cualquier envío aceptado siempre pertenezca a quien firmó el token
      const legitSubRes = await fetch(`${baseUrl}/api/v1/submissions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${guestA.accessToken}`,
        },
        body: JSON.stringify({
          match_id: room.match_id,
          round_id: testRoundId,
          problem_id: testProblemId,
          language: 'python',
          source_code: 'print("legit submission")',
        }),
      });
      expect(legitSubRes.status).toBe(202);
      const legitData = (await legitSubRes.json()) as SubmissionAcceptedResponse;

      // El registro almacenado en base de datos tiene inequívocamente el id de Guest A
      const storedSub = await app.ctx.submissionRepo.findSubmissionById(legitData.submission_id);
      expect(storedSub?.user_id).toBe(guestA.userId);
      expect(storedSub?.user_id).not.toBe(guestB.userId);
    });
  });

  // =========================================================================
  // 5. Confidencialidad de Snapshots de Código (Privacidad entre Rivales)
  // =========================================================================
  describe('5. Confidencialidad de Snapshots de Código (Privacidad entre Rivales)', () => {
    it('Guest A solo ve su propio código si Guest B tiene is_revealed: false; al activar is_revealed: true se comparte con rivales pero no terceros', async () => {
      const host = await registerUser('host-snap-iso@test.com', 'host-snap-iso');
      const roomRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${host.accessToken}`,
        },
        body: JSON.stringify({ config: standardPuntosConfig }),
      });
      const room = (await roomRes.json()) as RoomCreatedResponse;

      const guestA = await joinAsGuest(room.room_code, 'snap-guest-a');
      const guestB = await joinAsGuest(room.room_code, 'snap-guest-b');
      const stranger = await registerUser('stranger-snap-iso@test.com', 'stranger-snap');

      // Guardar snapshots de código para ambos
      await app.ctx.roomRepo.saveSnapshot({
        match_id: room.match_id,
        round_id: testRoundId,
        user_id: guestA.userId,
        problem_id: testProblemId,
        language: 'python',
        source_code: 'print("codigo de guest A")',
      });

      await app.ctx.roomRepo.saveSnapshot({
        match_id: room.match_id,
        round_id: testRoundId,
        user_id: guestB.userId,
        problem_id: testProblemId,
        language: 'cpp',
        source_code: 'int main() { /* secreto B */ return 0; }',
      });

      // Configurar estado de revelado inicial:
      // Guest A: is_revealed = false
      // Guest B: is_revealed = false
      const playerA = await app.ctx.roomRepo.findPlayer(room.match_id, guestA.userId);
      const playerB = await app.ctx.roomRepo.findPlayer(room.match_id, guestB.userId);
      await app.ctx.roomRepo.updatePlayer(playerA!.id, { is_revealed: false });
      await app.ctx.roomRepo.updatePlayer(playerB!.id, { is_revealed: false });

      // Finalizar la partida
      await app.ctx.roomRepo.updateMatch(room.match_id, {
        status: 'finished',
        started_at: new Date(Date.now() - 60000).toISOString(),
        finished_at: new Date().toISOString(),
        winner_ids: [guestA.userId],
        finish_reason: 'target_reached',
      });

      // 1. Guest A consulta el resumen final:
      // Ve su propio código capturado, pero NUNCA el código de Guest B
      const resA = await fetch(`${baseUrl}/api/v1/matches/${room.match_id}/summary`, {
        headers: { Authorization: `Bearer ${guestA.accessToken}` },
      });
      expect(resA.status).toBe(200);
      const summaryA = (await resA.json()) as MatchSummaryResponse;
      expect(summaryA.snapshots).toHaveLength(1);
      expect(summaryA.snapshots[0]!.user_id).toBe(guestA.userId);
      expect(summaryA.snapshots[0]!.source_code).toBe('print("codigo de guest A")');

      // 2. Guest B consulta el resumen final:
      // Ve su propio código capturado (a pesar de is_revealed: false)
      const resB = await fetch(`${baseUrl}/api/v1/matches/${room.match_id}/summary`, {
        headers: { Authorization: `Bearer ${guestB.accessToken}` },
      });
      expect(resB.status).toBe(200);
      const summaryB = (await resB.json()) as MatchSummaryResponse;
      expect(summaryB.snapshots).toHaveLength(1);
      expect(summaryB.snapshots[0]!.user_id).toBe(guestB.userId);
      expect(summaryB.snapshots[0]!.source_code).toContain('/* secreto B */');

      // 3. Guest B otorga consentimiento (is_revealed = true)
      await app.ctx.roomRepo.updatePlayer(playerB!.id, { is_revealed: true });

      // Ahora Guest A vuelve a consultar el resumen:
      // El snapshot de Guest B ahora SÍ es visible para Guest A
      const resAAfterReveal = await fetch(`${baseUrl}/api/v1/matches/${room.match_id}/summary`, {
        headers: { Authorization: `Bearer ${guestA.accessToken}` },
      });
      expect(resAAfterReveal.status).toBe(200);
      const summaryAAfterReveal = (await resAAfterReveal.json()) as MatchSummaryResponse;
      expect(summaryAAfterReveal.snapshots).toHaveLength(2);
      const visibleUsers = summaryAAfterReveal.snapshots.map((s) => s.user_id);
      expect(visibleUsers).toContain(guestA.userId);
      expect(visibleUsers).toContain(guestB.userId);

      // 4. Usuario C ajeno a la partida intenta consultar el resumen -> 403 NOT_A_PLAYER
      const resStranger = await fetch(`${baseUrl}/api/v1/matches/${room.match_id}/summary`, {
        headers: { Authorization: `Bearer ${stranger.accessToken}` },
      });
      expect(resStranger.status).toBe(403);
      const strangerErr = (await resStranger.json()) as ApiError;
      expect(strangerErr.error.code).toBe(ERROR_CODES.NOT_A_PLAYER);
    });
  });

  // =========================================================================
  // 6. Aislamiento en Rotación de Tokens y Detección de Brecha
  // =========================================================================
  describe('6. Aislamiento en Rotación de Tokens y Detección de Brecha', () => {
    it('logout de Guest A invalida su refresh token sin afectar la sesión de Guest B', async () => {
      const guestA = await app.ctx.authService.createGuest('logout-guest-a');
      const guestB = await app.ctx.authService.createGuest('logout-guest-b');

      // Logout de Guest A
      const logoutRes = await fetch(`${baseUrl}/api/v1/auth/logout`, {
        method: 'POST',
        headers: {
          Cookie: `${AUTH_COOKIE_NAMES.REFRESH_TOKEN}=${guestA.refreshToken}`,
        },
      });
      expect(logoutRes.status).toBe(200);
      const logoutData = (await logoutRes.json()) as LogoutResponse;
      expect(logoutData.ok).toBe(true);

      // El token de Guest A ya no funciona para refresh -> 401 UNAUTHENTICATED
      const refreshA = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          Cookie: `${AUTH_COOKIE_NAMES.REFRESH_TOKEN}=${guestA.refreshToken}`,
        },
      });
      expect(refreshA.status).toBe(401);

      // La sesión de Guest B permanece completamente intacta
      const refreshB = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          Cookie: `${AUTH_COOKIE_NAMES.REFRESH_TOKEN}=${guestB.refreshToken}`,
        },
      });
      expect(refreshB.status).toBe(200);
      const dataB = (await refreshB.json()) as AuthUserResponse;
      expect(dataB.user.id).toBe(guestB.user.id);
    });

    it('la detección de reutilización de refresh token revocado en la familia de Guest A no invalida la familia ni sesión de Guest B', async () => {
      const guestA = await app.ctx.authService.createGuest('reuse-guest-a');
      const guestB = await app.ctx.authService.createGuest('reuse-guest-b');

      const initialTokenA = guestA.refreshToken;
      const initialTokenB = guestB.refreshToken;

      // 1. Guest A rota legítimamente su token
      const rotateARes = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          Cookie: `${AUTH_COOKIE_NAMES.REFRESH_TOKEN}=${initialTokenA}`,
        },
      });
      expect(rotateARes.status).toBe(200);
      const cookiesA = extractCookies(rotateARes);
      const newRefreshTokenA = cookiesA[AUTH_COOKIE_NAMES.REFRESH_TOKEN]!;
      expect(newRefreshTokenA).not.toBe(initialTokenA);

      // 2. DETECCIÓN DE BRECHA: Un atacante reutiliza el token anterior revocado de Guest A
      const breachRes = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          Cookie: `${AUTH_COOKIE_NAMES.REFRESH_TOKEN}=${initialTokenA}`,
        },
      });
      expect(breachRes.status).toBe(401);
      const breachData = (await breachRes.json()) as ApiError;
      expect(breachData.error.code).toBe(ERROR_CODES.REFRESH_REUSED);

      // 3. La familia de Guest A quedó completamente invalidada
      const aFamilyRes = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          Cookie: `${AUTH_COOKIE_NAMES.REFRESH_TOKEN}=${newRefreshTokenA}`,
        },
      });
      expect(aFamilyRes.status).toBe(401);

      // 4. AISLAMIENTO TOTAL: La sesión y familia de Guest B permanece 100% válida e inalterada
      const refreshBRes = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          Cookie: `${AUTH_COOKIE_NAMES.REFRESH_TOKEN}=${initialTokenB}`,
        },
      });
      expect(refreshBRes.status).toBe(200);
      const dataB = (await refreshBRes.json()) as AuthUserResponse;
      expect(dataB.user.id).toBe(guestB.user.id);
    });

    it('la purga por inactividad de Guest A anonimiza su cuenta sin afectar la sesión, cuenta ni historial de Guest B', async () => {
      const guestA = await app.ctx.authService.createGuest('purge-guest-a');
      const guestB = await app.ctx.authService.createGuest('purge-guest-b');

      const now = new Date('2026-09-15T00:00:00.000Z');
      const inactiveDate = new Date('2026-07-01T00:00:00.000Z').toISOString(); // Más de 60 días
      const activeDate = new Date('2026-09-14T00:00:00.000Z').toISOString(); // Activo hace 1 día

      // Simular inactividad en Guest A y actividad reciente en Guest B
      await app.ctx.userRepo.update(guestA.user.id, { updated_at: inactiveDate });
      await app.ctx.userRepo.update(guestB.user.id, { updated_at: activeDate });

      // Ejecutar la purga periódica por inactividad (>30 días)
      const purgeResult = await app.ctx.retentionService.purgeInactiveGuests(now);
      expect(purgeResult.purged_guests).toBeGreaterThanOrEqual(1);

      // Guest A debe haber sido anonimizado con tombstone
      const purgedA = await app.ctx.userRepo.findById(guestA.user.id);
      expect(purgedA).toBeDefined();
      expect(purgedA!.gamertag.startsWith('anon-')).toBe(true);
      expect(purgedA!.email).toBeNull();
      expect(purgedA!.password_hash).toBeNull();

      // Los tokens de Guest A fueron revocados por la purga
      const refreshPurgedA = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          Cookie: `${AUTH_COOKIE_NAMES.REFRESH_TOKEN}=${guestA.refreshToken}`,
        },
      });
      expect(refreshPurgedA.status).toBe(401);

      // INMUNIDAD TOTAL DE GUEST B:
      // Conserva su gamertag original, rol guest, y su sesión sigue completamente funcional
      const untouchedB = await app.ctx.userRepo.findById(guestB.user.id);
      expect(untouchedB).toBeDefined();
      expect(untouchedB!.gamertag).toBe('purge-guest-b');
      expect(untouchedB!.role).toBe('guest');

      const refreshUntouchedB = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          Cookie: `${AUTH_COOKIE_NAMES.REFRESH_TOKEN}=${guestB.refreshToken}`,
        },
      });
      expect(refreshUntouchedB.status).toBe(200);
      const bRefreshedData = (await refreshUntouchedB.json()) as AuthUserResponse;
      expect(bRefreshedData.user.id).toBe(guestB.user.id);
      expect(bRefreshedData.user.gamertag).toBe('purge-guest-b');
    });
  });
});
