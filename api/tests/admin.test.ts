import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp, type ApiApp } from '../src/app.js';
import { hashPassword } from '../src/services/password.js';
import { ADMIN_ALLOWED_EMAIL } from '../src/services/admin.js';
import { ensureConfiguredAdmin } from '../src/services/admin.js';
import { InMemoryUserRepository } from '../src/repositories/memory.js';
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
          categories: ['muy_facil'],
          time_per_problem_s: 60,
        },
      }),
    });
    expect(valid.status).toBe(201);

    const invalid = await fetch(`${baseUrl}/api/v1/admin/rooms/create`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          mode: 'puntos',
          max_players: 4,
          num_problems: 1,
          categories: ['muy_facil'],
          time_per_problem_s: 60,
        },
      }),
    });
    expect(invalid.status).toBe(400);

    const inactiveDifficulty = await fetch(`${baseUrl}/api/v1/admin/rooms/create`, {
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
    expect(inactiveDifficulty.status).toBe(400);
  });

  it('lista salas, ordena el ranking y audita el ganador manual', async () => {
    const roomsResponse = await fetch(`${baseUrl}/api/v1/admin/rooms`, {
      headers: { Cookie: adminCookie },
    });
    expect(roomsResponse.status).toBe(200);
    const rooms = (await roomsResponse.json()) as {
      rooms: Array<{ match_id: string; players: Array<{ user_id: string }> }>;
    };
    expect(rooms.rooms).toHaveLength(1);
    const room = rooms.rooms[0]!;
    const adminPlayer = room.players[0]!;

    const result = await fetch(`${baseUrl}/api/v1/admin/rooms/${room.match_id}/result`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ winner_ids: [adminPlayer.user_id] }),
    });
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
            categories: ['muy_facil'],
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
    expect(controlNotifications).toHaveLength(2);
    expect(controlNotifications.every((notification) => notification.type === 'match_closed')).toBe(
      true,
    );
  });
});
