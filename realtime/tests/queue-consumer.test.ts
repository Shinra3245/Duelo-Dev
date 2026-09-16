import { describe, expect, it } from 'vitest';
import {
  S2C,
  VERDICTS,
  type JudgeResultNotification,
  type MatchConfig,
  type RealtimeMatchSession,
} from '@duelodev/shared';
import { InMemoryMatchStore } from '../src/store/memory.js';
import { MatchHub } from '../src/socket/hub.js';
import type { SocketClient } from '../src/socket/types.js';
import {
  InMemoryProcessedSubmissionStore,
  InMemoryResultChannel,
  InMemorySubmissionProvider,
} from '../src/queue/memory.js';
import { JudgeResultsConsumer } from '../src/queue/consumer.js';

function createMockClient(
  id: string,
  userId: string,
  gamertag: string,
): SocketClient & {
  emitted: Array<{ event: string; payload: unknown }>;
  errors: Array<{ code: string; message: string; details?: unknown }>;
} {
  const rooms = new Set<string>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const errors: Array<{ code: string; message: string; details?: unknown }> = [];

  return {
    id,
    userId,
    gamertag,
    rooms,
    emitted,
    errors,
    join(room: string): void {
      rooms.add(room);
    },
    leave(room: string): void {
      rooms.delete(room);
    },
    emit(event: string, payload: unknown): void {
      emitted.push({ event, payload });
    },
    sendError(code: string, message: string, details?: unknown): void {
      errors.push({ code, message, details });
    },
    disconnect(): void {},
  };
}

const baseConfig: MatchConfig = {
  time_limit_seconds: 300,
  max_rounds: 3,
  score_to_win: 2,
};

function createMockSession(
  matchId: string,
  user1Id: string,
  user2Id: string,
  mode: 'puntos' | 'rondas' = 'puntos',
): RealtimeMatchSession {
  const players = new Map();
  players.set(user1Id, {
    user_id: user1Id,
    gamertag: 'coder1',
    connection: 'connected',
    is_ready: true,
    is_revealed: false,
    current_problem_idx: 0,
    last_seen_at: Date.now(),
  });
  players.set(user2Id, {
    user_id: user2Id,
    gamertag: 'coder2',
    connection: 'connected',
    is_ready: true,
    is_revealed: false,
    current_problem_idx: 0,
    last_seen_at: Date.now(),
  });

  return {
    match_id: matchId,
    room_code: 'TEST01',
    mode,
    config: baseConfig,
    status: 'running',
    round_status: 'open',
    current_round_id: 'round-1',
    current_round_idx: 0,
    state_version: 1,
    players,
    scores: [
      { user_id: user1Id, score: 0, rounds_won: 0 },
      { user_id: user2Id, score: 0, rounds_won: 0 },
    ],
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    problem_ids: ['prob-1', 'prob-2', 'prob-3'],
  };
}

describe('JudgeResultsConsumer (F3 Unidad 7)', () => {
  it('procesa una notificación válida de judge:results y despacha VERDICT y SCORE_UPDATE', async () => {
    const channel = new InMemoryResultChannel();
    const matchStore = new InMemoryMatchStore();
    const processedStore = new InMemoryProcessedSubmissionStore();
    const hub = new MatchHub({ matchStore });

    const session = createMockSession('match-1', 'u1', 'u2');
    await matchStore.saveMatch(session);

    // Clientes conectados en la sala de la partida
    const client1 = createMockClient('c1', 'u1', 'coder1');
    const client2 = createMockClient('c2', 'u2', 'coder2');
    hub.registerClient(client1);
    hub.registerClient(client2);
    await hub.handleJoinMatch(client1, { match_id: 'match-1' });
    await hub.handleJoinMatch(client2, { match_id: 'match-1' });

    const consumer = new JudgeResultsConsumer({
      subscriber: channel,
      matchHub: hub,
      matchStore,
      processedStore,
    });
    consumer.start();

    const notif: JudgeResultNotification = {
      submission_id: 'sub-1',
      match_id: 'match-1',
      round_id: 'round-1',
      user_id: 'u1',
      verdict: VERDICTS.AC,
      passed: 5,
      total: 5,
      exec_time_ms: 45,
    };

    await channel.publish(notif);

    // Verificar que el autor recibió VERDICT
    const authorVerdict = client1.emitted.find((e) => e.event === S2C.VERDICT);
    expect(authorVerdict).toBeDefined();
    expect((authorVerdict?.payload as { verdict: string }).verdict).toBe(VERDICTS.AC);

    // Verificar que se emitió SCORE_UPDATE tras veredicto AC
    const scoreUpdate = client1.emitted.find((e) => e.event === S2C.SCORE_UPDATE);
    expect(scoreUpdate).toBeDefined();

    // Verificar que quedó registrado como procesado en processedStore
    const isProcessed = await processedStore.hasBeenProcessed('match-1', 'sub-1');
    expect(isProcessed).toBe(true);
    expect(consumer.getProcessedCount()).toBe(1);

    consumer.stop();
  });

  it('garantiza idempotencia durable ignorando avisos duplicados sin doble puntuación (doc 04 §132)', async () => {
    const channel = new InMemoryResultChannel();
    const matchStore = new InMemoryMatchStore();
    const processedStore = new InMemoryProcessedSubmissionStore();
    const hub = new MatchHub({ matchStore });

    const session = createMockSession('match-idem', 'u1', 'u2');
    await matchStore.saveMatch(session);

    const consumer = new JudgeResultsConsumer({
      subscriber: channel,
      matchHub: hub,
      matchStore,
      processedStore,
    });
    consumer.start();

    const notif: JudgeResultNotification = {
      submission_id: 'sub-duplicate',
      match_id: 'match-idem',
      round_id: 'round-1',
      user_id: 'u1',
      verdict: VERDICTS.AC,
      passed: 10,
      total: 10,
      exec_time_ms: 120,
    };

    // Primera entrega
    const firstResult = await consumer.handleNotification(notif);
    expect(firstResult).toBe(true);

    const sessionAfterFirst = await matchStore.getMatch('match-idem');
    const u1ScoreAfterFirst = sessionAfterFirst?.scores.find((s) => s.user_id === 'u1')?.score ?? 0;
    expect(u1ScoreAfterFirst).toBe(1);

    // Segunda entrega (duplicado)
    const secondResult = await consumer.handleNotification(notif);
    expect(secondResult).toBe(false);

    // Verificar que el puntaje no aumentó doble
    const sessionAfterSecond = await matchStore.getMatch('match-idem');
    const u1ScoreAfterSecond =
      sessionAfterSecond?.scores.find((s) => s.user_id === 'u1')?.score ?? 0;
    expect(u1ScoreAfterSecond).toBe(1);
    expect(consumer.getProcessedCount()).toBe(1);

    consumer.stop();
  });

  it('aísla compile_output hacia rivales en el veredicto consumido', async () => {
    const channel = new InMemoryResultChannel();
    const matchStore = new InMemoryMatchStore();
    const processedStore = new InMemoryProcessedSubmissionStore();
    const submissionProvider = new InMemorySubmissionProvider();
    const hub = new MatchHub({ matchStore });

    submissionProvider.addSubmission({
      id: 'sub-ce-1',
      match_id: 'match-isolate',
      round_id: 'round-1',
      user_id: 'u1',
      problem_id: 'prob-1',
      admission_seq: 1,
      received_at: new Date().toISOString(),
      verdict: VERDICTS.CE,
      passed_cases: 0,
      total_cases: 5,
      exec_time_ms: 0,
      compile_output: 'error: syntax error at line 42',
    });

    const session = createMockSession('match-isolate', 'u1', 'u2');
    await matchStore.saveMatch(session);

    const client1 = createMockClient('c1', 'u1', 'coder1');
    const client2 = createMockClient('c2', 'u2', 'coder2');
    hub.registerClient(client1);
    hub.registerClient(client2);
    await hub.handleJoinMatch(client1, { match_id: 'match-isolate' });
    await hub.handleJoinMatch(client2, { match_id: 'match-isolate' });

    const consumer = new JudgeResultsConsumer({
      subscriber: channel,
      matchHub: hub,
      matchStore,
      processedStore,
      submissionProvider,
    });
    consumer.start();

    const notif: JudgeResultNotification = {
      submission_id: 'sub-ce-1',
      match_id: 'match-isolate',
      round_id: 'round-1',
      user_id: 'u1',
      verdict: VERDICTS.CE,
      passed: 0,
      total: 5,
      exec_time_ms: 0,
    };

    await channel.publish(notif);

    // Cliente 1 (autor) debe tener compile_output
    const c1Verdict = client1.emitted.find((e) => e.event === S2C.VERDICT);
    expect(c1Verdict).toBeDefined();
    expect((c1Verdict?.payload as { compile_output?: string }).compile_output).toBe(
      'error: syntax error at line 42',
    );

    // Cliente 2 (rival) NO debe tener compile_output
    const c2Verdict = client2.emitted.find((e) => e.event === S2C.VERDICT);
    expect(c2Verdict).toBeDefined();
    expect((c2Verdict?.payload as { compile_output?: string }).compile_output).toBeUndefined();

    consumer.stop();
  });

  it('ignora notificaciones mal formadas sin interrumpir el funcionamiento del consumidor (doc 04 §135)', async () => {
    const channel = new InMemoryResultChannel();
    const matchStore = new InMemoryMatchStore();
    const processedStore = new InMemoryProcessedSubmissionStore();
    const hub = new MatchHub({ matchStore });

    const consumer = new JudgeResultsConsumer({
      subscriber: channel,
      matchHub: hub,
      matchStore,
      processedStore,
    });
    consumer.start();

    // Payload corrupto: falta verdict, passed y total son negativos
    const invalidNotif = {
      submission_id: 'sub-invalid',
      match_id: 'match-1',
      user_id: 'u1',
      passed: -1,
    } as unknown as JudgeResultNotification;

    const result = await consumer.handleNotification(invalidNotif);
    expect(result).toBe(false);
    expect(consumer.isRunning()).toBe(true);

    consumer.stop();
  });

  it('descarta notificaciones para partidas inactivas o terminadas', async () => {
    const channel = new InMemoryResultChannel();
    const matchStore = new InMemoryMatchStore();
    const processedStore = new InMemoryProcessedSubmissionStore();
    const hub = new MatchHub({ matchStore });

    const session = createMockSession('match-finished', 'u1', 'u2');
    session.status = 'finished';
    await matchStore.saveMatch(session);

    const consumer = new JudgeResultsConsumer({
      subscriber: channel,
      matchHub: hub,
      matchStore,
      processedStore,
    });
    consumer.start();

    const notif: JudgeResultNotification = {
      submission_id: 'sub-late',
      match_id: 'match-finished',
      round_id: 'round-1',
      user_id: 'u1',
      verdict: VERDICTS.AC,
      passed: 5,
      total: 5,
      exec_time_ms: 30,
    };

    const result = await consumer.handleNotification(notif);
    expect(result).toBe(false);

    // Tampoco debe registrarse en el store de procesados
    const processed = await processedStore.hasBeenProcessed('match-finished', 'sub-late');
    expect(processed).toBe(false);

    consumer.stop();
  });

  it('detiene la recepción de mensajes al invocar stop() limpiamente', async () => {
    const channel = new InMemoryResultChannel();
    const matchStore = new InMemoryMatchStore();
    const processedStore = new InMemoryProcessedSubmissionStore();
    const hub = new MatchHub({ matchStore });

    const session = createMockSession('match-stop', 'u1', 'u2');
    await matchStore.saveMatch(session);

    const consumer = new JudgeResultsConsumer({
      subscriber: channel,
      matchHub: hub,
      matchStore,
      processedStore,
    });
    consumer.start();
    expect(consumer.isRunning()).toBe(true);

    consumer.stop();
    expect(consumer.isRunning()).toBe(false);
    expect(channel.listenerCount).toBe(0);

    // Un mensaje posterior en el canal no debe llegar al consumidor
    const notif: JudgeResultNotification = {
      submission_id: 'sub-after-stop',
      match_id: 'match-stop',
      round_id: 'round-1',
      user_id: 'u1',
      verdict: VERDICTS.AC,
      passed: 5,
      total: 5,
      exec_time_ms: 30,
    };

    await channel.publish(notif);
    expect(consumer.getProcessedCount()).toBe(0);
  });

  it('obtiene admission_seq y received_at fidedignos desde la persistencia durable (doc 04 §131)', async () => {
    const channel = new InMemoryResultChannel();
    const matchStore = new InMemoryMatchStore();
    const processedStore = new InMemoryProcessedSubmissionStore();
    const submissionProvider = new InMemorySubmissionProvider();
    const hub = new MatchHub({ matchStore });

    const durableReceivedAt = '2026-09-16T10:15:30.000Z';
    submissionProvider.addSubmission({
      id: 'sub-durable-seq',
      match_id: 'match-seq-test',
      round_id: 'round-1',
      user_id: 'u1',
      problem_id: 'prob-1',
      admission_seq: 7, // Secuencia real distinta de 1
      received_at: durableReceivedAt,
      verdict: VERDICTS.AC,
      passed_cases: 5,
      total_cases: 5,
      exec_time_ms: 60,
    });

    const session = createMockSession('match-seq-test', 'u1', 'u2');
    await matchStore.saveMatch(session);

    let capturedCtx: unknown;
    const originalProcess = hub.processSubmissionVerdict.bind(hub);
    hub.processSubmissionVerdict = async (matchId, ctx, compileOutput) => {
      capturedCtx = ctx;
      return originalProcess(matchId, ctx, compileOutput);
    };

    const consumer = new JudgeResultsConsumer({
      subscriber: channel,
      matchHub: hub,
      matchStore,
      processedStore,
      submissionProvider,
    });
    consumer.start();

    const notif: JudgeResultNotification = {
      submission_id: 'sub-durable-seq',
      match_id: 'match-seq-test',
      round_id: 'round-1',
      user_id: 'u1',
      verdict: VERDICTS.AC,
      passed: 5,
      total: 5,
      exec_time_ms: 60,
    };

    const handled = await consumer.handleNotification(notif);
    expect(handled).toBe(true);

    expect(capturedCtx).toBeDefined();
    const ctx = capturedCtx as { admission_seq: number; received_at: number };
    expect(ctx.admission_seq).toBe(7);
    expect(ctx.received_at).toBe(Date.parse(durableReceivedAt));

    consumer.stop();
  });

  it('rechaza avisos con discrepancia frente al registro durable en PostgreSQL', async () => {
    const channel = new InMemoryResultChannel();
    const matchStore = new InMemoryMatchStore();
    const processedStore = new InMemoryProcessedSubmissionStore();
    const submissionProvider = new InMemorySubmissionProvider();
    const hub = new MatchHub({ matchStore });

    // Fila durable registrada con WA
    submissionProvider.addSubmission({
      id: 'sub-mismatch',
      match_id: 'match-disc',
      round_id: 'round-1',
      user_id: 'u1',
      problem_id: 'prob-1',
      admission_seq: 2,
      received_at: new Date().toISOString(),
      verdict: VERDICTS.WA, // WA en BD
      passed_cases: 2,
      total_cases: 5,
      exec_time_ms: 40,
    });

    const session = createMockSession('match-disc', 'u1', 'u2');
    await matchStore.saveMatch(session);

    const consumer = new JudgeResultsConsumer({
      subscriber: channel,
      matchHub: hub,
      matchStore,
      processedStore,
      submissionProvider,
    });
    consumer.start();

    // Aviso espurio que falsamente clama ser AC
    const fakeNotif: JudgeResultNotification = {
      submission_id: 'sub-mismatch',
      match_id: 'match-disc',
      round_id: 'round-1',
      user_id: 'u1',
      verdict: VERDICTS.AC, // Intento de inyección de AC
      passed: 5,
      total: 5,
      exec_time_ms: 40,
    };

    const handled = await consumer.handleNotification(fakeNotif);
    expect(handled).toBe(false);

    // No debe mutar la sesión ni registrarse como procesado
    const sessionAfter = await matchStore.getMatch('match-disc');
    const u1Score = sessionAfter?.scores.find((s) => s.user_id === 'u1')?.score ?? 0;
    expect(u1Score).toBe(0);

    const isProcessed = await processedStore.hasBeenProcessed('match-disc', 'sub-mismatch');
    expect(isProcessed).toBe(false);

    consumer.stop();
  });

  it('no fuga el payload corrupto en logs ante avisos inválidos (doc 04 §135)', async () => {
    const channel = new InMemoryResultChannel();
    const matchStore = new InMemoryMatchStore();
    const processedStore = new InMemoryProcessedSubmissionStore();
    const hub = new MatchHub({ matchStore });

    const logMessages: Array<{ msg: string; meta?: unknown }> = [];
    const mockLogger = {
      debug: () => {},
      info: (msg: string, meta?: unknown) => {
        logMessages.push({ msg, meta });
      },
      warn: (msg: string, meta?: unknown) => {
        logMessages.push({ msg, meta });
      },
      error: (msg: string, meta?: unknown) => {
        logMessages.push({ msg, meta });
      },
    };

    const consumer = new JudgeResultsConsumer({
      subscriber: channel,
      matchHub: hub,
      matchStore,
      processedStore,
      logger: mockLogger,
    });
    consumer.start();

    const sensitivePayload = {
      malformed: true,
      stolen_token: 'secret_token_12345',
      source_code: 'secret_proprietary_code()',
      cases: [{ input: 'confidential' }],
    } as unknown as JudgeResultNotification;

    const handled = await consumer.handleNotification(sensitivePayload);
    expect(handled).toBe(false);

    const serializedLogs = JSON.stringify(logMessages);
    expect(serializedLogs).not.toContain('secret_token_12345');
    expect(serializedLogs).not.toContain('secret_proprietary_code');
    expect(serializedLogs).not.toContain('confidential');

    consumer.stop();
  });

  it('procesa exactamente un efecto ante avisos concurrentes con Promise.all', async () => {
    const channel = new InMemoryResultChannel();
    const matchStore = new InMemoryMatchStore();
    const processedStore = new InMemoryProcessedSubmissionStore();
    const hub = new MatchHub({ matchStore });

    const session = createMockSession('match-concurrent', 'u1', 'u2');
    await matchStore.saveMatch(session);

    const consumer = new JudgeResultsConsumer({
      subscriber: channel,
      matchHub: hub,
      matchStore,
      processedStore,
    });
    consumer.start();

    const notif: JudgeResultNotification = {
      submission_id: 'sub-race-1',
      match_id: 'match-concurrent',
      round_id: 'round-1',
      user_id: 'u1',
      verdict: VERDICTS.AC,
      passed: 5,
      total: 5,
      exec_time_ms: 50,
    };

    // Disparar concurrentemente dos handleNotification para el mismo envío
    const [result1, result2] = await Promise.all([
      consumer.handleNotification(notif),
      consumer.handleNotification(notif),
    ]);

    // Exactamente una de las llamadas debe retornar true, la otra false
    expect([result1, result2].filter(Boolean)).toHaveLength(1);

    // Puntaje final debe ser exactamente 1 (no 2)
    const sessionAfter = await matchStore.getMatch('match-concurrent');
    const u1Score = sessionAfter?.scores.find((s) => s.user_id === 'u1')?.score ?? 0;
    expect(u1Score).toBe(1);
    expect(consumer.getProcessedCount()).toBe(1);

    consumer.stop();
  });
});
