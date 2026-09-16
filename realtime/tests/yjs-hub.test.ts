import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { YjsHub } from '../src/yjs/hub.js';
import type { CodeSnapshot, YjsAuthContext, YjsClientConnection } from '../src/yjs/types.js';
import { InMemoryMatchStore } from '../src/store/memory.js';
import type { RealtimeMatchSession } from '../src/types.js';

interface MockYjsClient extends YjsClientConnection {
  sentData: Uint8Array[];
  closed: boolean;
  closeCode?: number;
  closeReason?: string;
}

function createMockYjsClient(
  id: string,
  userId: string,
  matchId: string,
  targetUserId: string,
): MockYjsClient {
  const sentData: Uint8Array[] = [];
  let closed = false;
  let closeCode: number | undefined;
  let closeReason: string | undefined;

  const client: MockYjsClient = {
    id,
    userId,
    matchId,
    targetUserId,
    get isOwner() {
      return userId === targetUserId;
    },
    send(data: Uint8Array) {
      sentData.push(data);
    },
    close(code?: number, reason?: string) {
      closed = true;
      closeCode = code;
      closeReason = reason;
    },
    get closed() {
      return closed;
    },
    get closeCode() {
      return closeCode;
    },
    get closeReason() {
      return closeReason;
    },
  };

  return client;
}

function createSampleSession(matchId: string): RealtimeMatchSession {
  const players = new Map();
  players.set('user-1', {
    user_id: 'user-1',
    gamertag: 'coder1',
    connection: 'connected' as const,
    is_ready: true,
    is_revealed: false,
    current_problem_idx: 0,
    last_seen_at: 1000,
  });
  players.set('user-2', {
    user_id: 'user-2',
    gamertag: 'coder2',
    connection: 'connected' as const,
    is_ready: true,
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
    scores: [],
    created_at: new Date(1000).toISOString(),
  };
}

describe('YjsHub', () => {
  let store: InMemoryMatchStore;
  let hub: YjsHub;
  let persistedSnapshots: CodeSnapshot[];

  beforeEach(() => {
    vi.useFakeTimers();
    store = new InMemoryMatchStore();
    persistedSnapshots = [];
    hub = new YjsHub({
      matchStore: store,
      snapshotIntervalMs: 10_000,
      onSnapshotPersist: async (snapshot) => {
        persistedSnapshots.push(snapshot);
      },
    });
  });

  afterEach(() => {
    hub.close();
    vi.useRealTimers();
  });

  describe('Conexión y negociación de acceso', () => {
    it('cierra la conexión si la ruta es inválida', async () => {
      const client = createMockYjsClient('c1', 'user-1', 'match-1', 'user-1');
      const auth: YjsAuthContext = { userId: 'user-1', gamertag: 'coder1', role: 'user' };

      const res = await hub.handleConnection('/invalid/path', client, auth);
      expect(res.authorized).toBe(false);
      expect(client.closed).toBe(true);
      expect(client.closeCode).toBe(4000);
    });

    it('cierra la conexión si la partida no existe en el store (4004)', async () => {
      const client = createMockYjsClient('c1', 'user-1', 'match-nonexistent', 'user-1');
      const auth: YjsAuthContext = { userId: 'user-1', gamertag: 'coder1', role: 'user' };

      const res = await hub.handleConnection('/yjs/match-nonexistent/user-1', client, auth);
      expect(res.authorized).toBe(false);
      expect(client.closed).toBe(true);
      expect(client.closeCode).toBe(4004);
    });

    it('cierra la conexión si un rival intenta ver código no revelado (4003)', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const rivalClient = createMockYjsClient('c2', 'user-2', 'match-1', 'user-1');
      const rivalAuth: YjsAuthContext = { userId: 'user-2', gamertag: 'coder2', role: 'user' };

      const res = await hub.handleConnection('/yjs/match-1/user-1', rivalClient, rivalAuth);
      expect(res.authorized).toBe(false);
      expect(rivalClient.closed).toBe(true);
      expect(rivalClient.closeCode).toBe(4003);
    });

    it('autoriza exitosamente al dueño del documento', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const ownerClient = createMockYjsClient('c1', 'user-1', 'match-1', 'user-1');
      const ownerAuth: YjsAuthContext = { userId: 'user-1', gamertag: 'coder1', role: 'user' };

      const res = await hub.handleConnection(
        '/yjs/match-1/user-1',
        ownerClient,
        ownerAuth,
        'init code',
      );
      expect(res.authorized).toBe(true);
      expect(res.document).toBeDefined();
      expect(res.document?.getText()).toBe('init code');
      expect(hub.activeDocumentCount).toBe(1);
    });

    it('autoriza al rival si el jugador ha revelado su código', async () => {
      const session = createSampleSession('match-1');
      session.players.get('user-1')!.is_revealed = true;
      await store.saveMatch(session);

      const rivalClient = createMockYjsClient('c2', 'user-2', 'match-1', 'user-1');
      const rivalAuth: YjsAuthContext = { userId: 'user-2', gamertag: 'coder2', role: 'user' };

      const res = await hub.handleConnection('/yjs/match-1/user-1', rivalClient, rivalAuth);
      expect(res.authorized).toBe(true);
      expect(res.document).toBeDefined();
    });
  });

  describe('Aplicación de actualizaciones binarias', () => {
    it('aplica actualizaciones si provienen del dueño del documento', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const ownerClient = createMockYjsClient('c1', 'user-1', 'match-1', 'user-1');
      const ownerAuth: YjsAuthContext = { userId: 'user-1', gamertag: 'coder1', role: 'user' };
      await hub.handleConnection('/yjs/match-1/user-1', ownerClient, ownerAuth);

      const update = new Uint8Array([1, 2, 3]);
      const res = hub.handleIncomingUpdate(ownerClient, update, 1, 'updated code');

      expect(res.applied).toBe(true);
      const doc = hub.getDocument('match-1', 'user-1');
      expect(doc?.getText()).toBe('updated code');
    });

    it('rechaza actualizaciones si provienen de un cliente no propietario (incluso observador)', async () => {
      const session = createSampleSession('match-1');
      session.players.get('user-1')!.is_revealed = true;
      await store.saveMatch(session);

      const ownerClient = createMockYjsClient('c1', 'user-1', 'match-1', 'user-1');
      const rivalClient = createMockYjsClient('c2', 'user-2', 'match-1', 'user-1');
      await hub.handleConnection('/yjs/match-1/user-1', ownerClient, {
        userId: 'user-1',
        gamertag: 'coder1',
        role: 'user',
      });
      await hub.handleConnection('/yjs/match-1/user-1', rivalClient, {
        userId: 'user-2',
        gamertag: 'coder2',
        role: 'user',
      });

      const update = new Uint8Array([1, 2, 3]);
      const res = hub.handleIncomingUpdate(rivalClient, update, 1, 'hacked code');

      expect(res.applied).toBe(false);
      expect(res.reason).toContain('Solo el dueño');
    });
  });

  describe('Avance de generaciones y cambio de ronda', () => {
    it('captura snapshot del documento previo, lo congela y avanza la generación', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const ownerClient = createMockYjsClient('c1', 'user-1', 'match-1', 'user-1');
      await hub.handleConnection(
        '/yjs/match-1/user-1',
        ownerClient,
        { userId: 'user-1', gamertag: 'coder1', role: 'user' },
        'code round 1',
      );

      // Avanzar de ronda
      const newDoc = await hub.advanceGeneration('match-1', 'user-1', 'round-2', 'code round 2');

      expect(newDoc.generation).toBe(2);
      expect(newDoc.roundId).toBe('round-2');
      expect(newDoc.getText()).toBe('code round 2');

      // Se guardó snapshot de round-1
      const snapRound1 = hub.getSnapshot('match-1', 'user-1', 'round-1');
      expect(snapRound1).not.toBeNull();
      expect(snapRound1?.code).toBe('code round 1');
      expect(snapRound1?.generation).toBe(1);

      // Callback de persistencia fue invocado
      expect(persistedSnapshots).toHaveLength(1);
      expect(persistedSnapshots[0]?.roundId).toBe('round-1');
    });
  });

  describe('Finalización de partida y snapshots terminales', () => {
    it('congela todos los documentos y genera snapshots terminales', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const client1 = createMockYjsClient('c1', 'user-1', 'match-1', 'user-1');
      const client2 = createMockYjsClient('c2', 'user-2', 'match-1', 'user-2');

      await hub.handleConnection(
        '/yjs/match-1/user-1',
        client1,
        { userId: 'user-1', gamertag: 'coder1', role: 'user' },
        'final 1',
      );
      await hub.handleConnection(
        '/yjs/match-1/user-2',
        client2,
        { userId: 'user-2', gamertag: 'coder2', role: 'user' },
        'final 2',
      );

      const finalSnaps = await hub.finalizeMatch('match-1');

      expect(finalSnaps).toHaveLength(2);
      const doc1 = hub.getDocument('match-1', 'user-1');
      const doc2 = hub.getDocument('match-1', 'user-2');
      expect(doc1?.isFrozen).toBe(true);
      expect(doc2?.isFrozen).toBe(true);
    });
  });

  describe('Snapshots periódicos cada 10s', () => {
    it('ejecuta snapshots periódicos y llama al callback de persistencia', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const client = createMockYjsClient('c1', 'user-1', 'match-1', 'user-1');
      await hub.handleConnection(
        '/yjs/match-1/user-1',
        client,
        { userId: 'user-1', gamertag: 'coder1', role: 'user' },
        'periodic code',
      );

      // Avanzar 10 segundos
      await vi.advanceTimersByTimeAsync(10_000);

      expect(persistedSnapshots.length).toBeGreaterThanOrEqual(1);
      expect(persistedSnapshots[0]?.code).toBe('periodic code');
    });
  });
});
