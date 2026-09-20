import { describe, expect, it } from 'vitest';
import {
  C2S,
  HOST_LOBBY_TIMEOUT_MS,
  MATCH_FINISH_REASONS,
  MATCH_FINISH_REASON_LABELS,
  MATCH_NAMESPACE,
  MATCH_STATUSES,
  MAX_COMPILE_OUTPUT_BYTES,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_YDOC_BYTES,
  PLAYER_CONNECTIONS,
  PROBLEM_CATEGORIES,
  RECONNECT_GRACE_MS,
  RONDAS_TARGET_VALUES,
  ROUND_STATUSES,
  S2C,
  isGameModeName,
  isMatchConfig,
  isMatchFinishReason,
  isMatchFinishedPayload,
  isMatchStartedPayload,
  isMatchStatus,
  isMatchSyncPayload,
  isPlayerConnection,
  isPlayerScore,
  isPlayerStatusPayload,
  isProblemBeginPayload,
  isProblemCategory,
  isPuntosConfig,
  isRevealChangedPayload,
  isRondasConfig,
  isRondasTarget,
  isRoundStatus,
  isScoreUpdatePayload,
  isSubmissionReceivedPayload,
  isVerdictPayload,
  matchRoom,
  type MatchConfig,
  type MatchFinishedPayload,
  type MatchStartedPayload,
  type MatchStatus,
  type MatchSyncPayload,
  type PlayerScore,
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
    expect(Object.values(C2S)).toEqual([
      'join_match',
      'leave_match',
      'toggle_reveal',
      'ready',
      'heartbeat',
    ]);
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

  it('valida estados de partida, ronda, conexiones y modos con guardias', () => {
    for (const status of MATCH_STATUSES) {
      expect(isMatchStatus(status)).toBe(true);
    }
    expect(isMatchStatus('invalido')).toBe(false);

    for (const rStatus of ROUND_STATUSES) {
      expect(isRoundStatus(rStatus)).toBe(true);
    }
    expect(isRoundStatus('invalido')).toBe(false);

    for (const conn of PLAYER_CONNECTIONS) {
      expect(isPlayerConnection(conn)).toBe(true);
    }
    expect(isPlayerConnection('invalido')).toBe(false);

    expect(isGameModeName('puntos')).toBe(true);
    expect(isGameModeName('rondas')).toBe(true);
    expect(isGameModeName('otro')).toBe(false);
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

  it('configuración discriminada inequívoca para Puntos y guardias estrictas', () => {
    const puntosConfig: PuntosMatchConfig = {
      mode: 'puntos',
      num_problems: 5,
      time_per_problem_s: 300,
      categories: ['facil', 'facil_medio'],
      max_players: 2,
    };
    const genericConfig: MatchConfig = puntosConfig;

    expect(isMatchConfig(genericConfig)).toBe(true);
    expect(isPuntosConfig(puntosConfig)).toBe(true);
    expect(isRondasConfig(puntosConfig)).toBe(false);

    // Invariante violado: award_on_timeout presente
    expect(isMatchConfig({ ...puntosConfig, award_on_timeout: true })).toBe(false);
    expect(isMatchConfig({ ...puntosConfig, award_on_timeout: false })).toBe(false);

    // Invariante violado: time_per_problem_s no positivo
    expect(isMatchConfig({ ...puntosConfig, time_per_problem_s: 0 })).toBe(false);
    expect(isMatchConfig({ ...puntosConfig, time_per_problem_s: -10 })).toBe(false);

    // Invariante violado: categorías vacías o inválidas
    expect(isMatchConfig({ ...puntosConfig, categories: [] })).toBe(false);
    expect(isMatchConfig({ ...puntosConfig, categories: ['inventada'] })).toBe(false);

    // Invariante violado: max_players < 2
    expect(isMatchConfig({ ...puntosConfig, max_players: 1 })).toBe(false);
  });

  it('configuración discriminada inequívoca para Rondas y guardias estrictas', () => {
    const rondasConfig: RondasMatchConfig = {
      mode: 'rondas',
      num_problems: 10,
      match_duration_s: 1800,
      target: 6,
      categories: ['muy_facil', 'facil'],
      max_players: 3,
    };

    expect(isMatchConfig(rondasConfig)).toBe(true);
    expect(isRondasConfig(rondasConfig)).toBe(true);
    expect(isPuntosConfig(rondasConfig)).toBe(false);

    // Invariante violado: target mayor que num_problems (doc 02 §4)
    expect(isMatchConfig({ ...rondasConfig, num_problems: 5, target: 6 })).toBe(false);

    // Invariante violado: target fuera de {3, 6, 9, 10}
    expect(isMatchConfig({ ...rondasConfig, target: 5 })).toBe(false);

    // Invariante violado: campos mezclados de Puntos
    expect(
      isMatchConfig({
        ...rondasConfig,
        time_per_problem_s: 300,
      } as unknown),
    ).toBe(false);
  });

  it('valida invariantes de PlayerScore con isPlayerScore', () => {
    const validScore: PlayerScore = {
      user_id: 'user-1',
      gamertag: 'coder-pro',
      score: 3,
      cases_total: 25,
      time_total_ms: 12500,
      current_problem_idx: 2,
    };
    expect(isPlayerScore(validScore)).toBe(true);

    // Invariantes violados: valores negativos
    expect(isPlayerScore({ ...validScore, score: -1 })).toBe(false);
    expect(isPlayerScore({ ...validScore, cases_total: -5 })).toBe(false);
    expect(isPlayerScore({ ...validScore, time_total_ms: -100 })).toBe(false);
    expect(isPlayerScore({ ...validScore, current_problem_idx: -1 })).toBe(false);

    // Identificadores vacíos
    expect(isPlayerScore({ ...validScore, user_id: '' })).toBe(false);
    expect(isPlayerScore({ ...validScore, gamertag: '' })).toBe(false);
    expect(isPlayerScore(null)).toBe(false);
  });

  it('admite el estado settling en MatchStatus y RoundStatus', () => {
    const matchStatusSettling: MatchStatus = 'settling';
    const roundStatusSettling: RoundStatus = 'settling';
    expect(matchStatusSettling).toBe('settling');
    expect(roundStatusSettling).toBe('settling');
    expect(isMatchStatus('settling')).toBe(true);
    expect(isRoundStatus('settling')).toBe(true);
  });

  it('soporta empates con múltiples winner_ids y winner_id nulo validando invariantes', () => {
    const tiedFinish: MatchFinishedPayload = {
      server_time: 1700000000000,
      match_id: 'match-1',
      state_version: 12,
      status: 'finished',
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

    expect(isMatchFinishedPayload(tiedFinish)).toBe(true);

    // Invariante violado: empate con múltiples ganadores pero winner_id no nulo
    expect(isMatchFinishedPayload({ ...tiedFinish, winner_id: 'user-1' })).toBe(false);

    // Victoria singular válida
    const singleFinish: MatchFinishedPayload = {
      ...tiedFinish,
      winner_ids: ['user-1'],
      winner_id: 'user-1',
    };
    expect(isMatchFinishedPayload(singleFinish)).toBe(true);

    // Invariante violado: ganador único pero winner_id nulo o discordante
    expect(isMatchFinishedPayload({ ...singleFinish, winner_id: null })).toBe(false);
    expect(isMatchFinishedPayload({ ...singleFinish, winner_id: 'user-2' })).toBe(false);
    expect(isMatchFinishedPayload({ ...singleFinish, status: 'abandoned' })).toBe(true);
    expect(isMatchFinishedPayload({ ...singleFinish, status: 'running' })).toBe(false);
  });

  it('sincronización personalizada de Rondas no expone problemas futuros e implementa guardias', () => {
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

    expect(isMatchSyncPayload(syncPayload)).toBe(true);

    // Invariante violado: filtración de lista de problemas en Rondas (doc 04 §3)
    const leakingSync = {
      ...syncPayload,
      problem_order: ['problem-1', 'problem-2', 'problem-3'],
    };
    expect(isMatchSyncPayload(leakingSync)).toBe(false);
  });

  it('eventos de estado contienen match_id, round_id, state_version y server_time y se validan', () => {
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
    expect(isMatchStartedPayload(startPayload)).toBe(true);
    expect(isMatchStartedPayload({ ...startPayload, state_version: 0 })).toBe(false);

    const beginPayload: ProblemBeginPayload = {
      server_time: 1700000000050,
      match_id: 'm-1',
      round_id: 'r-1',
      state_version: 2,
      problem_id: 'p-1',
      index: 0,
      ends_at: 1700000180050,
    };
    expect(isProblemBeginPayload(beginPayload)).toBe(true);
    expect(isProblemBeginPayload({ ...beginPayload, index: -1 })).toBe(false);

    const subReceived: SubmissionReceivedPayload = {
      server_time: 1700000005000,
      match_id: 'm-1',
      round_id: 'r-1',
      submission_id: 'sub-99',
      user_id: 'u-1',
    };
    expect(isSubmissionReceivedPayload(subReceived)).toBe(true);
    expect(isSubmissionReceivedPayload({ ...subReceived, submission_id: '' })).toBe(false);

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
    expect(isVerdictPayload(verdictPayload)).toBe(true);

    // Invariante violado: passed > total
    expect(isVerdictPayload({ ...verdictPayload, passed: 11, total: 10 })).toBe(false);

    // Invariante violado: compile_output superior a 4 KiB
    expect(
      isVerdictPayload({
        ...verdictPayload,
        compile_output: 'a'.repeat(MAX_COMPILE_OUTPUT_BYTES + 1),
      }),
    ).toBe(false);

    const scoreUpdate = {
      server_time: 1700000008000,
      match_id: 'm-1',
      state_version: 3,
      scores: [
        {
          user_id: 'u-1',
          gamertag: 'alice',
          score: 1,
          cases_total: 10,
          time_total_ms: 12000,
          current_problem_idx: 1,
        },
      ],
    };
    expect(isScoreUpdatePayload(scoreUpdate)).toBe(true);

    const revealChanged = {
      server_time: 1700000008000,
      match_id: 'm-1',
      user_id: 'u-1',
      visible: true,
    };
    expect(isRevealChangedPayload(revealChanged)).toBe(true);

    const playerStatus = {
      server_time: 1700000008000,
      match_id: 'm-1',
      user_id: 'u-1',
      status: 'disconnected',
    };
    expect(isPlayerStatusPayload(playerStatus)).toBe(true);
  });

  it('límites y constantes de presupuesto respetan la especificación', () => {
    expect(MAX_EVENT_PAYLOAD_BYTES).toBe(8 * 1024);
    expect(MAX_YDOC_BYTES).toBe(256 * 1024);
    expect(MAX_COMPILE_OUTPUT_BYTES).toBe(4 * 1024);
    expect(RECONNECT_GRACE_MS).toBe(60_000);
    expect(HOST_LOBBY_TIMEOUT_MS).toBe(60_000);
  });
});
