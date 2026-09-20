import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { C2S, S2C } from '@duelodev/shared';
import { createRealtimeServer, type RealtimeServer } from '../src/server.js';
import type { RealtimeMatchSession } from '../src/types.js';

const TEST_SECRET = 'test-auth-secret-key-1234567890';

function createTestToken(
  payload: { userId: string; gamertag: string; role?: string; exp?: number },
  secret: string = TEST_SECRET,
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      userId: payload.userId,
      gamertag: payload.gamertag,
      role: payload.role ?? 'user',
      exp: payload.exp ?? Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function createSampleSession(matchId: string): RealtimeMatchSession {
  const players = new Map();
  players.set('user-1', {
    user_id: 'user-1',
    gamertag: 'coder1',
    connection: 'disconnected' as const,
    is_ready: false,
    is_revealed: false,
    current_problem_idx: 0,
    last_seen_at: 1000,
  });
  players.set('user-2', {
    user_id: 'user-2',
    gamertag: 'coder2',
    connection: 'disconnected' as const,
    is_ready: false,
    is_revealed: false,
    current_problem_idx: 0,
    last_seen_at: 1000,
  });

  return {
    match_id: matchId,
    room_code: 'ROOM01',
    mode: 'puntos',
    config: {
      mode: 'puntos',
      num_problems: 3,
      categories: ['facil'],
      max_players: 2,
      time_per_problem_s: 300,
    },
    status: 'running',
    round_status: 'open',
    current_round_id: 'round-1',
    current_round_idx: 0,
    state_version: 1,
    players,
    scores: [
      {
        user_id: 'user-1',
        gamertag: 'coder1',
        score: 0,
        cases_total: 0,
        time_total_ms: 0,
        current_problem_idx: 0,
      },
      {
        user_id: 'user-2',
        gamertag: 'coder2',
        score: 0,
        cases_total: 0,
        time_total_ms: 0,
        current_problem_idx: 0,
      },
    ],
    created_at: new Date(1000).toISOString(),
  };
}

describe('Native WebSocket Transport & Adapter (F3 Unidad 6)', () => {
  let server: RealtimeServer;
  let serverPort: number;

  beforeEach(async () => {
    server = createRealtimeServer({
      authSecret: TEST_SECRET,
      reconnectGraceMs: 2000,
    });
    const addr = await server.start(0, '127.0.0.1');
    serverPort = addr.port;
  });

  afterEach(async () => {
    await server.close();
  });

  it('rechaza conexión WebSocket a /match con 401 si falta token de autenticación', async () => {
    const ws = new globalThis.WebSocket(`ws://127.0.0.1:${serverPort}/match`);

    const closeOrErrorPromise = new Promise<{ failed: boolean }>((resolve) => {
      ws.onerror = () => {
        resolve({ failed: true });
      };
      ws.onclose = () => {
        resolve({ failed: true });
      };
    });

    const result = await closeOrErrorPromise;
    expect(result.failed).toBe(true);
  });

  it('permite conexión a /match con token válido en query y despacha eventos C2S/S2C', async () => {
    const session = createSampleSession('match-ws-1');
    await server.ctx.matchStore.saveMatch(session);

    const token = createTestToken({ userId: 'user-1', gamertag: 'coder1' });
    const ws = new globalThis.WebSocket(`ws://127.0.0.1:${serverPort}/match?token=${token}`);

    const openPromise = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });
    await openPromise;

    // Enviar C2S.JOIN_MATCH
    const messagesReceived: Array<{ event: string; payload: unknown }> = [];
    const invalidJoinPromise = new Promise<Record<string, unknown>>((resolve) => {
      ws.onmessage = (event) => {
        const parsed = JSON.parse(String(event.data)) as { event: string; payload: unknown };
        messagesReceived.push(parsed);
        if (parsed.event === S2C.ERROR) {
          resolve(parsed.payload as Record<string, unknown>);
        }
      };
    });
    ws.send(JSON.stringify({ event: C2S.JOIN_MATCH, payload: { match_id: 42 } }));
    await expect(invalidJoinPromise).resolves.toMatchObject({
      message: 'match_id debe ser un identificador válido.',
    });

    const messagePromise = new Promise<void>((resolve) => {
      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data));
          messagesReceived.push(parsed);
          if (parsed.event === S2C.MATCH_SYNC) {
            resolve();
          }
        } catch {
          // Ignorar frames no json
        }
      };
    });

    ws.send(JSON.stringify({ event: C2S.JOIN_MATCH, payload: { match_id: 'match-ws-1' } }));
    await messagePromise;

    const syncMsg = messagesReceived.find((m) => m.event === S2C.MATCH_SYNC);
    expect(syncMsg).toBeDefined();
    expect((syncMsg?.payload as Record<string, unknown>).match_id).toBe('match-ws-1');

    // Enviar C2S.HEARTBEAT y recibir heartbeat_ack
    const heartbeatPromise = new Promise<void>((resolve) => {
      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data));
          if (parsed.event === 'heartbeat_ack') {
            resolve();
          }
        } catch {
          // Ignorar
        }
      };
    });

    ws.send(JSON.stringify({ event: C2S.HEARTBEAT, payload: {} }));
    await heartbeatPromise;

    ws.close();
  });

  it('acepta LEAVE_MATCH y publica la victoria por abandono al rival activo', async () => {
    const session = createSampleSession('match-ws-leave');
    session.problem_ids = ['problem-1'];
    await server.ctx.matchStore.saveMatch(session);

    const player = new globalThis.WebSocket(
      `ws://127.0.0.1:${serverPort}/match?token=${createTestToken({ userId: 'user-1', gamertag: 'coder1' })}`,
    );
    const leaver = new globalThis.WebSocket(
      `ws://127.0.0.1:${serverPort}/match?token=${createTestToken({ userId: 'user-2', gamertag: 'coder2' })}`,
    );
    const opened = (socket: WebSocket) =>
      new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = (error) => reject(error);
      });
    await Promise.all([opened(player), opened(leaver)]);

    const nextEvent = (socket: WebSocket, eventName: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          socket.removeEventListener('message', onMessage);
          reject(new Error(`Timeout esperando ${eventName}`));
        }, 3000);
        const onMessage = (event: MessageEvent) => {
          const message = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (message.event !== eventName) return;
          clearTimeout(timeout);
          socket.removeEventListener('message', onMessage);
          resolve(message);
        };
        socket.addEventListener('message', onMessage);
      });

    const playerSync = nextEvent(player, S2C.MATCH_SYNC);
    player.send(JSON.stringify({ event: C2S.JOIN_MATCH, payload: { match_id: session.match_id } }));
    await playerSync;
    const leaverSync = nextEvent(leaver, S2C.MATCH_SYNC);
    leaver.send(JSON.stringify({ event: C2S.JOIN_MATCH, payload: { match_id: session.match_id } }));
    await leaverSync;

    const statusPromise = nextEvent(player, S2C.PLAYER_STATUS);
    const finishedPromise = nextEvent(player, S2C.MATCH_FINISHED);
    leaver.send(JSON.stringify({ event: C2S.LEAVE_MATCH, payload: {} }));
    const [statusMessage, finishedMessage] = await Promise.all([statusPromise, finishedPromise]);

    expect(statusMessage.payload).toMatchObject({ user_id: 'user-2', status: 'left' });
    expect(finishedMessage.payload).toMatchObject({
      finish_reason: 'abandonment',
      winner_ids: ['user-1'],
    });
    expect((await server.ctx.matchStore.getMatch(session.match_id))?.status).toBe('finished');

    player.close();
    leaver.close();
  });

  it('permite conexión binaria a /yjs/{matchId}/{userId} para el dueño del documento', async () => {
    const session = createSampleSession('match-ws-yjs');
    await server.ctx.matchStore.saveMatch(session);

    const token = createTestToken({ userId: 'user-1', gamertag: 'coder1' });
    const ws = new globalThis.WebSocket(
      `ws://127.0.0.1:${serverPort}/yjs/match-ws-yjs/user-1?token=${token}`,
    );
    ws.binaryType = 'arraybuffer';

    const openPromise = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });
    await openPromise;

    // Enviar update binario Yjs
    const updateBytes = new Uint8Array([0, 1, 2, 3, 4]);
    expect(() => ws.send(updateBytes)).not.toThrow();

    ws.close();
  });

  it('sincroniza el código textual entre dueño y rival revelado', async () => {
    const session = createSampleSession('match-ws-yjs-text');
    session.players.get('user-1')!.is_revealed = true;
    await server.ctx.matchStore.saveMatch(session);

    const ownerToken = createTestToken({ userId: 'user-1', gamertag: 'coder1' });
    const rivalToken = createTestToken({ userId: 'user-2', gamertag: 'coder2' });
    const owner = new globalThis.WebSocket(
      `ws://127.0.0.1:${serverPort}/yjs/match-ws-yjs-text/user-1?token=${ownerToken}`,
    );
    const rival = new globalThis.WebSocket(
      `ws://127.0.0.1:${serverPort}/yjs/match-ws-yjs-text/user-1?token=${rivalToken}`,
    );

    const waitForMessage = (ws: WebSocket, type: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        ws.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (message.type === type) resolve(message);
        };
      });
    const ownerSync = waitForMessage(owner, 'sync');
    const rivalSync = waitForMessage(rival, 'sync');

    await Promise.all(
      [owner, rival].map(
        (ws) =>
          new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = (error) => reject(error);
          }),
      ),
    );
    expect(await ownerSync).toMatchObject({ target_user_id: 'user-1', source_code: '' });
    expect(await rivalSync).toMatchObject({ target_user_id: 'user-1', source_code: '' });

    const rivalUpdate = waitForMessage(rival, 'update');
    owner.send(JSON.stringify({ type: 'update', generation: 1, source_code: 'print(42)' }));
    expect(await rivalUpdate).toMatchObject({ source_code: 'print(42)', generation: 1 });
    expect(server.yjsHub.getDocument('match-ws-yjs-text', 'user-1')?.getText()).toBe('print(42)');

    owner.close();
    rival.close();
  });

  it('rechaza conexión WebSocket a ruta desconocida con 404', async () => {
    const ws = new globalThis.WebSocket(`ws://127.0.0.1:${serverPort}/ruta-inexistente`);

    const closeOrErrorPromise = new Promise<{ failed: boolean }>((resolve) => {
      ws.onerror = () => resolve({ failed: true });
      ws.onclose = () => resolve({ failed: true });
    });

    const result = await closeOrErrorPromise;
    expect(result.failed).toBe(true);
  });

  it('limpia todas las conexiones activas ordenadamente al cerrar el servidor', async () => {
    const session = createSampleSession('match-ws-clean');
    await server.ctx.matchStore.saveMatch(session);

    const token = createTestToken({ userId: 'user-1', gamertag: 'coder1' });
    const ws = new globalThis.WebSocket(`ws://127.0.0.1:${serverPort}/match?token=${token}`);

    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });

    const closePromise = new Promise<number>((resolve) => {
      ws.onclose = (event) => {
        resolve(event.code);
      };
    });

    // Cerrar servidor debe notificar y cerrar los WebSockets activos con 1001
    await server.close();

    const code = await closePromise;
    expect(code).toBe(1001);
  });
});
