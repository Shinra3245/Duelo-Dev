import { describe, expect, it } from 'vitest';
import {
  C2S,
  HOST_LOBBY_TIMEOUT_MS,
  MATCH_FINISH_REASONS,
  MATCH_FINISH_REASON_LABELS,
  MATCH_NAMESPACE,
  MAX_COMPILE_OUTPUT_BYTES,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_YDOC_BYTES,
  PROBLEM_CATEGORIES,
  RECONNECT_GRACE_MS,
  RONDAS_TARGET_VALUES,
  S2C,
  isMatchFinishReason,
  isProblemCategory,
  isPuntosConfig,
  isRondasConfig,
  isRondasTarget,
  matchRoom,
  type MatchConfig,
  type MatchFinishedPayload,
  type MatchStartedPayload,
  type MatchStatus,
  type MatchSyncPayload,
  type ProblemBeginPayload,
  type PuntosMatchConfig,
  type RondasMatchConfig,
  type RoundStatus,
  type SubmissionReceivedPayload,
  type VerdictPayload,
} from '../src/events.js';

describe('contrato de eventos y estado de partida', () => {
  it('genera correctamente el nombre del room de Socket.io', () => {
    expect(matchRoom('abc-123')).toBe('match:abc-123');
    expect(MATCH_NAMESPACE).toBe('/match');
  });

  it('los catálogos C2S y S2C contienen los eventos de doc 04', () => {
    expect(Object.values(C2S)).toEqual(['join_match', 'toggle_reveal', 'ready', 'heartbeat']);
    expect(Object.values(S2C)).toEqual([
      'match_started',
      'match_sync',
      'problem_begin',
      'submission_received',
      'verdict',
      'score_update',
      'reveal_changed',
      'player_status',
      'match_finished',
      'error',
    ]);
  });

  it('valida categorías de problemas con isProblemCategory', () => {
    for (const cat of PROBLEM_CATEGORIES) {
      expect(isProblemCategory(cat)).toBe(true);
    }
    expect(isProblemCategory('invalida')).toBe(false);
    expect(isProblemCategory(null)).toBe(false);
    expect(isProblemCategory(123)).toBe(false);
  });

  it('valida targets de rondas en {3, 6, 9, 10}', () => {
    expect(RONDAS_TARGET_VALUES).toEqual([3, 6, 9, 10]);
    for (const t of RONDAS_TARGET_VALUES) {
      expect(isRondasTarget(t)).toBe(true);
    }
    expect(isRondasTarget(5)).toBe(false);
    expect(isRondasTarget('3')).toBe(false);
    expect(isRondasTarget(null)).toBe(false);
  });

  it('valida motivos de finalización y sus etiquetas', () => {
    for (const reason of MATCH_FINISH_REASONS) {
      expect(isMatchFinishReason(reason)).toBe(true);
      expect(typeof MATCH_FINISH_REASON_LABELS[reason]).toBe('string');
      expect(MATCH_FINISH_REASON_LABELS[reason].length).toBeGreaterThan(0);
    }
    expect(isMatchFinishReason('inventado')).toBe(false);
  });

  it('configuración discriminada inequívoca para Puntos', () => {
    const puntosConfig: PuntosMatchConfig = {
      mode: 'puntos',
      num_problems: 5,
      time_per_problem_s: 300,
      categories: ['facil', 'facil_medio'],
      max_players: 2,
    };

    const config: MatchConfig = puntosConfig;
    expect(isPuntosConfig(config)).toBe(true);
    expect(isRondasConfig(config)).toBe(false);
    if (isPuntosConfig(config)) {
      expect(config.time_per_problem_s).toBe(300);
    }
  });

  it('configuración discriminada inequívoca para Rondas', () => {
    const rondasConfig: RondasMatchConfig = {
      mode: 'rondas',
      num_problems: 10,
      match_duration_s: 1800,
      target: 6,
      categories: ['muy_facil', 'facil'],
      max_players: 3,
    };

    const config: MatchConfig = rondasConfig;
    expect(isRondasConfig(config)).toBe(true);
    expect(isPuntosConfig(config)).toBe(false);
    if (isRondasConfig(config)) {
      expect(config.match_duration_s).toBe(1800);
      expect(config.target).toBe(6);
    }
  });

  it('admite el estado settling en MatchStatus y RoundStatus', () => {
    const matchStatusSettling: MatchStatus = 'settling';
    const roundStatusSettling: RoundStatus = 'settling';
    expect(matchStatusSettling).toBe('settling');
    expect(roundStatusSettling).toBe('settling');
  });

  it('soporta empates con múltiples winner_ids y winner_id nulo', () => {
    const tiedFinish: MatchFinishedPayload = {
      server_time: 1700000000000,
      match_id: 'match-1',
      state_version: 12,
      winner_ids: ['user-1', 'user-2'],
      winner_id: null,
      finish_reason: 'time_expired',
      final_scores: [
        {
          user_id: 'user-1',
          gamertag: 'alice',
          score: 2,
          cases_total: 20,
          time_total_ms: 15000,
          current_problem_idx: 2,
        },
        {
          user_id: 'user-2',
          gamertag: 'bob',
          score: 2,
          cases_total: 20,
          time_total_ms: 15000,
          current_problem_idx: 2,
        },
      ],
      summary_url: '/matches/match-1/summary',
    };

    expect(tiedFinish.winner_ids).toHaveLength(2);
    expect(tiedFinish.winner_id).toBeNull();
    expect(tiedFinish.finish_reason).toBe('time_expired');
  });

  it('sincronización personalizada de Rondas no expone problemas futuros', () => {
    const syncPayload: MatchSyncPayload = {
      server_time: 1700000000000,
      match_id: 'match-xyz',
      state_version: 5,
      status: 'running',
      mode: 'rondas',
      round_id: 'round-p1',
      problem_id: 'problem-1',
      problem_index: 0,
      ends_at: 1700001800000,
      round_status: 'open',
      scores: [
        {
          user_id: 'user-a',
          gamertag: 'alice',
          score: 0,
          cases_total: 0,
          time_total_ms: 0,
          current_problem_idx: 0,
        },
        {
          user_id: 'user-b',
          gamertag: 'bob',
          score: 1,
          cases_total: 10,
          time_total_ms: 45000,
          current_problem_idx: 1,
        },
      ],
      reveal_flags: { 'user-a': false, 'user-b': false },
      players: { 'user-a': 'connected', 'user-b': 'connected' },
    };

    expect(syncPayload.problem_id).toBe('problem-1');
    expect(syncPayload.problem_index).toBe(0);
    expect(syncPayload.round_id).toBe('round-p1');
    expect(syncPayload.round_status).toBe('open');
    // Verifica que no hay un arreglo global de problemas futuros filtrados
    expect((syncPayload as Record<string, unknown>).problem_order).toBeUndefined();
  });

  it('eventos de estado contienen match_id, round_id, state_version y server_time', () => {
    const startPayload: MatchStartedPayload = {
      server_time: 1700000000000,
      match_id: 'm-1',
      round_id: 'r-1',
      state_version: 1,
      mode: 'puntos',
      config: {
        mode: 'puntos',
        num_problems: 3,
        time_per_problem_s: 180,
        categories: ['facil'],
        max_players: 2,
      },
      problem_order: ['p-1', 'p-2', 'p-3'],
    };
    expect(startPayload.match_id).toBe('m-1');
    expect(startPayload.round_id).toBe('r-1');
    expect(startPayload.state_version).toBe(1);

    const beginPayload: ProblemBeginPayload = {
      server_time: 1700000000050,
      match_id: 'm-1',
      round_id: 'r-1',
      state_version: 2,
      problem_id: 'p-1',
      index: 0,
      ends_at: 1700000180050,
    };
    expect(beginPayload.round_id).toBe('r-1');
    expect(beginPayload.state_version).toBe(2);

    const subReceived: SubmissionReceivedPayload = {
      server_time: 1700000005000,
      match_id: 'm-1',
      round_id: 'r-1',
      submission_id: 'sub-99',
      user_id: 'u-1',
    };
    expect(subReceived.round_id).toBe('r-1');
    expect(subReceived.submission_id).toBe('sub-99');

    const verdictPayload: VerdictPayload = {
      server_time: 1700000008000,
      match_id: 'm-1',
      round_id: 'r-1',
      submission_id: 'sub-99',
      user_id: 'u-1',
      verdict: 'AC',
      passed: 10,
      total: 10,
      exec_time_ms: 120,
      compile_output: 'ok',
    };
    expect(verdictPayload.round_id).toBe('r-1');
    expect(verdictPayload.verdict).toBe('AC');
  });

  it('límites y constantes de presupuesto respetan la especificación', () => {
    expect(MAX_EVENT_PAYLOAD_BYTES).toBe(8 * 1024);
    expect(MAX_YDOC_BYTES).toBe(256 * 1024);
    expect(MAX_COMPILE_OUTPUT_BYTES).toBe(4 * 1024);
    expect(RECONNECT_GRACE_MS).toBe(60_000);
    expect(HOST_LOBBY_TIMEOUT_MS).toBe(60_000);
  });
});
