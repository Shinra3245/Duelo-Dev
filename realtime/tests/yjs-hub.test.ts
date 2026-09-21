import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { YjsHub } from '../src/yjs/hub.js';
import { HIDDEN_CODE_PREVIEW } from '../src/yjs/document.js';
import type { CodeSnapshot, YjsAuthContext, YjsClientConnection } from '../src/yjs/types.js';
import { InMemoryMatchStore } from '../src/store/memory.js';
import type { RealtimeMatchSession } from '../src/types.js';

interface MockYjsClient extends YjsClientConnection {
  sentData: Uint8Array[];
  sentText: string[];
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
  const sentText: string[] = [];
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
    sendText(data: string) {
      sentText.push(data);
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

  client.sentData = sentData;
  client.sentText = sentText;

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
    problem_ids: ['problem-1', 'problem-2', 'problem-3'],
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

    it('autoriza a un rival como lector aunque su código se presente desenfocado', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const rivalClient = createMockYjsClient('c2', 'user-2', 'match-1', 'user-1');
      const rivalAuth: YjsAuthContext = { userId: 'user-2', gamertag: 'coder2', role: 'user' };

      const res = await hub.handleConnection('/yjs/match-1/user-1', rivalClient, rivalAuth);
      expect(res.authorized).toBe(true);
      expect(res.document).toBeDefined();
      expect(rivalClient.closed).toBe(false);
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

    it('revoca lectura, escritura y difusión en vivo a un jugador que abandonó', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const ownerOne = createMockYjsClient('owner-1', 'user-1', 'match-1', 'user-1');
      const rivalTwo = createMockYjsClient('rival-2', 'user-2', 'match-1', 'user-1');
      const ownerTwo = createMockYjsClient('owner-2', 'user-2', 'match-1', 'user-2');
      await hub.handleConnection('/yjs/match-1/user-1', ownerOne, {
        userId: 'user-1',
        gamertag: 'coder1',
        role: 'user',
      });
      await hub.handleConnection('/yjs/match-1/user-1', rivalTwo, {
        userId: 'user-2',
        gamertag: 'coder2',
        role: 'user',
      });
      await hub.handleConnection('/yjs/match-1/user-2', ownerTwo, {
        userId: 'user-2',
        gamertag: 'coder2',
        role: 'user',
      });

      session.players.get('user-2')!.connection = 'left';
      await store.saveMatch(session);

      const reconnectAttempt = createMockYjsClient('rival-2-new', 'user-2', 'match-1', 'user-1');
      const denied = await hub.handleConnection('/yjs/match-1/user-1', reconnectAttempt, {
        userId: 'user-2',
        gamertag: 'coder2',
        role: 'user',
      });
      expect(denied.authorized).toBe(false);
      expect(reconnectAttempt.closed).toBe(true);

      const receivedBeforeUpdate = rivalTwo.sentText.length;
      const activeUpdate = await hub.handleIncomingTextUpdate(ownerOne, 'print(2)', 1);
      expect(activeUpdate.applied).toBe(true);
      expect(rivalTwo.sentText).toHaveLength(receivedBeforeUpdate);

      const textWriteAfterLeaving = await hub.handleIncomingTextUpdate(ownerTwo, 'print(3)', 1);
      expect(textWriteAfterLeaving.applied).toBe(false);
      expect(textWriteAfterLeaving.reason).toContain('ya no participa');

      const binaryWriteAfterLeaving = await hub.handleIncomingBinaryUpdate(
        ownerTwo,
        new Uint8Array([1]),
        1,
      );
      expect(binaryWriteAfterLeaving.applied).toBe(false);
      expect(binaryWriteAfterLeaving.reason).toContain('ya no participa');
    });

    it('omite código rival sin consentimiento y sincroniza cada cambio de consentimiento', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const ownerClient = createMockYjsClient('c1', 'user-1', 'match-1', 'user-1');
      const rivalClient = createMockYjsClient('c2', 'user-2', 'match-1', 'user-1');
      await hub.handleConnection(
        '/yjs/match-1/user-1',
        ownerClient,
        {
          userId: 'user-1',
          gamertag: 'coder1',
          role: 'user',
        },
        'private starter code',
      );
      await hub.handleConnection('/yjs/match-1/user-1', rivalClient, {
        userId: 'user-2',
        gamertag: 'coder2',
        role: 'user',
      });

      expect(JSON.parse(ownerClient.sentText[0] ?? '{}')).toMatchObject({
        type: 'sync',
        source_code: 'private starter code',
      });
      expect(JSON.parse(rivalClient.sentText[0] ?? '{}')).toMatchObject({
        type: 'sync',
        source_code: HIDDEN_CODE_PREVIEW,
      });

      const hiddenMessageCount = rivalClient.sentText.length;
      const hiddenUpdate = await hub.handleIncomingTextUpdate(ownerClient, 'print(1)', 1);
      expect(hiddenUpdate.applied).toBe(true);
      expect(rivalClient.sentText).toHaveLength(hiddenMessageCount);

      session.players.get('user-1')!.is_revealed = true;
      await store.saveMatch(session);
      await hub.notifyRevealChanged('match-1', 'user-1');
      expect(JSON.parse(rivalClient.sentText.at(-1) ?? '{}')).toMatchObject({
        type: 'sync',
        source_code: 'print(1)',
      });

      const revealedUpdate = await hub.handleIncomingTextUpdate(ownerClient, 'print(2)', 1);
      expect(revealedUpdate.applied).toBe(true);
      expect(JSON.parse(rivalClient.sentText.at(-1) ?? '{}')).toMatchObject({
        type: 'update',
        source_code: 'print(2)',
      });

      session.players.get('user-1')!.is_revealed = false;
      await store.saveMatch(session);
      await hub.notifyRevealChanged('match-1', 'user-1');
      expect(JSON.parse(rivalClient.sentText.at(-1) ?? '{}')).toMatchObject({
        type: 'sync',
        source_code: HIDDEN_CODE_PREVIEW,
      });
      const hiddenAfterRevokeCount = rivalClient.sentText.length;
      await hub.handleIncomingTextUpdate(ownerClient, 'print(3)', 1);
      expect(rivalClient.sentText).toHaveLength(hiddenAfterRevokeCount);
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
      const res = await hub.handleIncomingUpdate(ownerClient, update, 1, 'updated code');

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
      const res = await hub.handleIncomingUpdate(rivalClient, update, 1, 'hacked code');

      expect(res.applied).toBe(false);
      expect(res.reason).toContain('Solo el dueño');
    });

    it('no difunde actualizaciones binarias a rivales sin consentimiento', async () => {
      const session = createSampleSession('match-binary-private');
      await store.saveMatch(session);
      const owner = createMockYjsClient('owner', 'user-1', 'match-binary-private', 'user-1');
      const rival = createMockYjsClient('rival', 'user-2', 'match-binary-private', 'user-1');
      await hub.handleConnection('/yjs/match-binary-private/user-1', owner, {
        userId: 'user-1',
        gamertag: 'coder1',
        role: 'user',
      });
      await hub.handleConnection('/yjs/match-binary-private/user-1', rival, {
        userId: 'user-2',
        gamertag: 'coder2',
        role: 'user',
      });

      const result = await hub.handleIncomingBinaryUpdate(
        owner,
        new Uint8Array([1, 2]),
        1,
        'secret',
      );
      expect(result.applied).toBe(true);
      expect(rival.sentData).toHaveLength(0);
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
      expect(finalSnaps.every((snapshot) => snapshot.problemId === 'problem-1')).toBe(true);
    });

    it('rechaza escrituras nuevas cuando la partida ya terminó aunque el documento no se haya congelado', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);
      const owner = createMockYjsClient('owner', 'user-1', 'match-1', 'user-1');
      await hub.handleConnection('/yjs/match-1/user-1', owner, {
        userId: 'user-1',
        gamertag: 'coder1',
        role: 'user',
      });

      session.status = 'finished';
      await store.saveMatch(session);
      const result = await hub.handleIncomingTextUpdate(owner, 'late = True', 1);

      expect(result).toEqual({
        applied: false,
        reason: 'La partida ya no acepta cambios de código.',
      });
    });

    it('captura el consentimiento vigente en el snapshot terminal', async () => {
      const session = createSampleSession('match-1');
      session.players.get('user-1')!.is_revealed = true;
      await store.saveMatch(session);
      const owner = createMockYjsClient('owner', 'user-1', 'match-1', 'user-1');
      await hub.handleConnection(
        '/yjs/match-1/user-1',
        owner,
        {
          userId: 'user-1',
          gamertag: 'coder1',
          role: 'user',
        },
        'final draft',
      );

      const finalSnapshots = await hub.finalizeMatch('match-1');

      expect(finalSnapshots[0]).toMatchObject({
        problemId: 'problem-1',
        isRevealed: true,
        code: 'final draft',
      });
    });

    it('reutiliza el mismo ID al reintentar un snapshot terminal parcialmente fallido', async () => {
      const session = createSampleSession('match-retry-snapshot');
      await store.saveMatch(session);
      const persist = vi.fn().mockRejectedValueOnce(new Error('temporary database failure'));
      const retryHub = new YjsHub({
        matchStore: store,
        snapshotIntervalMs: 0,
        onSnapshotPersist: persist,
      });
      const owner = createMockYjsClient('retry-owner', 'user-1', 'match-retry-snapshot', 'user-1');
      await retryHub.handleConnection(
        '/yjs/match-retry-snapshot/user-1',
        owner,
        {
          userId: 'user-1',
          gamertag: 'coder1',
          role: 'user',
        },
        'persist once',
      );

      await expect(retryHub.finalizeMatch(session.match_id)).rejects.toThrow(
        'No se pudieron persistir todos los snapshots terminales.',
      );
      const persisted = await retryHub.finalizeMatch(session.match_id);

      expect(persist).toHaveBeenCalledTimes(2);
      expect(persist.mock.calls[0]?.[0].id).toBe(persist.mock.calls[1]?.[0].id);
      expect(persisted[0]?.code).toBe('persist once');
      expect(await retryHub.finalizeMatch(session.match_id)).toEqual([]);
      expect(persist).toHaveBeenCalledTimes(2);
      retryHub.close();
    });
  });

  describe('Snapshots periódicos cada 10s', () => {
    it('ejecuta snapshots periódicos y llama al callback de persistencia', async () => {
      const session = createSampleSession('match-1');
      await store.saveMatch(session);

      const client = createMockYjsClient('c1', 'user-1', 'match-1', 'user-1');
      const sessionWithConsent = await store.getMatch('match-1');
      sessionWithConsent!.players.get('user-1')!.is_revealed = true;
      await store.saveMatch(sessionWithConsent!);
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
      expect(persistedSnapshots[0]?.problemId).toBe('problem-1');
      expect(persistedSnapshots[0]?.isRevealed).toBe(true);
    });
  });

  describe('Rotación de generación al avanzar de reto', () => {
    it('archiva el código anterior, aumenta la generación y resincroniza a los observadores', async () => {
      const session = createSampleSession('match-1');
      session.players.get('user-1')!.is_revealed = true;
      await store.saveMatch(session);
      const owner = createMockYjsClient('owner', 'user-1', 'match-1', 'user-1');
      const rival = createMockYjsClient('rival', 'user-2', 'match-1', 'user-1');
      await hub.handleConnection(
        '/yjs/match-1/user-1',
        owner,
        {
          userId: 'user-1',
          gamertag: 'coder1',
          role: 'user',
        },
        'previous answer',
      );
      await hub.handleConnection('/yjs/match-1/user-1', rival, {
        userId: 'user-2',
        gamertag: 'coder2',
        role: 'user',
      });

      const nextDoc = await hub.advanceGeneration(
        'match-1',
        'user-1',
        'round-2',
        '',
        'problem-2',
        true,
        ['user-1', 'user-2'],
      );

      expect(nextDoc.generation).toBe(2);
      expect(nextDoc.roundId).toBe('round-2');
      expect(nextDoc.problemId).toBe('problem-2');
      expect(nextDoc.observerCount).toBe(2);
      expect(persistedSnapshots[0]).toMatchObject({
        roundId: 'round-1',
        problemId: 'problem-1',
        isRevealed: true,
        code: 'previous answer',
      });
      expect(JSON.parse(owner.sentText.at(-1)!).generation).toBe(2);
      expect(JSON.parse(rival.sentText.at(-1)!).generation).toBe(2);
    });
  });
});
