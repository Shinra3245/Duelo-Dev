import { describe, expect, it } from 'vitest';
import type { MatchContext, PuntosMatchConfig, SubmissionVerdictContext } from '@duelodev/shared';
import { PuntosMode } from '../src/gamemodes/puntos.js';
import { sharedRoundId } from '../src/gamemodes/round-id.js';

function createPuntosContext(overrides?: Partial<MatchContext>): MatchContext {
  const config: PuntosMatchConfig = {
    mode: 'puntos',
    num_problems: 3,
    categories: ['facil'],
    max_players: 2,
    time_per_problem_s: 300,
  };

  return {
    now: 10000,
    match_id: 'match-puntos-1',
    mode: 'puntos',
    config,
    status: 'running',
    state_version: 1,
    scores: {
      'user-1': {
        user_id: 'user-1',
        gamertag: 'coder1',
        score: 0,
        cases_total: 0,
        time_total_ms: 0,
        current_problem_idx: 0,
      },
      'user-2': {
        user_id: 'user-2',
        gamertag: 'coder2',
        score: 0,
        cases_total: 0,
        time_total_ms: 0,
        current_problem_idx: 0,
      },
    },
    players: {
      'user-1': 'connected',
      'user-2': 'connected',
    },
    problem_ids: ['prob-1', 'prob-2', 'prob-3'],
    current_round: {
      round_id: 'round-1',
      problem_id: 'prob-1',
      problem_index: 0,
      status: 'open',
      opened_at: 10000,
      ends_at: 10000 + 300 * 1000,
    },
    ...overrides,
  };
}

describe('PuntosMode', () => {
  const mode = new PuntosMode();

  describe('onMatchStart', () => {
    it('inicia la partida abriendo la primera ronda compartida', () => {
      const ctx = createPuntosContext({ status: 'lobby', current_round: undefined });
      const actions = mode.onMatchStart(ctx);
      const roundId = sharedRoundId(ctx.match_id, 0);

      expect(actions).toEqual([
        { type: 'set_match_status', status: 'running' },
        {
          type: 'advance_round',
          next_problem_id: 'prob-1',
          next_problem_index: 0,
          next_round_id: roundId,
          ends_at: 10000 + 300 * 1000,
        },
        {
          type: 'set_round_status',
          round_id: roundId,
          status: 'open',
        },
      ]);
    });
  });

  describe('onSubmissionVerdict', () => {
    it('adjudica el punto al primer AC, cierra la ronda y avanza al siguiente problema (J1)', () => {
      const ctx = createPuntosContext({ now: 25000 });
      const submission: SubmissionVerdictContext = {
        submission_id: 'sub-1',
        user_id: 'user-1',
        round_id: 'round-1',
        problem_id: 'prob-1',
        admission_seq: 1,
        received_at: 20000,
        verdict: 'AC',
        passed_cases: 10,
        total_cases: 10,
        exec_time_ms: 150,
      };

      const actions = mode.onSubmissionVerdict(ctx, submission);
      const nextRoundId = sharedRoundId(ctx.match_id, 1);

      // Adjudicación de 1 punto con solve_elapsed_ms = 20000 - 10000 = 10000ms
      expect(actions).toContainEqual({
        type: 'award_score',
        user_id: 'user-1',
        round_id: 'round-1',
        score_delta: 1,
        cases_delta: 10,
        solve_elapsed_ms: 10000,
      });

      // Cierre de ronda actual
      expect(actions).toContainEqual({
        type: 'set_round_status',
        round_id: 'round-1',
        status: 'closed',
      });

      // Avance a round-2
      expect(actions).toContainEqual({
        type: 'advance_round',
        next_problem_id: 'prob-2',
        next_problem_index: 1,
        next_round_id: nextRoundId,
        ends_at: 25000 + 300 * 1000,
      });

      // Apertura de round-2
      expect(actions).toContainEqual({
        type: 'set_round_status',
        round_id: nextRoundId,
        status: 'open',
      });
    });

    it('finaliza la partida cuando se resuelve el último problema de la lista', () => {
      const ctx = createPuntosContext({
        now: 50000,
        current_round: {
          round_id: 'round-3',
          problem_id: 'prob-3',
          problem_index: 2, // Último de 3
          status: 'open',
          opened_at: 40000,
          ends_at: 70000,
        },
      });

      const submission: SubmissionVerdictContext = {
        submission_id: 'sub-last',
        user_id: 'user-2',
        round_id: 'round-3',
        problem_id: 'prob-3',
        admission_seq: 5,
        received_at: 45000,
        verdict: 'AC',
        passed_cases: 8,
        total_cases: 8,
        exec_time_ms: 100,
      };

      const actions = mode.onSubmissionVerdict(ctx, submission);

      expect(actions).toContainEqual({
        type: 'finish_match',
        winner_ids: ['user-2'],
        winner_id: 'user-2',
        finish_reason: 'problems_exhausted',
      });
    });

    it('no adjudica puntos ni avanza de ronda ante veredictos no-AC, solo acumula casos superados', () => {
      const ctx = createPuntosContext({ now: 20000 });
      const submission: SubmissionVerdictContext = {
        submission_id: 'sub-wa',
        user_id: 'user-1',
        round_id: 'round-1',
        problem_id: 'prob-1',
        admission_seq: 2,
        received_at: 18000,
        verdict: 'WA',
        passed_cases: 7,
        total_cases: 10,
        exec_time_ms: 200,
      };

      const actions = mode.onSubmissionVerdict(ctx, submission);

      expect(actions).toEqual([
        {
          type: 'award_score',
          user_id: 'user-1',
          round_id: 'round-1',
          score_delta: 0,
          cases_delta: 7,
          solve_elapsed_ms: 0,
        },
      ]);
    });

    it('ignora veredictos recibidos cuando la ronda ya está cerrada', () => {
      const ctx = createPuntosContext({
        current_round: {
          round_id: 'round-1',
          problem_id: 'prob-1',
          problem_index: 0,
          status: 'closed',
          opened_at: 10000,
          ends_at: 40000,
        },
      });

      const submission: SubmissionVerdictContext = {
        submission_id: 'sub-late',
        user_id: 'user-1',
        round_id: 'round-1',
        problem_id: 'prob-1',
        admission_seq: 3,
        received_at: 20000,
        verdict: 'AC',
        passed_cases: 10,
        total_cases: 10,
        exec_time_ms: 100,
      };

      const actions = mode.onSubmissionVerdict(ctx, submission);
      expect(actions).toEqual([]);
    });
  });

  describe('onTimeout', () => {
    it('cierra la ronda desierta sin asignar ganador y avanza al siguiente problema (J2)', () => {
      const ctx = createPuntosContext({ now: 310000 });
      const actions = mode.onTimeout(ctx);
      const nextRoundId = sharedRoundId(ctx.match_id, 1);

      expect(actions).toEqual([
        { type: 'set_round_status', round_id: 'round-1', status: 'closed' },
        {
          type: 'advance_round',
          next_problem_id: 'prob-2',
          next_problem_index: 1,
          next_round_id: nextRoundId,
          ends_at: 310000 + 300 * 1000,
        },
        { type: 'set_round_status', round_id: nextRoundId, status: 'open' },
      ]);
    });

    it('finaliza la partida con time_expired si se agota el tiempo del último problema', () => {
      const ctx = createPuntosContext({
        now: 910000,
        current_round: {
          round_id: 'round-3',
          problem_id: 'prob-3',
          problem_index: 2,
          status: 'open',
          opened_at: 610000,
          ends_at: 910000,
        },
      });

      const actions = mode.onTimeout(ctx);

      expect(actions).toContainEqual({
        type: 'finish_match',
        winner_ids: ['user-1', 'user-2'], // Empate 0 a 0
        winner_id: null,
        finish_reason: 'time_expired',
      });
    });
  });

  describe('onPlayerStatusChange', () => {
    it('declara victoria por abandono al único jugador conectado (J3)', () => {
      const ctx = createPuntosContext({
        players: {
          'user-1': 'connected',
          'user-2': 'disconnected',
        },
      });

      const actions = mode.onPlayerStatusChange(ctx, 'user-2', 'disconnected');

      expect(actions).toEqual([
        {
          type: 'finish_match',
          winner_ids: ['user-1'],
          winner_id: 'user-1',
          finish_reason: 'abandonment',
        },
      ]);
    });

    it('declara abandono total si todos los jugadores abandonan', () => {
      const ctx = createPuntosContext({
        players: {
          'user-1': 'disconnected',
          'user-2': 'disconnected',
        },
      });

      const actions = mode.onPlayerStatusChange(ctx, 'user-1', 'disconnected');

      expect(actions).toEqual([
        {
          type: 'abandon_match',
          finish_reason: 'all_players_left',
        },
      ]);
    });
  });
});
