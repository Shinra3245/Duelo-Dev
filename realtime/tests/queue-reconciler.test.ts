import { describe, expect, it } from 'vitest';
import { VERDICTS, type MatchConfig, type RealtimeMatchSession } from '@duelodev/shared';
import { InMemoryMatchStore } from '../src/store/memory.js';
import { MatchHub } from '../src/socket/hub.js';
import {
  InMemoryProcessedSubmissionStore,
  InMemoryResultChannel,
  InMemorySubmissionProvider,
} from '../src/queue/memory.js';
import { MatchStateReconciler } from '../src/queue/reconciler.js';
import { createRealtimeServer } from '../src/server.js';

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
    room_code: 'REC01',
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

describe('MatchStateReconciler (F3 Unidad 7)', () => {
  it('reconcilia envíos perdidos ordenados por admission_seq de forma determinista (doc 04 §131)', async () => {
    const matchStore = new InMemoryMatchStore();
    const processedStore = new InMemoryProcessedSubmissionStore();
    const submissionProvider = new InMemorySubmissionProvider();
    const hub = new MatchHub({ matchStore });

    const session = createMockSession('match-rec-seq', 'u1', 'u2');
    await matchStore.saveMatch(session);

    // Envíos guardados en PostgreSQL pero cuyos avisos Pub/Sub se perdieron
    // Los insertamos en orden desordenado para verificar que se ordenen por admission_seq
    submissionProvider.addSubmission({
      id: 'sub-seq-2',
      match_id: 'match-rec-seq',
      round_id: 'round-1',
      user_id: 'u1',
      problem_id: 'prob-1',
      admission_seq: 2,
      received_at: new Date(Date.now() + 1000).toISOString(),
      verdict: VERDICTS.AC,
      passed_cases: 5,
      total_cases: 5,
      exec_time_ms: 50,
    });

    submissionProvider.addSubmission({
      id: 'sub-seq-1',
      match_id: 'match-rec-seq',
      round_id: 'round-1',
      user_id: 'u1',
      problem_id: 'prob-1',
      admission_seq: 1,
      received_at: new Date(Date.now()).toISOString(),
      verdict: VERDICTS.WA,
      passed_cases: 3,
      total_cases: 5,
      exec_time_ms: 40,
    });

    const reconciler = new MatchStateReconciler({
      matchStore,
      matchHub: hub,
      submissionProvider,
      processedStore,
    });

    const reconciled = await reconciler.reconcileMatch('match-rec-seq');
    expect(reconciled).toBe(2);
    expect(reconciler.getReconciledCount()).toBe(2);

    // Verificar que los dos envíos quedaron marcados como procesados
    expect(await processedStore.hasBeenProcessed('match-rec-seq', 'sub-seq-1')).toBe(true);
    expect(await processedStore.hasBeenProcessed('match-rec-seq', 'sub-seq-2')).toBe(true);

    // Verificar que la partida recibió los puntos del veredicto AC
    const updatedSession = await matchStore.getMatch('match-rec-seq');
    const u1Score = updatedSession?.scores.find((s) => s.user_id === 'u1')?.score ?? 0;
    expect(u1Score).toBe(1);
  });

  it('respeta la idempotencia compartida ignorando envíos ya procesados por el consumidor', async () => {
    const matchStore = new InMemoryMatchStore();
    const processedStore = new InMemoryProcessedSubmissionStore();
    const submissionProvider = new InMemorySubmissionProvider();
    const hub = new MatchHub({ matchStore });

    const session = createMockSession('match-rec-idem', 'u1', 'u2');
    await matchStore.saveMatch(session);

    submissionProvider.addSubmission({
      id: 'sub-already-done',
      match_id: 'match-rec-idem',
      round_id: 'round-1',
      user_id: 'u1',
      problem_id: 'prob-1',
      admission_seq: 1,
      received_at: new Date().toISOString(),
      verdict: VERDICTS.AC,
      passed_cases: 5,
      total_cases: 5,
      exec_time_ms: 30,
    });

    submissionProvider.addSubmission({
      id: 'sub-new-pending',
      match_id: 'match-rec-idem',
      round_id: 'round-1',
      user_id: 'u2',
      problem_id: 'prob-1',
      admission_seq: 2,
      received_at: new Date().toISOString(),
      verdict: VERDICTS.AC,
      passed_cases: 5,
      total_cases: 5,
      exec_time_ms: 35,
    });

    // Simular que el consumidor ya procesó sub-already-done
    await processedStore.markProcessed('match-rec-idem', 'sub-already-done');

    const reconciler = new MatchStateReconciler({
      matchStore,
      matchHub: hub,
      submissionProvider,
      processedStore,
    });

    const reconciled = await reconciler.reconcileMatch('match-rec-idem');
    // Solo debe haber reconciliado sub-new-pending
    expect(reconciled).toBe(1);
    expect(await processedStore.hasBeenProcessed('match-rec-idem', 'sub-new-pending')).toBe(true);
  });

  it('no reconcilia partidas que ya han finalizado', async () => {
    const matchStore = new InMemoryMatchStore();
    const processedStore = new InMemoryProcessedSubmissionStore();
    const submissionProvider = new InMemorySubmissionProvider();
    const hub = new MatchHub({ matchStore });

    const session = createMockSession('match-finished-rec', 'u1', 'u2');
    session.status = 'finished';
    await matchStore.saveMatch(session);

    submissionProvider.addSubmission({
      id: 'sub-ignored',
      match_id: 'match-finished-rec',
      round_id: 'round-1',
      user_id: 'u1',
      problem_id: 'prob-1',
      admission_seq: 1,
      received_at: new Date().toISOString(),
      verdict: VERDICTS.AC,
      passed_cases: 5,
      total_cases: 5,
      exec_time_ms: 20,
    });

    const reconciler = new MatchStateReconciler({
      matchStore,
      matchHub: hub,
      submissionProvider,
      processedStore,
    });

    const reconciled = await reconciler.reconcileMatch('match-finished-rec');
    expect(reconciled).toBe(0);
    expect(await processedStore.hasBeenProcessed('match-finished-rec', 'sub-ignored')).toBe(false);
  });

  it('inicia y detiene el ciclo de reconciliación periódica limpiamente', async () => {
    const matchStore = new InMemoryMatchStore();
    const processedStore = new InMemoryProcessedSubmissionStore();
    const submissionProvider = new InMemorySubmissionProvider();
    const hub = new MatchHub({ matchStore });

    const reconciler = new MatchStateReconciler({
      matchStore,
      matchHub: hub,
      submissionProvider,
      processedStore,
      intervalMs: 100,
    });

    reconciler.start();
    expect(reconciler.isRunning()).toBe(true);

    reconciler.stop();
    expect(reconciler.isRunning()).toBe(false);
  });

  it('integra métricas dinámicas de consumidor y reconciliador en /readyz del servidor Realtime', async () => {
    const channel = new InMemoryResultChannel();
    const submissionProvider = new InMemorySubmissionProvider();
    const processedStore = new InMemoryProcessedSubmissionStore();
    const matchStore = new InMemoryMatchStore();

    const session = createMockSession('match-ready-metrics', 'u1', 'u2');
    await matchStore.saveMatch(session);

    const serverInstance = createRealtimeServer({
      matchStore,
      resultSubscriber: channel,
      submissionProvider,
      processedSubmissionStore: processedStore,
      reconciliationIntervalMs: 5000,
    });

    const { port } = await serverInstance.start(0, '127.0.0.1');

    try {
      // Simular un envío procesado
      await processedStore.markProcessed('match-ready-metrics', 'sub-1');

      const res = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        status: string;
        metrics: Record<string, number>;
      };

      expect(body.status).toBe('ready');
      expect(body.metrics.active_matches).toBe(1);
      expect(body.metrics.processed_submissions).toBe(1);
      expect(body.metrics.reconciled_submissions).toBe(0);
      expect(body.metrics.consumer_active).toBe(1);
      expect(body.metrics.reconciler_active).toBe(1);
    } finally {
      await serverInstance.close();
    }
  });
});
