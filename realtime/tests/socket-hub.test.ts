import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import {
  ERROR_CODES,
  S2C,
  type MatchFinishedPayload,
  type MatchStartedPayload,
  type MatchSyncPayload,
  type ProblemBeginPayload,
  type ScoreUpdatePayload,
  type SubmissionVerdictContext,
  type VerdictPayload,
} from '@duelodev/shared';
import { MatchHub } from '../src/socket/hub.js';
import type { SocketClient } from '../src/socket/types.js';
import { InMemoryMatchStore } from '../src/store/memory.js';
import type { RealtimeMatchSession } from '../src/types.js';
import { playerRoundId } from '../src/gamemodes/round-id.js';

interface MockSocketClient extends SocketClient {
  emittedEvents: Array<{ event: string; payload: unknown }>;
  errorsSent: Array<{ code: string; message: string; details?: unknown }>;
  roomsJoined: string[];
  roomsLeft: string[];
  disconnected: boolean;
}

function createMockClient(
  id: string,
  userId: string,
  gamertag: string,
  matchId?: string,
): MockSocketClient {
  const rooms = new Set<string>();
  const emittedEvents: Array<{ event: string; payload: unknown }> = [];
  const errorsSent: Array<{ code: string; message: string; details?: unknown }> = [];
  const roomsJoined: string[] = [];
  const roomsLeft: string[] = [];
  let disconnected = false;

  const client: MockSocketClient = {
    id,
    userId,
    gamertag,
    matchId,
    rooms,
    emittedEvents,
    errorsSent,
    roomsJoined,
    roomsLeft,
    get disconnected() {
      return disconnected;
    },
    join(room: string) {
      rooms.add(room);
      roomsJoined.push(room);
    },
    leave(room: string) {
      rooms.delete(room);
      roomsLeft.push(room);
    },
    emit(event: string, payload: unknown) {
      emittedEvents.push({ event, payload });
    },
    sendError(code: string, message: string, details?: unknown) {
      errorsSent.push({ code, message, details });
    },
    disconnect() {
      disconnected = true;
    },
  };

  return client;
}

function createSampleSession(
  matchId: string,
  playersConfig: Array<{ userId: string; gamertag: string }> = [
    { userId: 'user-1', gamertag: 'coder1' },
    { userId: 'user-2', gamertag: 'coder2' },
  ],
): RealtimeMatchSession {
  const players = new Map();
  for (const p of playersConfig) {
    players.set(p.userId, {
      user_id: p.userId,
      gamertag: p.gamertag,
      connection: 'disconnected' as const,
      is_ready: false,
      is_revealed: false,
      current_problem_idx: 0,
      last_seen_at: 1000,
    });
  }

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
    scores: playersConfig.map((p) => ({
      user_id: p.userId,
      gamertag: p.gamertag,
      score: 0,
      cases_total: 0,
      time_total_ms: 0,
      current_problem_idx: 0,
    })),
    created_at: new Date(1000).toISOString(),
  };
}

describe('MatchHub', () => {
  let store: InMemoryMatchStore;
  let hub: MatchHub;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new InMemoryMatchStore();
    hub = new MatchHub({
      matchStore: store,
      reconnectGraceMs: 5000,
    });
  });

  afterEach(() => {
    hub.clearAllGraceTimers();
    vi.useRealTimers();
  });

  describe('Registro y gestión de clientes y rooms', () => {
    it('registra clientes e indexa sockets por usuario', () => {
      const client1 = createMockClient('sock-1', 'user-1', 'coder1');
      const client2 = createMockClient('sock-2', 'user-1', 'coder1');

      hub.registerClient(client1);
      hub.registerClient(client2);

      expect(hub.clientCount).toBe(2);
      expect(hub.hasActiveSockets('user-1')).toBe(true);
      expect(hub.hasActiveSockets('user-2')).toBe(false);
    });

    it('desregistra clientes y limpia las salas cuando quedan vacías', () => {
      const client = createMockClient('sock-1', 'user-1', 'coder1');
      hub.registerClient(client);

      const room = hub.getOrCreateRoom('match:m1');
      room.clients.set(client.id, client);
      client.join('match:m1');

      expect(hub.roomCount).toBe(1);

      hub.unregisterClient(client.id);
      expect(hub.clientCount).toBe(0);
      expect(hub.hasActiveSockets('user-1')).toBe(false);
      expect(hub.roomCount).toBe(0);
    });
  });

  describe('C2S: handleJoinMatch', () => {
    it('valida que match_id no esté vacío', async () => {
      const client = createMockClient('sock-1', 'user-1', 'coder1');
      hub.registerClient(client);

      await hub.handleJoinMatch(client, { match_id: '' });

      expect(client.errorsSent).toHaveLength(1);
      expect(client.errorsSent[0]?.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });

    it('retorna error 404 si la partida no existe', async () => {
      const client = createMockClient('sock-1', 'user-1', 'coder1');
      hub.registerClient(client);

      await hub.handleJoinMatch(client, { match_id: 'non-existent' });

      expect(client.errorsSent).toHaveLength(1);
      expect(client.errorsSent[0]?.code).toBe(ERROR_CODES.NOT_FOUND);
    });

    it('retorna error 403 NOT_A_PLAYER si el usuario no pertenece a la partida', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const stranger = createMockClient('sock-stranger', 'user-stranger', 'stranger');
      hub.registerClient(stranger);

      await hub.handleJoinMatch(stranger, { match_id: 'match-1' });

      expect(stranger.errorsSent).toHaveLength(1);
      expect(stranger.errorsSent[0]?.code).toBe('NOT_A_PLAYER');
    });

    it('une exitosamente al jugador: actualiza presencia, difunde estado y envía sync personalizado', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const client1 = createMockClient('sock-1', 'user-1', 'coder1');
      const client2 = createMockClient('sock-2', 'user-2', 'coder2');
      hub.registerClient(client1);
      hub.registerClient(client2);

      // Pre-unir client2 para verificar difusión
      await hub.handleJoinMatch(client2, { match_id: 'match-1' });

      // client1 se une ahora
      await hub.handleJoinMatch(client1, { match_id: 'match-1' });

      // Verificaciones en store
      const updated = await store.getMatch('match-1');
      expect(updated?.players.get('user-1')?.connection).toBe('connected');
      expect(updated?.players.get('user-1')?.socket_id).toBe('sock-1');
      expect(updated?.state_version).toBe(3); // +1 por client2, +1 por client1

      // Verificaciones de difusión hacia client2
      const playerStatusEvents = client2.emittedEvents.filter((e) => e.event === S2C.PLAYER_STATUS);
      expect(playerStatusEvents.length).toBeGreaterThanOrEqual(1);
      const lastStatus = playerStatusEvents[playerStatusEvents.length - 1]?.payload as {
        user_id: string;
        status: string;
      };
      expect(lastStatus.user_id).toBe('user-1');
      expect(lastStatus.status).toBe('connected');

      // Verificaciones de sync personalizado para client1
      const syncEvent = client1.emittedEvents.find((e) => e.event === S2C.MATCH_SYNC);
      expect(syncEvent).toBeDefined();
      const syncPayload = syncEvent?.payload as {
        match_id: string;
        problem_index: number;
        players: Record<string, string>;
      };
      expect(syncPayload.match_id).toBe('match-1');
      expect(syncPayload.players['user-1']).toBe('connected');
    });
  });

  describe('C2S: handleToggleReveal', () => {
    it('valida que visible sea booleano', async () => {
      const client = createMockClient('sock-1', 'user-1', 'coder1', 'match-1');
      hub.registerClient(client);

      await hub.handleToggleReveal(client, { visible: 'true' as unknown as boolean });
      expect(client.errorsSent[0]?.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });

    it('falla si el cliente no está asociado a una partida', async () => {
      const client = createMockClient('sock-1', 'user-1', 'coder1');
      hub.registerClient(client);

      await hub.handleToggleReveal(client, { visible: true });
      expect(client.errorsSent[0]?.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });

    it('actualiza is_revealed y difunde REVEAL_CHANGED a la sala', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const client1 = createMockClient('sock-1', 'user-1', 'coder1');
      const client2 = createMockClient('sock-2', 'user-2', 'coder2');
      hub.registerClient(client1);
      hub.registerClient(client2);

      await hub.handleJoinMatch(client1, { match_id: 'match-1' });
      await hub.handleJoinMatch(client2, { match_id: 'match-1' });

      await hub.handleToggleReveal(client1, { visible: true });

      const updated = await store.getMatch('match-1');
      expect(updated?.players.get('user-1')?.is_revealed).toBe(true);

      const revealEvents = client2.emittedEvents.filter((e) => e.event === S2C.REVEAL_CHANGED);
      expect(revealEvents).toHaveLength(1);
      expect(revealEvents[0]?.payload).toMatchObject({
        match_id: 'match-1',
        user_id: 'user-1',
        visible: true,
      });
    });
  });

  describe('C2S: handleReady', () => {
    it('marca jugador como listo y difunde PLAYER_STATUS', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const client = createMockClient('sock-1', 'user-1', 'coder1');
      hub.registerClient(client);
      await hub.handleJoinMatch(client, { match_id: 'match-1' });

      await hub.handleReady(client);

      const updated = await store.getMatch('match-1');
      expect(updated?.players.get('user-1')?.is_ready).toBe(true);

      // Si se vuelve a llamar, es idempotente
      const versionBefore = updated?.state_version;
      await hub.handleReady(client);
      const notReUpdated = await store.getMatch('match-1');
      expect(notReUpdated?.state_version).toBe(versionBefore);
    });
  });

  describe('C2S: handleHeartbeat', () => {
    it('responde heartbeat_ack y actualiza last_seen_at si está en partida', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const client = createMockClient('sock-1', 'user-1', 'coder1');
      hub.registerClient(client);
      await hub.handleJoinMatch(client, { match_id: 'match-1' });

      vi.advanceTimersByTime(2000);
      await hub.handleHeartbeat(client);

      const ack = client.emittedEvents.find((e) => e.event === 'heartbeat_ack');
      expect(ack).toBeDefined();

      const updated = await store.getMatch('match-1');
      expect(updated?.players.get('user-1')?.last_seen_at).toBeGreaterThan(1000);
    });
  });

  describe('Desconexión y periodo de gracia de reconexión', () => {
    it('si el usuario tiene múltiples sockets, desconectar uno no cambia la presencia a reconnecting', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const sock1 = createMockClient('sock-1', 'user-1', 'coder1');
      const sock2 = createMockClient('sock-2', 'user-1', 'coder1');
      hub.registerClient(sock1);
      hub.registerClient(sock2);

      await hub.handleJoinMatch(sock1, { match_id: 'match-1' });

      await hub.handleDisconnect(sock2);

      const updated = await store.getMatch('match-1');
      expect(updated?.players.get('user-1')?.connection).toBe('connected');
    });

    it('si se desconecta el último socket, entra a reconnecting y expira a disconnected tras periodo de gracia', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const client1 = createMockClient('sock-1', 'user-1', 'coder1');
      const client2 = createMockClient('sock-2', 'user-2', 'coder2');
      hub.registerClient(client1);
      hub.registerClient(client2);

      await hub.handleJoinMatch(client1, { match_id: 'match-1' });
      await hub.handleJoinMatch(client2, { match_id: 'match-1' });

      // Desconectar client1
      await hub.handleDisconnect(client1);

      // Verificación de estado intermedio: reconnecting
      let updated = await store.getMatch('match-1');
      expect(updated?.players.get('user-1')?.connection).toBe('reconnecting');

      // Avanzar el reloj para agotar reconnectGraceMs (5000ms)
      await vi.advanceTimersByTimeAsync(5000);

      // Verificación de estado final: disconnected
      updated = await store.getMatch('match-1');
      expect(updated?.players.get('user-1')?.connection).toBe('disconnected');
    });

    it('si el usuario se reconecta antes de expirar la gracia, cancela el timer y permanece connected', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const sock1 = createMockClient('sock-1', 'user-1', 'coder1');
      hub.registerClient(sock1);
      await hub.handleJoinMatch(sock1, { match_id: 'match-1' });

      // Desconexión
      await hub.handleDisconnect(sock1);

      let updated = await store.getMatch('match-1');
      expect(updated?.players.get('user-1')?.connection).toBe('reconnecting');

      // Reconexión en 2 segundos (< 5000ms)
      vi.advanceTimersByTime(2000);
      const sockNew = createMockClient('sock-new', 'user-1', 'coder1');
      hub.registerClient(sockNew);
      await hub.handleJoinMatch(sockNew, { match_id: 'match-1' });

      updated = await store.getMatch('match-1');
      expect(updated?.players.get('user-1')?.connection).toBe('connected');

      // Avanzar más allá del timer original
      await vi.advanceTimersByTimeAsync(10000);

      // Debe seguir conectado, no haber pasado a disconnected
      updated = await store.getMatch('match-1');
      expect(updated?.players.get('user-1')?.connection).toBe('connected');
    });
  });

  describe('S2C: Difusión del servidor con aislamiento de información', () => {
    it('broadcastVerdict aísla compile_output: solo el dueño lo recibe (doc 04 §86)', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const owner = createMockClient('sock-owner', 'user-1', 'coder1');
      const rival = createMockClient('sock-rival', 'user-2', 'coder2');
      hub.registerClient(owner);
      hub.registerClient(rival);

      await hub.handleJoinMatch(owner, { match_id: 'match-1' });
      await hub.handleJoinMatch(rival, { match_id: 'match-1' });

      const verdictPayload: VerdictPayload = {
        match_id: 'match-1',
        round_id: 'round-1',
        submission_id: 'sub-1',
        user_id: 'user-1',
        verdict: 'AC',
        passed: 10,
        total: 10,
        exec_time_ms: 120,
        compile_output: 'Compilación exitosa sin advertencias.',
        server_time: 2000,
      };

      hub.broadcastVerdict('match-1', verdictPayload);

      const ownerVerdict = owner.emittedEvents.find((e) => e.event === S2C.VERDICT);
      const rivalVerdict = rival.emittedEvents.find((e) => e.event === S2C.VERDICT);

      expect(ownerVerdict).toBeDefined();
      expect(rivalVerdict).toBeDefined();

      // El dueño tiene compile_output
      expect((ownerVerdict?.payload as VerdictPayload).compile_output).toBe(
        'Compilación exitosa sin advertencias.',
      );

      // El rival NO tiene compile_output
      expect((rivalVerdict?.payload as VerdictPayload).compile_output).toBeUndefined();
    });

    it('broadcastScoreUpdate difunde SCORE_UPDATE a todos los clientes de la partida', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const client1 = createMockClient('sock-1', 'user-1', 'coder1');
      const client2 = createMockClient('sock-2', 'user-2', 'coder2');
      hub.registerClient(client1);
      hub.registerClient(client2);

      await hub.handleJoinMatch(client1, { match_id: 'match-1' });
      await hub.handleJoinMatch(client2, { match_id: 'match-1' });

      hub.broadcastScoreUpdate('match-1', session.scores, 2);

      const score1 = client1.emittedEvents.find((e) => e.event === S2C.SCORE_UPDATE);
      const score2 = client2.emittedEvents.find((e) => e.event === S2C.SCORE_UPDATE);

      expect(score1).toBeDefined();
      expect(score2).toBeDefined();
    });

    it('broadcastMatchStarted difunde MATCH_STARTED a la sala', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const client = createMockClient('sock-1', 'user-1', 'coder1');
      hub.registerClient(client);
      await hub.handleJoinMatch(client, { match_id: 'match-1' });

      const payload: MatchStartedPayload = {
        match_id: 'match-1',
        state_version: 1,
        server_time: 1000,
        mode: 'puntos',
        round_id: 'round-1',
        config: session.config,
      };

      hub.broadcastMatchStarted('match-1', payload);

      const started = client.emittedEvents.find((e) => e.event === S2C.MATCH_STARTED);
      expect(started?.payload).toEqual(payload);
    });

    it('broadcastMatchFinished difunde MATCH_FINISHED a la sala', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const client = createMockClient('sock-1', 'user-1', 'coder1');
      hub.registerClient(client);
      await hub.handleJoinMatch(client, { match_id: 'match-1' });

      const payload: MatchFinishedPayload = {
        match_id: 'match-1',
        status: 'finished',
        state_version: 5,
        server_time: 5000,
        winner_ids: ['user-1'],
        winner_id: 'user-1',
        finish_reason: 'target_reached',
        final_scores: session.scores,
        summary_url: '/matches/match-1/summary',
      };

      hub.broadcastMatchFinished('match-1', payload);

      const finished = client.emittedEvents.find((e) => e.event === S2C.MATCH_FINISHED);
      expect(finished?.payload).toEqual(payload);
    });

    it('cierra una partida por orden administrativo y cancela su estado activo', async () => {
      const session = createSampleSession('match-admin-close');
      await store.saveMatch(session);

      const client1 = createMockClient('sock-1', 'user-1', 'coder1');
      const client2 = createMockClient('sock-2', 'user-2', 'coder2');
      hub.registerClient(client1);
      hub.registerClient(client2);
      await hub.handleJoinMatch(client1, { match_id: session.match_id });
      await hub.handleJoinMatch(client2, { match_id: session.match_id });
      client1.emittedEvents.length = 0;
      client2.emittedEvents.length = 0;

      const closed = await hub.closeMatchFromAdmin(session.match_id, 5);

      expect(closed).toBe(true);
      expect((await store.getMatch(session.match_id))?.status).toBe('abandoned');
      for (const client of [client1, client2]) {
        expect(client.emittedEvents).toContainEqual({
          event: S2C.MATCH_FINISHED,
          payload: expect.objectContaining({
            match_id: session.match_id,
            state_version: 5,
            winner_ids: [],
            winner_id: null,
            finish_reason: 'admin_override',
          }),
        });
      }
    });
  });

  describe('Orquestación de modos de juego y temporizadores (F3 Unidad 5)', () => {
    it('startMatch en modo Puntos difunde MATCH_STARTED con problem_order y PROBLEM_BEGIN', async () => {
      const session = createSampleSession('match-puntos');
      session.status = 'lobby';
      await store.saveMatch(session);

      const client1 = createMockClient('sock-1', 'user-1', 'coder1');
      const client2 = createMockClient('sock-2', 'user-2', 'coder2');
      hub.registerClient(client1);
      hub.registerClient(client2);

      await hub.handleJoinMatch(client1, { match_id: 'match-puntos' });
      await hub.handleJoinMatch(client2, { match_id: 'match-puntos' });

      client1.emittedEvents.length = 0;
      client2.emittedEvents.length = 0;

      await hub.startMatch('match-puntos', ['p1', 'p2', 'p3']);

      // Verifica MATCH_STARTED
      const start1 = client1.emittedEvents.find((e) => e.event === S2C.MATCH_STARTED);
      const start2 = client2.emittedEvents.find((e) => e.event === S2C.MATCH_STARTED);
      expect(start1).toBeDefined();
      expect(start2).toBeDefined();
      const startPayload = start1?.payload as MatchStartedPayload;
      expect(startPayload.mode).toBe('puntos');
      expect(startPayload.problem_order).toEqual(['p1', 'p2', 'p3']);

      // Verifica PROBLEM_BEGIN
      const begin1 = client1.emittedEvents.find((e) => e.event === S2C.PROBLEM_BEGIN);
      const begin2 = client2.emittedEvents.find((e) => e.event === S2C.PROBLEM_BEGIN);
      expect(begin1).toBeDefined();
      expect(begin2).toBeDefined();
      const beginPayload = begin1?.payload as ProblemBeginPayload;
      expect(beginPayload.round_id).toBe('round-1');
      expect(beginPayload.problem_id).toBe('p1');
      expect(beginPayload.index).toBe(0);

      // Verifica sesión en store
      const updated = await store.getMatch('match-puntos');
      expect(updated?.status).toBe('running');
      expect(updated?.problem_ids).toEqual(['p1', 'p2', 'p3']);
      expect(updated?.round_ends_at).toBeGreaterThan(0);
    });

    it('startMatch en modo Rondas difunde MATCH_STARTED sin problem_order y envía PROBLEM_BEGIN a cada jugador', async () => {
      const session = createSampleSession('match-rondas');
      session.status = 'lobby';
      session.mode = 'rondas';
      session.config = {
        mode: 'rondas',
        num_problems: 3,
        categories: ['facil'],
        max_players: 2,
        match_duration_s: 300,
        target: 3,
      };
      await store.saveMatch(session);

      const client1 = createMockClient('sock-1', 'user-1', 'coder1');
      const client2 = createMockClient('sock-2', 'user-2', 'coder2');
      hub.registerClient(client1);
      hub.registerClient(client2);

      await hub.handleJoinMatch(client1, { match_id: 'match-rondas' });
      await hub.handleJoinMatch(client2, { match_id: 'match-rondas' });

      client1.emittedEvents.length = 0;
      client2.emittedEvents.length = 0;

      await hub.startMatch('match-rondas', ['p1', 'p2', 'p3']);

      // Verifica MATCH_STARTED sin problem_order
      const start1 = client1.emittedEvents.find((e) => e.event === S2C.MATCH_STARTED);
      expect(start1).toBeDefined();
      const startPayload = start1?.payload as MatchStartedPayload;
      expect(startPayload.mode).toBe('rondas');
      expect(startPayload.problem_order).toBeUndefined();

      // Verifica PROBLEM_BEGIN individual
      const begin1 = client1.emittedEvents.find((e) => e.event === S2C.PROBLEM_BEGIN);
      const begin2 = client2.emittedEvents.find((e) => e.event === S2C.PROBLEM_BEGIN);
      expect(begin1).toBeDefined();
      expect(begin2).toBeDefined();

      const begin1Payload = begin1?.payload as ProblemBeginPayload;
      expect(begin1Payload.round_id).toBe(playerRoundId('match-rondas', 'user-1', 0));
      expect(begin1Payload.problem_id).toBe('p1');
      expect(begin1Payload.index).toBe(0);

      const begin2Payload = begin2?.payload as ProblemBeginPayload;
      expect(begin2Payload.round_id).toBe(playerRoundId('match-rondas', 'user-2', 0));
      expect(begin2Payload.problem_id).toBe('p1');
      expect(begin2Payload.index).toBe(0);
    });

    it('processSubmissionVerdict en modo Puntos: AC adjudica punto, avanza ronda y difunde PROBLEM_BEGIN', async () => {
      const session = createSampleSession('match-puntos-verdict');
      session.status = 'lobby';
      await store.saveMatch(session);

      const client1 = createMockClient('sock-1', 'user-1', 'coder1');
      const client2 = createMockClient('sock-2', 'user-2', 'coder2');
      hub.registerClient(client1);
      hub.registerClient(client2);

      await hub.handleJoinMatch(client1, { match_id: 'match-puntos-verdict' });
      await hub.handleJoinMatch(client2, { match_id: 'match-puntos-verdict' });

      await hub.startMatch('match-puntos-verdict', ['p1', 'p2']);

      client1.emittedEvents.length = 0;
      client2.emittedEvents.length = 0;

      const submission: SubmissionVerdictContext = {
        submission_id: 'sub-1',
        user_id: 'user-1',
        round_id: 'round-1',
        problem_id: 'p1',
        admission_seq: 1,
        received_at: 1000,
        verdict: 'AC',
        passed_cases: 10,
        total_cases: 10,
        exec_time_ms: 150,
      };

      await hub.processSubmissionVerdict('match-puntos-verdict', submission, 'Compilation OK');

      // Veredicto: compile_output solo para user-1
      const v1 = client1.emittedEvents.find((e) => e.event === S2C.VERDICT)
        ?.payload as VerdictPayload;
      const v2 = client2.emittedEvents.find((e) => e.event === S2C.VERDICT)
        ?.payload as VerdictPayload;
      expect(v1.compile_output).toBe('Compilation OK');
      expect(v2.compile_output).toBeUndefined();

      // Score update
      const scoreEvent = client1.emittedEvents.find((e) => e.event === S2C.SCORE_UPDATE);
      expect(scoreEvent).toBeDefined();
      const scorePayload = scoreEvent?.payload as ScoreUpdatePayload;
      expect(scorePayload.scores.find((s) => s.user_id === 'user-1')?.score).toBe(1);

      // Siguiente ronda (p2)
      const nextRound = client1.emittedEvents.find((e) => e.event === S2C.PROBLEM_BEGIN);
      expect(nextRound).toBeDefined();
      const nextRoundPayload = nextRound?.payload as ProblemBeginPayload;
      expect(nextRoundPayload.round_id).toBe('round-2');
      expect(nextRoundPayload.problem_id).toBe('p2');
      expect(nextRoundPayload.index).toBe(1);
    });

    it('processSubmissionVerdict en modo Rondas: target alcanzado finaliza partida', async () => {
      const session = createSampleSession('match-rondas-target');
      session.status = 'lobby';
      session.mode = 'rondas';
      session.config = {
        mode: 'rondas',
        num_problems: 3,
        categories: ['facil'],
        max_players: 2,
        match_duration_s: 300,
        target: 3,
      };
      // user-1 ya tiene score 2
      session.scores[0]!.score = 2;
      session.scores[0]!.current_problem_idx = 2;
      await store.saveMatch(session);

      const client1 = createMockClient('sock-1', 'user-1', 'coder1');
      hub.registerClient(client1);
      await hub.handleJoinMatch(client1, { match_id: 'match-rondas-target' });

      // Iniciar
      await hub.startMatch('match-rondas-target', ['p1', 'p2', 'p3']);

      client1.emittedEvents.length = 0;

      const submission: SubmissionVerdictContext = {
        submission_id: 'sub-win',
        user_id: 'user-1',
        round_id: playerRoundId('match-rondas-target', 'user-1', 2),
        problem_id: 'p3',
        admission_seq: 1,
        received_at: 1000,
        verdict: 'AC',
        passed_cases: 10,
        total_cases: 10,
        exec_time_ms: 100,
      };

      await hub.processSubmissionVerdict('match-rondas-target', submission);

      const finished = client1.emittedEvents.find((e) => e.event === S2C.MATCH_FINISHED);
      expect(finished).toBeDefined();
      const finishPayload = finished?.payload as MatchFinishedPayload;
      expect(finishPayload.winner_ids).toEqual(['user-1']);
      expect(finishPayload.winner_id).toBe('user-1');
      expect(finishPayload.finish_reason).toBe('target_reached');
      expect(finishPayload.summary_url).toBe('/api/v1/matches/match-rondas-target/summary');
    });

    it('processTimeout en modo Puntos avanza a la siguiente ronda', async () => {
      const session = createSampleSession('match-timeout-puntos');
      session.status = 'lobby';
      await store.saveMatch(session);

      const client = createMockClient('sock-1', 'user-1', 'coder1');
      hub.registerClient(client);
      await hub.handleJoinMatch(client, { match_id: 'match-timeout-puntos' });

      await hub.startMatch('match-timeout-puntos', ['p1', 'p2']);
      client.emittedEvents.length = 0;

      // Simular timeout
      await hub.processTimeout('match-timeout-puntos');

      const begin = client.emittedEvents.find((e) => e.event === S2C.PROBLEM_BEGIN);
      expect(begin).toBeDefined();
      const beginPayload = begin?.payload as ProblemBeginPayload;
      expect(beginPayload.round_id).toBe('round-2');
      expect(beginPayload.problem_id).toBe('p2');
    });

    it('expireReconnectGrace finaliza la partida por abandono si se van todos los jugadores o rival en 1v1', async () => {
      const session = createSampleSession('match-grace-abandon');
      session.status = 'lobby';
      await store.saveMatch(session);

      const client1 = createMockClient('sock-1', 'user-1', 'coder1');
      const client2 = createMockClient('sock-2', 'user-2', 'coder2');
      hub.registerClient(client1);
      hub.registerClient(client2);

      await hub.handleJoinMatch(client1, { match_id: 'match-grace-abandon' });
      await hub.handleJoinMatch(client2, { match_id: 'match-grace-abandon' });
      await hub.startMatch('match-grace-abandon', ['p1', 'p2']);

      // Desconectar user-2
      await hub.handleDisconnect(client2);

      client1.emittedEvents.length = 0;

      // Avanzar temporizador más allá de la gracia (5000ms)
      await vi.advanceTimersByTimeAsync(5500);

      const finished = client1.emittedEvents.find((e) => e.event === S2C.MATCH_FINISHED);
      expect(finished).toBeDefined();
      const finishPayload = finished?.payload as MatchFinishedPayload;
      expect(finishPayload.finish_reason).toBe('abandonment');
      expect(finishPayload.winner_ids).toEqual(['user-1']);
    });

    it('MATCH_SYNC incluye datos específicos de ronda en Puntos y Rondas', async () => {
      // Puntos
      const sessionPuntos = createSampleSession('m-sync-p');
      sessionPuntos.problem_ids = ['p-alpha', 'p-beta'];
      sessionPuntos.current_round_id = 'round-1';
      sessionPuntos.current_round_idx = 0;
      sessionPuntos.round_ends_at = 99999;
      await store.saveMatch(sessionPuntos);

      const clientP = createMockClient('sock-p', 'user-1', 'coder1');
      hub.registerClient(clientP);
      await hub.handleJoinMatch(clientP, { match_id: 'm-sync-p' });

      const syncP = clientP.emittedEvents.find((e) => e.event === S2C.MATCH_SYNC)
        ?.payload as MatchSyncPayload;
      expect(syncP.round_id).toBe('round-1');
      expect(syncP.problem_id).toBe('p-alpha');
      expect(syncP.ends_at).toBe(99999);

      // Rondas
      const sessionRondas = createSampleSession('m-sync-r');
      sessionRondas.mode = 'rondas';
      sessionRondas.config = {
        mode: 'rondas',
        num_problems: 3,
        categories: ['facil'],
        max_players: 2,
        match_duration_s: 300,
        target: 3,
      };
      sessionRondas.problem_ids = ['p-x', 'p-y', 'p-z'];
      sessionRondas.match_ends_at = 88888;
      await store.saveMatch(sessionRondas);

      const clientR = createMockClient('sock-r', 'user-1', 'coder1');
      hub.registerClient(clientR);
      await hub.handleJoinMatch(clientR, { match_id: 'm-sync-r' });

      const syncR = clientR.emittedEvents.find((e) => e.event === S2C.MATCH_SYNC)
        ?.payload as MatchSyncPayload;
      expect(syncR.round_id).toBe(playerRoundId('m-sync-r', 'user-1', 0));
      expect(syncR.problem_id).toBe('p-x');
      expect(syncR.ends_at).toBe(88888);
      expect((syncR as Record<string, unknown>).problem_order).toBeUndefined();
    });

    it('clearAllTimers cancela graceTimers, roundTimers y matchTimers', () => {
      hub.scheduleRoundTimeout('match-t1', 10000);
      hub.scheduleMatchTimeout('match-t2', 10000);

      expect(() => hub.clearAllTimers()).not.toThrow();
    });
  });
});
