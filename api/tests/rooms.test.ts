import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  ERROR_CODES,
  type ApiError,
  type AuthUserResponse,
  type JoinRoomResponse,
  type PuntosMatchConfig,
  type RondasMatchConfig,
  type RoomCreatedResponse,
  type RoomDetailsResponse,
  type StartRoomResponse,
} from '@duelodev/shared';
import { createApp, type ApiApp } from '../src/app.js';
import { AUTH_COOKIE_NAMES } from '../src/plugins/cookies.js';

describe('Rooms REST API (/api/v1/rooms)', () => {
  let app: ApiApp;
  let baseUrl: string;

  beforeAll(async () => {
    app = createApp({
      serviceName: 'api-rooms-test',
      authSecret: 'test-room-secret-duelodev-1234567890',
      rateLimitConfig: { enabled: false },
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
  ): Promise<{ accessToken: string; userId: string }> {
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
    return {
      accessToken: cookies[AUTH_COOKIE_NAMES.ACCESS_TOKEN]!,
      userId: data.user.id,
    };
  }

  const validPuntosConfig: PuntosMatchConfig = {
    mode: 'puntos',
    max_players: 4,
    categories: ['facil', 'facil_medio'],
    num_problems: 3,
    time_per_problem_s: 180,
  };

  const validRondasConfig: RondasMatchConfig = {
    mode: 'rondas',
    max_players: 2,
    categories: ['facil'],
    num_problems: 5,
    match_duration_s: 600,
    target: 3,
  };

  describe('POST /api/v1/rooms (Creación de sala)', () => {
    it('crea una sala exitosamente para un usuario registrado', async () => {
      const host = await registerUser('host1@example.com', 'host-coder');

      const res = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${host.accessToken}`,
        },
        body: JSON.stringify({ config: validPuntosConfig }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as RoomCreatedResponse;
      expect(typeof data.match_id).toBe('string');
      expect(typeof data.room_code).toBe('string');
      expect(data.room_code).toMatch(/^[A-Z0-9]{4,10}$/);
      expect(data.share_url).toContain(`/room/${data.room_code}`);
      expect(data.config.mode).toBe('puntos');
      expect(typeof data.created_at).toBe('string');
    });

    it('crea una sala en modo rondas correctamente', async () => {
      const host = await registerUser('host-rondas@example.com', 'rondas-host');

      const res = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${host.accessToken}`,
        },
        body: JSON.stringify({ config: validRondasConfig }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as RoomCreatedResponse;
      expect(data.config.mode).toBe('rondas');
    });

    it('rechaza crear sala sin autenticación con 401 UNAUTHENTICATED', async () => {
      const res = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: validPuntosConfig }),
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.UNAUTHENTICATED);
    });

    it('rechaza crear sala a usuarios con rol guest con 403 FORBIDDEN', async () => {
      const guest = await app.ctx.authService.createGuest('guest-nobie');

      const res = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${guest.accessToken}`,
        },
        body: JSON.stringify({ config: validPuntosConfig }),
      });

      expect(res.status).toBe(403);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('rechaza crear sala con configuración inválida o award_on_timeout prohibido', async () => {
      const host = await registerUser('host-badcfg@example.com', 'host-badcfg');

      const badConfig = {
        ...validPuntosConfig,
        award_on_timeout: true, // Prohibido expresamente en shared
      };

      const res = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${host.accessToken}`,
        },
        body: JSON.stringify({ config: badConfig }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });
  });

  describe('POST /api/v1/rooms/:code/join (Unión a sala)', () => {
    it('permite a un nuevo invitado unirse y le emite cookies de sesión', async () => {
      const host = await registerUser('host-join@example.com', 'host-join');
      const createRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${host.accessToken}`,
        },
        body: JSON.stringify({ config: validPuntosConfig }),
      });
      const room = (await createRes.json()) as RoomCreatedResponse;

      // Invitado no autenticado
      const joinRes = await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gamertag: 'guest-player-1' }),
      });

      expect(joinRes.status).toBe(200);
      const joinData = (await joinRes.json()) as JoinRoomResponse;
      expect(joinData.match_id).toBe(room.match_id);
      expect(joinData.gamertag).toBe('guest-player-1');
      expect(joinData.role).toBe('player');
      expect(joinData.room_code).toBe(room.room_code);

      // Comprobar que recibe cookies para su sesión de invitado (doc 04 §2)
      const cookies = extractCookies(joinRes);
      expect(cookies[AUTH_COOKIE_NAMES.ACCESS_TOKEN]).toBeDefined();
      expect(cookies[AUTH_COOKIE_NAMES.REFRESH_TOKEN]).toBeDefined();
    });

    it('permite a un usuario autenticado unirse conservando su identidad', async () => {
      const host = await registerUser('host-authjoin@example.com', 'host-authjoin');
      const player2 = await registerUser('player2@example.com', 'player-two');

      const createRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${host.accessToken}`,
        },
        body: JSON.stringify({ config: validPuntosConfig }),
      });
      const room = (await createRes.json()) as RoomCreatedResponse;

      const joinRes = await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/join`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${player2.accessToken}`,
        },
        body: JSON.stringify({ gamertag: 'player-two' }),
      });

      expect(joinRes.status).toBe(200);
      const joinData = (await joinRes.json()) as JoinRoomResponse;
      expect(joinData.user_id).toBe(player2.userId);
      expect(joinData.role).toBe('player');
    });

    it('rechaza unirse con gamertag duplicado en la misma sala devolviendo 409 GAMERTAG_TAKEN', async () => {
      const host = await registerUser('host-dup@example.com', 'host-dup');
      const createRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${host.accessToken}`,
        },
        body: JSON.stringify({ config: validPuntosConfig }),
      });
      const room = (await createRes.json()) as RoomCreatedResponse;

      // Intentar unirse con el mismo gamertag del host (case-insensitive)
      const joinRes = await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gamertag: 'HOST-DUP' }),
      });

      expect(joinRes.status).toBe(409);
      const data = (await joinRes.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.GAMERTAG_TAKEN);
    });

    it('rechaza unirse a una sala llena devolviendo 409 ROOM_FULL', async () => {
      const host = await registerUser('host-cap@example.com', 'host-cap');
      // Sala con capacidad para 2 jugadores
      const config2Players: PuntosMatchConfig = {
        ...validPuntosConfig,
        max_players: 2,
      };

      const createRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${host.accessToken}`,
        },
        body: JSON.stringify({ config: config2Players }),
      });
      const room = (await createRes.json()) as RoomCreatedResponse;

      // Jugador 2 se une
      await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gamertag: 'player-2' }),
      });

      // Jugador 3 intenta unirse (excede max_players = 2)
      const overflowRes = await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gamertag: 'player-3' }),
      });

      expect(overflowRes.status).toBe(409);
      const data = (await overflowRes.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.ROOM_FULL);
    });

    it('responde 404 ROOM_NOT_FOUND para códigos inexistentes', async () => {
      const res = await fetch(`${baseUrl}/api/v1/rooms/NONEXIST/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gamertag: 'player-x' }),
      });

      expect(res.status).toBe(404);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.ROOM_NOT_FOUND);
    });
  });

  describe('GET /api/v1/rooms/:code (Detalles de sala)', () => {
    it('devuelve los detalles de la sala y lista de jugadores a un miembro', async () => {
      const host = await registerUser('host-details@example.com', 'host-det');
      const createRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${host.accessToken}`,
        },
        body: JSON.stringify({ config: validPuntosConfig }),
      });
      const room = (await createRes.json()) as RoomCreatedResponse;

      // Jugador invitado se une
      const joinRes = await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gamertag: 'guest-det' }),
      });
      const guestCookies = extractCookies(joinRes);

      // El invitado consulta los detalles
      const detailsRes = await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${guestCookies[AUTH_COOKIE_NAMES.ACCESS_TOKEN]}`,
        },
      });

      expect(detailsRes.status).toBe(200);
      const details = (await detailsRes.json()) as RoomDetailsResponse;
      expect(details.room_code).toBe(room.room_code);
      expect(details.status).toBe('lobby');
      expect(details.host_id).toBe(host.userId);
      expect(details.players).toHaveLength(2);

      const hostSummary = details.players.find((p) => p.user_id === host.userId);
      expect(hostSummary?.is_host).toBe(true);
      expect(hostSummary?.gamertag).toBe('host-det');

      const guestSummary = details.players.find((p) => p.gamertag === 'guest-det');
      expect(guestSummary?.is_host).toBe(false);
    });

    it('rechaza consulta de detalles a un usuario no miembro con 403 FORBIDDEN', async () => {
      const host = await registerUser('host-forbidden@example.com', 'host-forb');
      const stranger = await registerUser('stranger@example.com', 'stranger');

      const createRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${host.accessToken}`,
        },
        body: JSON.stringify({ config: validPuntosConfig }),
      });
      const room = (await createRes.json()) as RoomCreatedResponse;

      const res = await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${stranger.accessToken}`,
        },
      });

      expect(res.status).toBe(403);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });
  });

  describe('POST /api/v1/rooms/:code/start (Inicio de partida)', () => {
    it('inicia la partida cuando el host la arranca con quórum suficiente', async () => {
      const host = await registerUser('host-start@example.com', 'host-starter');
      const createRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${host.accessToken}`,
        },
        body: JSON.stringify({ config: validPuntosConfig }),
      });
      const room = (await createRes.json()) as RoomCreatedResponse;

      // Unir un segundo jugador para cumplir quórum
      await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gamertag: 'player-start' }),
      });

      const startRes = await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/start`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${host.accessToken}`,
        },
      });

      expect(startRes.status).toBe(200);
      const startData = (await startRes.json()) as StartRoomResponse;
      expect(startData.started).toBe(true);
      expect(startData.status).toBe('running');

      // Idempotencia: segunda llamada devuelve también 200 started: true
      const secondStart = await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/start`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${host.accessToken}`,
        },
      });
      expect(secondStart.status).toBe(200);
      const secondData = (await secondStart.json()) as StartRoomResponse;
      expect(secondData.started).toBe(true);

      // Ahora intentar unirse debe devolver 409 ROOM_ALREADY_STARTED
      const lateJoin = await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gamertag: 'late-comer' }),
      });
      expect(lateJoin.status).toBe(409);
      const lateData = (await lateJoin.json()) as ApiError;
      expect(lateData.error.code).toBe(ERROR_CODES.ROOM_ALREADY_STARTED);
    });

    it('rechaza iniciar partida si no es el anfitrión devolviendo 403 FORBIDDEN', async () => {
      const host = await registerUser('host-perm@example.com', 'host-perm');
      const createRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${host.accessToken}`,
        },
        body: JSON.stringify({ config: validPuntosConfig }),
      });
      const room = (await createRes.json()) as RoomCreatedResponse;

      const player = await registerUser('player-perm@example.com', 'player-perm');
      await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/join`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${player.accessToken}`,
        },
        body: JSON.stringify({ gamertag: 'player-perm' }),
      });

      // El jugador no anfitrión intenta iniciar
      const startRes = await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/start`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${player.accessToken}`,
        },
      });

      expect(startRes.status).toBe(403);
      const data = (await startRes.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('rechaza iniciar partida si solo hay 1 jugador (< 2) devolviendo 400 VALIDATION_FAILED', async () => {
      const host = await registerUser('host-alone@example.com', 'host-alone');
      const createRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${host.accessToken}`,
        },
        body: JSON.stringify({ config: validPuntosConfig }),
      });
      const room = (await createRes.json()) as RoomCreatedResponse;

      const startRes = await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/start`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${host.accessToken}`,
        },
      });

      expect(startRes.status).toBe(400);
      const data = (await startRes.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });
  });
});
