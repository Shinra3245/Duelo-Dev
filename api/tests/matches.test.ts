import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  ERROR_CODES,
  type ApiError,
  type AuthUserResponse,
  type MatchSummaryResponse,
  type PuntosMatchConfig,
  type RoomCreatedResponse,
} from '@duelodev/shared';
import { createApp, type ApiApp } from '../src/app.js';
import { AUTH_COOKIE_NAMES } from '../src/plugins/cookies.js';

describe('Matches REST API (/api/v1/matches)', () => {
  let app: ApiApp;
  let baseUrl: string;

  beforeAll(async () => {
    app = createApp({
      serviceName: 'api-matches-test',
      authSecret: 'test-matches-secret-duelodev-1234567890',
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

  const validPuntosConfig: PuntosMatchConfig = {
    mode: 'puntos',
    max_players: 3,
    categories: ['facil'],
    num_problems: 3,
    time_per_problem_s: 60,
  };

  describe('GET /api/v1/matches/:id/summary', () => {
    it('rechaza con 401 si no hay autenticación', async () => {
      const res = await fetch(`${baseUrl}/api/v1/matches/${randomUUID()}/summary`);
      expect(res.status).toBe(401);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.UNAUTHENTICATED);
    });

    it('rechaza con 405 si el método no es GET ni HEAD', async () => {
      const user = await registerUser('mat-meth@test.com', 'MatMethod');
      const res = await fetch(`${baseUrl}/api/v1/matches/${randomUUID()}/summary`, {
        method: 'POST',
        headers: { Cookie: user.cookieHeader },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
    });

    it('rechaza con 404 si la partida no existe', async () => {
      const user = await registerUser('mat-notfound@test.com', 'MatNotFound');
      const res = await fetch(`${baseUrl}/api/v1/matches/${randomUUID()}/summary`, {
        headers: { Cookie: user.cookieHeader },
      });
      expect(res.status).toBe(404);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.ROOM_NOT_FOUND);
    });

    it('rechaza con 403 si el usuario autenticado no pertenece a la partida', async () => {
      const host = await registerUser('mat-host@test.com', 'MatHost');
      const outsider = await registerUser('mat-outsider@test.com', 'MatOutsider');

      const roomRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: host.cookieHeader,
        },
        body: JSON.stringify({ config: validPuntosConfig }),
      });
      const room = (await roomRes.json()) as RoomCreatedResponse;

      const res = await fetch(`${baseUrl}/api/v1/matches/${room.match_id}/summary`, {
        headers: { Cookie: outsider.cookieHeader },
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.NOT_A_PLAYER);
    });

    it('rechaza con 409 si la partida está en lobby, running o settling (no finalizada)', async () => {
      const host = await registerUser('mat-status-h@test.com', 'MatStatusHost');
      const player = await registerUser('mat-status-p@test.com', 'MatStatusPlayer');

      const roomRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: host.cookieHeader,
        },
        body: JSON.stringify({ config: validPuntosConfig }),
      });
      const room = (await roomRes.json()) as RoomCreatedResponse;

      // 1. En estado 'lobby'
      const resLobby = await fetch(`${baseUrl}/api/v1/matches/${room.match_id}/summary`, {
        headers: { Cookie: host.cookieHeader },
      });
      expect(resLobby.status).toBe(409);
      const lobbyData = (await resLobby.json()) as ApiError;
      expect(lobbyData.error.code).toBe(ERROR_CODES.CONFLICT);

      // Unir player y arrancar a 'running'
      await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/join`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: player.cookieHeader,
        },
        body: JSON.stringify({ gamertag: 'MatStatusPlayer' }),
      });
      await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/start`, {
        method: 'POST',
        headers: { Cookie: host.cookieHeader },
      });

      // 2. En estado 'running'
      const resRunning = await fetch(`${baseUrl}/api/v1/matches/${room.match_id}/summary`, {
        headers: { Cookie: host.cookieHeader },
      });
      expect(resRunning.status).toBe(409);

      // 3. En estado 'settling'
      await app.ctx.roomRepo.updateMatch(room.match_id, { status: 'settling' });
      const resSettling = await fetch(`${baseUrl}/api/v1/matches/${room.match_id}/summary`, {
        headers: { Cookie: host.cookieHeader },
      });
      expect(resSettling.status).toBe(409);
    });

    it('retorna 200 OK con clasificación oficial y snapshots revelados respetando privacidad', async () => {
      const host = await registerUser('mat-fin-h@test.com', 'MatFinHost');
      const playerA = await registerUser('mat-fin-a@test.com', 'MatFinPlayerA');
      const playerB = await registerUser('mat-fin-b@test.com', 'MatFinPlayerB');

      const roomRes = await fetch(`${baseUrl}/api/v1/rooms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: host.cookieHeader,
        },
        body: JSON.stringify({ config: validPuntosConfig }),
      });
      const room = (await roomRes.json()) as RoomCreatedResponse;

      await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/join`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: playerA.cookieHeader,
        },
        body: JSON.stringify({ gamertag: 'MatFinPlayerA' }),
      });

      await fetch(`${baseUrl}/api/v1/rooms/${room.room_code}/join`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: playerB.cookieHeader,
        },
        body: JSON.stringify({ gamertag: 'MatFinPlayerB' }),
      });

      // Configurar marcadores finales:
      // Player A: score=2, cases_total=10, time_total_ms=45000 -> 1er puesto
      // Host: score=1, cases_total=5, time_total_ms=30000 -> 2do puesto
      // Player B: score=0, cases_total=2, time_total_ms=60000 -> 3er puesto
      const hostPlayer = await app.ctx.roomRepo.findPlayer(room.match_id, host.userId);
      const pAPlayer = await app.ctx.roomRepo.findPlayer(room.match_id, playerA.userId);
      const pBPlayer = await app.ctx.roomRepo.findPlayer(room.match_id, playerB.userId);

      await app.ctx.roomRepo.updatePlayer(hostPlayer!.id, {
        score: 1,
        cases_total: 5,
        time_total_ms: 30000,
        is_revealed: true, // Host autoriza revelar su código
      });

      await app.ctx.roomRepo.updatePlayer(pAPlayer!.id, {
        score: 2,
        cases_total: 10,
        time_total_ms: 45000,
        is_revealed: true, // Player A autoriza revelar su código
      });

      await app.ctx.roomRepo.updatePlayer(pBPlayer!.id, {
        score: 0,
        cases_total: 2,
        time_total_ms: 60000,
        is_revealed: false, // Player B NO autoriza revelar su código a rivales
      });

      // Guardar snapshots de código
      const roundId = randomUUID();
      const problemId = randomUUID();

      await app.ctx.roomRepo.saveSnapshot({
        match_id: room.match_id,
        round_id: roundId,
        user_id: host.userId,
        problem_id: problemId,
        language: 'python',
        source_code: 'print("host code")',
      });

      await app.ctx.roomRepo.saveSnapshot({
        match_id: room.match_id,
        round_id: roundId,
        user_id: playerA.userId,
        problem_id: problemId,
        language: 'python',
        source_code: 'print("playerA code")',
      });

      await app.ctx.roomRepo.saveSnapshot({
        match_id: room.match_id,
        round_id: roundId,
        user_id: playerB.userId,
        problem_id: problemId,
        language: 'cpp',
        source_code: 'int main() { return 0; }',
      });

      // Snapshot vaciado por retención: conserva metadata, pero no expone código vacío.
      await app.ctx.roomRepo.saveSnapshot({
        match_id: room.match_id,
        round_id: randomUUID(),
        user_id: playerA.userId,
        problem_id: problemId,
        language: 'python',
        source_code: '',
      });

      // Actualizar partida a 'finished'
      const startedAt = new Date(Date.now() - 120000).toISOString();
      const finishedAt = new Date().toISOString();
      await app.ctx.roomRepo.updateMatch(room.match_id, {
        status: 'finished',
        started_at: startedAt,
        finished_at: finishedAt,
        winner_ids: [playerA.userId],
        finish_reason: 'target_reached',
      });

      // Consulta del resumen por parte de Player A (ganador)
      const resA = await fetch(`${baseUrl}/api/v1/matches/${room.match_id}/summary`, {
        headers: { Cookie: playerA.cookieHeader },
      });
      expect(resA.status).toBe(200);
      const summaryA = (await resA.json()) as MatchSummaryResponse;

      expect(summaryA.match_id).toBe(room.match_id);
      expect(summaryA.mode).toBe('puntos');
      expect(summaryA.status).toBe('finished');
      expect(summaryA.finish_reason).toBe('target_reached');
      expect(summaryA.winner_ids).toEqual([playerA.userId]);
      expect(summaryA.started_at).toBe(startedAt);
      expect(summaryA.finished_at).toBe(finishedAt);

      // Verificación de orden oficial en final_scores:
      expect(summaryA.final_scores).toHaveLength(3);
      expect(summaryA.final_scores[0]!.user_id).toBe(playerA.userId);
      expect(summaryA.final_scores[0]!.score).toBe(2);
      expect(summaryA.final_scores[1]!.user_id).toBe(host.userId);
      expect(summaryA.final_scores[1]!.score).toBe(1);
      expect(summaryA.final_scores[2]!.user_id).toBe(playerB.userId);
      expect(summaryA.final_scores[2]!.score).toBe(0);

      // Verificación de privacidad de snapshots para Player A:
      // Player A ve su propio código y el de Host (is_revealed: true).
      // NO debe ver el código de Player B (is_revealed: false).
      const visibleUsersA = summaryA.snapshots.map((s) => s.user_id);
      expect(visibleUsersA).toContain(playerA.userId);
      expect(visibleUsersA).toContain(host.userId);
      expect(visibleUsersA).not.toContain(playerB.userId);
      expect(summaryA.snapshots.every((snapshot) => snapshot.source_code.length > 0)).toBe(true);

      // Consulta del resumen por parte de Player B:
      // Player B ve su PROPIO código (aunque is_revealed sea false) más los de Host y Player A
      const resB = await fetch(`${baseUrl}/api/v1/matches/${room.match_id}/summary`, {
        headers: { Cookie: playerB.cookieHeader },
      });
      expect(resB.status).toBe(200);
      const summaryB = (await resB.json()) as MatchSummaryResponse;
      const visibleUsersB = summaryB.snapshots.map((s) => s.user_id);
      expect(visibleUsersB).toContain(playerB.userId);
      expect(visibleUsersB).toContain(playerA.userId);
      expect(visibleUsersB).toContain(host.userId);

      // Soporte HEAD
      const headRes = await fetch(`${baseUrl}/api/v1/matches/${room.match_id}/summary`, {
        method: 'HEAD',
        headers: { Cookie: playerA.cookieHeader },
      });
      expect(headRes.status).toBe(200);
    });
  });
});
