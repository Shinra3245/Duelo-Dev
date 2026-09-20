import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp, type ApiApp } from '../src/app.js';
import { hashPassword } from '../src/services/password.js';
import { ADMIN_ALLOWED_EMAIL, AdminService } from '../src/services/admin.js';
import { ensureConfiguredAdmin } from '../src/services/admin.js';
import {
  InMemoryEventRepository,
  InMemoryRoomRepository,
  InMemoryUserRepository,
} from '../src/repositories/memory.js';
import { AuditService } from '../src/services/audit.js';
import { AUTH_COOKIE_NAMES } from '../src/plugins/cookies.js';
import {
  ERROR_CODES,
  type AuthUserResponse,
  type MatchControlNotification,
} from '@duelodev/shared';

describe('Panel administrativo protegido', () => {
  let app: ApiApp;
  let baseUrl: string;
  let adminCookie: string;
  let userCookie: string;
  const controlNotifications: MatchControlNotification[] = [];

  function accessCookie(response: Response): string {
    const setCookies =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie') ?? ''];
    const access = setCookies.find((value) =>
      value.startsWith(`${AUTH_COOKIE_NAMES.ACCESS_TOKEN}=`),
    );
    expect(access).toBeDefined();
    return access!.split(';', 1)[0]!;
  }

  beforeAll(async () => {
    app = createApp({
      authSecret: 'admin-test-secret-32-characters-minimum',
      matchControlPublisher: {
        publish: async (notification) => {
          controlNotifications.push(notification);
        },
      },
    });
    await app.ctx.userRepo.create({
      email: ADMIN_ALLOWED_EMAIL,
      password_hash: await hashPassword('AdminPassword123!'),
      gamertag: 'admin-duelodev',
      role: 'admin',
    });
    await app.start(0, '127.0.0.1');
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const adminLogin = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_ALLOWED_EMAIL, password: 'AdminPassword123!' }),
    });
    expect(adminLogin.status).toBe(200);
    const adminBody = (await adminLogin.json()) as AuthUserResponse;
    expect(adminBody.user.role).toBe('admin');
    adminCookie = accessCookie(adminLogin);

    const userRegister = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'player-admin-test@example.com',
        password: 'PlayerPassword123!',
        gamertag: 'player-admin-test',
      }),
    });
    expect(userRegister.status).toBe(201);
    userCookie = accessCookie(userRegister);
  });

  afterAll(async () => {
    await app.close();
  });

  it('bootstrap idempotente sólo eleva la identidad administrativa permitida', async () => {
    const users = new InMemoryUserRepository();
    const first = await ensureConfiguredAdmin(users, 'BootstrapPassword123!');
    const second = await ensureConfiguredAdmin(users, 'BootstrapPassword123!');
    expect(first.id).toBe(second.id);
    expect(second.email).toBe(ADMIN_ALLOWED_EMAIL);
    expect(second.role).toBe('admin');
  });

  it('expone el rol admin en /auth/me y deniega el panel a usuarios normales', async () => {
    const me = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Cookie: adminCookie },
    });
    expect(me.status).toBe(200);
    expect(((await me.json()) as AuthUserResponse).user.role).toBe('admin');

    const forbidden = await fetch(`${baseUrl}/api/v1/admin/ranking`, {
      headers: { Cookie: userCookie },
    });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error.code).toBe(ERROR_CODES.FORBIDDEN);
  });

  it('permite crear sólo salas administrativas de 2 o 3 jugadores', async () => {
    const valid = await fetch(`${baseUrl}/api/v1/admin/rooms/create`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          mode: 'puntos',
          max_players: 3,
          num_problems: 1,
          categories: ['facil'],
          time_per_problem_s: 60,
        },
      }),
    });
    expect(valid.status).toBe(201);
    const created = (await valid.json()) as { room_code: string };
    const emptyLobby = await fetch(`${baseUrl}/api/v1/rooms/${created.room_code}`, {
      headers: { Cookie: adminCookie },
    });
    expect(emptyLobby.status).toBe(200);
    expect((await emptyLobby.json()).players).toHaveLength(0);

    const cannotStartEmpty = await fetch(`${baseUrl}/api/v1/rooms/${created.room_code}/start`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
    });
    expect(cannotStartEmpty.status).toBe(400);

    const firstJoin = await fetch(`${baseUrl}/api/v1/rooms/${created.room_code}/join`, {
      method: 'POST',
      headers: { Cookie: userCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ gamertag: 'player-admin-test' }),
    });
    expect(firstJoin.status).toBe(200);
    expect((await firstJoin.json()).role).toBe('host');

    const stillBelowMinimum = await fetch(`${baseUrl}/api/v1/rooms/${created.room_code}/start`, {
      method: 'POST',
      headers: { Cookie: userCookie },
    });
    expect(stillBelowMinimum.status).toBe(400);

    const secondJoin = await fetch(`${baseUrl}/api/v1/rooms/${created.room_code}/join`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ gamertag: 'admin-duelodev' }),
    });
    expect(secondJoin.status).toBe(200);
    expect((await secondJoin.json()).role).toBe('player');

    const startWithQuorum = await fetch(`${baseUrl}/api/v1/rooms/${created.room_code}/start`, {
      method: 'POST',
      headers: { Cookie: userCookie },
    });
    expect(startWithQuorum.status).toBe(200);

    const invalid = await fetch(`${baseUrl}/api/v1/admin/rooms/create`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          mode: 'puntos',
          max_players: 4,
          num_problems: 1,
          categories: ['facil'],
          time_per_problem_s: 60,
        },
      }),
    });
    expect(invalid.status).toBe(400);

    const seniorDifficulty = await fetch(`${baseUrl}/api/v1/admin/rooms/create`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          mode: 'puntos',
          max_players: 2,
          num_problems: 1,
          categories: ['dificil'],
          time_per_problem_s: 60,
        },
      }),
    });
    expect(seniorDifficulty.status).toBe(201);

    const inactiveDifficulty = await fetch(`${baseUrl}/api/v1/admin/rooms/create`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          mode: 'puntos',
          max_players: 2,
          num_problems: 1,
          categories: ['muy_facil'],
          time_per_problem_s: 60,
        },
      }),
    });
    expect(inactiveDifficulty.status).toBe(400);
  });

  it('admin puede crear y unirse desde la API principal; el primer jugador del lobby admin queda como host', async () => {
    const ordinaryRoomResponse = await fetch(`${baseUrl}/api/v1/rooms`, {
      method: 'POST',
      headers: { Cookie: userCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          mode: 'puntos',
          max_players: 2,
          num_problems: 1,
          categories: ['facil'],
          time_per_problem_s: 60,
        },
      }),
    });
    expect(ordinaryRoomResponse.status).toBe(201);
    const ordinaryRoom = (await ordinaryRoomResponse.json()) as { room_code: string };
    const adminJoined = await fetch(`${baseUrl}/api/v1/rooms/${ordinaryRoom.room_code}/join`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ gamertag: 'admin-duelodev' }),
    });
    expect(adminJoined.status).toBe(200);

    const adminCreated = await fetch(`${baseUrl}/api/v1/rooms`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          mode: 'puntos',
          max_players: 2,
          num_problems: 1,
          categories: ['facil'],
          time_per_problem_s: 60,
        },
      }),
    });
    expect(adminCreated.status).toBe(201);
    const mainPageRoom = (await adminCreated.json()) as { room_code: string };
    const mainPageAccess = await fetch(`${baseUrl}/api/v1/rooms/${mainPageRoom.room_code}`, {
      headers: { Cookie: adminCookie },
    });
    expect(mainPageAccess.status).toBe(200);
    expect((await mainPageAccess.json()).players).toHaveLength(1);
  });

  it('lista salas, ordena el ranking y audita el ganador manual', async () => {
    const playerRoomResponse = await fetch(`${baseUrl}/api/v1/rooms`, {
      method: 'POST',
      headers: { Cookie: userCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          mode: 'puntos',
          max_players: 2,
          num_problems: 1,
          categories: ['facil'],
          time_per_problem_s: 60,
        },
      }),
    });
    expect(playerRoomResponse.status).toBe(201);
    const playerRoom = (await playerRoomResponse.json()) as { match_id: string };

    const roomsResponse = await fetch(`${baseUrl}/api/v1/admin/rooms`, {
      headers: { Cookie: adminCookie },
    });
    expect(roomsResponse.status).toBe(200);
    const rooms = (await roomsResponse.json()) as {
      rooms: Array<{ match_id: string; players: Array<{ user_id: string }> }>;
    };
    const room = rooms.rooms.find((candidate) => candidate.match_id === playerRoom.match_id);
    expect(room).toBeDefined();
    const playerRoomDetails = room!;
    const adminPlayer = playerRoomDetails.players[0]!;

    const result = await fetch(
      `${baseUrl}/api/v1/admin/rooms/${playerRoomDetails.match_id}/result`,
      {
        method: 'POST',
        headers: { Cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ winner_ids: [adminPlayer.user_id] }),
      },
    );
    expect(result.status).toBe(200);
    const resultBody = (await result.json()) as {
      room: { status: string; winner_ids: string[] };
      audited: boolean;
    };
    expect(resultBody.room.status).toBe('finished');
    expect(resultBody.room.winner_ids).toEqual([adminPlayer.user_id]);
    expect(resultBody.audited).toBe(true);

    const ranking = await fetch(`${baseUrl}/api/v1/admin/ranking`, {
      headers: { Cookie: adminCookie },
    });
    expect(ranking.status).toBe(200);
    expect(
      ((await ranking.json()) as { ranking: Array<{ user_id: string; wins: number }> }).ranking[0]
        ?.wins,
    ).toBe(1);

    const events = await app.ctx.eventRepo!.findEventsByName('admin_result_overridden');
    expect(events).toHaveLength(1);
  });

  it('permite cerrar una sala, repetir la operación y cerrar todas las activas', async () => {
    const createRoom = async () => {
      const response = await fetch(`${baseUrl}/api/v1/admin/rooms/create`, {
        method: 'POST',
        headers: { Cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          config: {
            mode: 'puntos',
            max_players: 2,
            num_problems: 1,
            categories: ['facil'],
            time_per_problem_s: 60,
          },
        }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { match_id: string };
    };

    const first = await createRoom();
    const second = await createRoom();

    const forbidden = await fetch(`${baseUrl}/api/v1/admin/rooms/${first.match_id}/close`, {
      method: 'POST',
      headers: { Cookie: userCookie },
    });
    expect(forbidden.status).toBe(403);

    const closeOne = await fetch(`${baseUrl}/api/v1/admin/rooms/${first.match_id}/close`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
    });
    expect(closeOne.status).toBe(200);
    expect((await closeOne.json()).room.status).toBe('abandoned');

    const closeAgain = await fetch(`${baseUrl}/api/v1/admin/rooms/${first.match_id}/close`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
    });
    expect(closeAgain.status).toBe(200);
    expect((await closeAgain.json()).closed).toBe(false);

    const closeAll = await fetch(`${baseUrl}/api/v1/admin/rooms/close-all`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
    });
    expect(closeAll.status).toBe(200);
    const closeAllBody = (await closeAll.json()) as {
      rooms: Array<{ match_id: string; status: string }>;
      closed_count: number;
    };
    expect(closeAllBody.closed_count).toBeGreaterThanOrEqual(1);
    expect(closeAllBody.rooms.find((room) => room.match_id === second.match_id)?.status).toBe(
      'abandoned',
    );
    const closeNotifications = controlNotifications.filter(
      (notification) => notification.type === 'match_closed',
    );
    expect(
      closeNotifications.some((notification) => notification.match_id === first.match_id),
    ).toBe(true);
    expect(
      closeNotifications.some((notification) => notification.match_id === second.match_id),
    ).toBe(true);
  });

  it('administra la política de creación y deja disponibles las uniones', async () => {
    const policy = await fetch(`${baseUrl}/api/v1/admin/room-policy`, {
      headers: { Cookie: adminCookie },
    });
    expect(policy.status).toBe(200);
    expect((await policy.json()).registered_users_can_create_rooms).toBe(true);

    const created = await fetch(`${baseUrl}/api/v1/admin/rooms/create`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          mode: 'puntos',
          max_players: 2,
          num_problems: 1,
          categories: ['facil'],
          time_per_problem_s: 60,
        },
      }),
    });
    expect(created.status).toBe(201);
    const room = (await created.json()) as { room_code: string };

    const changed = await fetch(`${baseUrl}/api/v1/admin/room-policy`, {
      method: 'PUT',
      headers: { Cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ registered_users_can_create_rooms: false }),
    });
    expect(changed.status).toBe(200);
    expect((await changed.json()).registered_users_can_create_rooms).toBe(false);

    const forbiddenCreate = await fetch(`${baseUrl}/api/v1/rooms`, {
      method: 'POST',
      headers: { Cookie: userCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          mode: 'puntos',
          max_players: 2,
          num_problems: 1,
          categories: ['facil'],
          time_per_problem_s: 60,
        },
      }),
    });
    expect(forbiddenCreate.status).toBe(403);
    expect((await forbiddenCreate.json()).error.code).toBe(ERROR_CODES.ROOM_CREATION_DISABLED);

    const allowedJoin = await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/join`, {
      method: 'POST',
      headers: { Cookie: userCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ gamertag: 'player-admin-test' }),
    });
    expect(allowedJoin.status).toBe(200);

    await fetch(`${baseUrl}/api/v1/admin/room-policy`, {
      method: 'PUT',
      headers: { Cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ registered_users_can_create_rooms: true }),
    });
    expect(await app.ctx.eventRepo!.countEvents('room_creation_policy_changed')).toBe(2);
  });

  it('elimina salas individuales y registra la acción antes y después del borrado', async () => {
    const created = await fetch(`${baseUrl}/api/v1/admin/rooms/create`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          mode: 'puntos',
          max_players: 2,
          num_problems: 1,
          categories: ['facil'],
          time_per_problem_s: 60,
        },
      }),
    });
    expect(created.status).toBe(201);
    const room = (await created.json()) as { match_id: string; room_code: string };

    const forbidden = await fetch(`${baseUrl}/api/v1/admin/rooms/${room.match_id}`, {
      method: 'DELETE',
      headers: { Cookie: userCookie },
    });
    expect(forbidden.status).toBe(403);

    const deleted = await fetch(`${baseUrl}/api/v1/admin/rooms/${room.match_id}`, {
      method: 'DELETE',
      headers: { Cookie: adminCookie },
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({
      match_id: room.match_id,
      room_code: room.room_code,
      deleted: true,
      audited: true,
    });
    expect(await app.ctx.roomRepo.findMatchById(room.match_id)).toBeNull();
    expect(await app.ctx.roomRepo.findMatchByRoomCode(room.room_code)).toBeNull();
    expect(await app.ctx.roomRepo.findPlayersByMatchId(room.match_id)).toEqual([]);
    expect(await app.ctx.eventRepo!.countEvents('admin_match_deletion_requested')).toBe(1);
    expect(await app.ctx.eventRepo!.countEvents('admin_match_deleted')).toBe(1);
    const roomEvents = await app.ctx.eventRepo!.findEventsByAggregate('match', room.match_id);
    expect(roomEvents.map((event) => event.event_name)).toContain('admin_room_closed');
  });

  it('borra lotes aislados de salas activas e historial terminal con auditoría', async () => {
    const roomRepo = new InMemoryRoomRepository();
    const userRepo = new InMemoryUserRepository();
    const eventRepo = new InMemoryEventRepository();
    const auditService = new AuditService(eventRepo);
    const admin = await userRepo.create({
      email: ADMIN_ALLOWED_EMAIL,
      gamertag: 'batch-admin',
      role: 'admin',
    });
    const activeMatch = await roomRepo.createMatch({
      room_code: 'ACTIVE1',
      mode: 'puntos',
      status: 'lobby',
      config: {
        mode: 'puntos',
        max_players: 2,
        num_problems: 1,
        categories: ['facil'],
        time_per_problem_s: 60,
      },
      host_id: admin.id,
    });
    const finishedMatch = await roomRepo.createMatch({
      room_code: 'HISTORY',
      mode: 'puntos',
      status: 'finished',
      config: {
        mode: 'puntos',
        max_players: 2,
        num_problems: 1,
        categories: ['facil'],
        time_per_problem_s: 60,
      },
      host_id: admin.id,
    });
    const adminService = new AdminService({ roomRepo, userRepo, auditService });

    const active = await adminService.deleteAllActiveRooms(admin.id);
    expect(active).toMatchObject({ match_ids: [activeMatch.id], deleted_count: 1, audited: true });
    expect(await roomRepo.findMatchById(activeMatch.id)).toBeNull();

    const history = await adminService.deleteAllHistoricalRooms(admin.id);
    expect(history).toMatchObject({
      match_ids: [finishedMatch.id],
      deleted_count: 1,
      audited: true,
    });
    expect(await roomRepo.findMatchById(finishedMatch.id)).toBeNull();
    expect(await eventRepo.countEvents('admin_match_deleted')).toBe(2);
  });

  it('rechaza purgas masivas sin la frase de confirmación exacta', async () => {
    const rejected = await fetch(`${baseUrl}/api/v1/admin/rooms/delete-history`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'BORRAR TODO' }),
    });
    expect(rejected.status).toBe(400);
  });
});
