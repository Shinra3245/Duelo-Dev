import { describe, expect, it } from 'vitest';
import type { MatchContext, RondasMatchConfig, SubmissionVerdictContext } from '@duelodev/shared';
import { RondasMode } from '../src/gamemodes/rondas.js';

function createRondasContext(overrides?: Partial<MatchContext>): MatchContext {
  const config: RondasMatchConfig = {
    mode: 'rondas',
    num_problems: 5,
    categories: ['facil', 'facil_medio'],
    max_players: 2,
    match_duration_s: 600, // 10 minutos
    target: 3, // Meta de 3 problemas
  };

  return {
    now: 1000,
    match_id: 'match-rondas-1',
    mode: 'rondas',
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
    problem_ids: ['prob-1', 'prob-2', 'prob-3', 'prob-4', 'prob-5'],
    ...overrides,
  };
}

describe('RondasMode', () => {
  const mode = new RondasMode();

  describe('onMatchStart', () => {
    it('inicia la partida y posiciona a cada jugador en su problema 0 con reloj global', () => {
      const ctx = createRondasContext({ status: 'lobby' });
      const actions = mode.onMatchStart(ctx);

      expect(actions).toContainEqual({ type: 'set_match_status', status: 'running' });

      // Avance individual de cada jugador al problema 0
      expect(actions).toContainEqual({
        type: 'advance_player',
        user_id: 'user-1',
        next_problem_id: 'prob-1',
        next_problem_index: 0,
        next_round_id: 'round-u-user-1-1',
        ends_at: 1000 + 600 * 1000,
      });

      expect(actions).toContainEqual({
        type: 'advance_player',
        user_id: 'user-2',
        next_problem_id: 'prob-1',
        next_problem_index: 0,
        next_round_id: 'round-u-user-2-1',
        ends_at: 1000 + 600 * 1000,
      });
    });
  });

  describe('onSubmissionVerdict', () => {
    it('avanza al jugador individualmente al resolver con AC sin afectar el progreso del rival', () => {
      const ctx = createRondasContext({ now: 20000 });
      const submission: SubmissionVerdictContext = {
        submission_id: 'sub-r1',
        user_id: 'user-1',
        round_id: 'round-u-user-1-1',
        problem_id: 'prob-1',
        admission_seq: 1,
        received_at: 15000,
        verdict: 'AC',
        passed_cases: 10,
        total_cases: 10,
        exec_time_ms: 120,
      };

      const actions = mode.onSubmissionVerdict(ctx, submission);

      // Adjudica 1 punto
      expect(actions).toContainEqual({
        type: 'award_score',
        user_id: 'user-1',
        round_id: 'round-u-user-1-1',
        score_delta: 1,
        cases_delta: 10,
        solve_elapsed_ms: 120,
      });

      // Avanza solo a user-1 al problema 1
      expect(actions).toContainEqual({
        type: 'advance_player',
        user_id: 'user-1',
        next_problem_id: 'prob-2',
        next_problem_index: 1,
        next_round_id: 'round-u-user-1-2',
        ends_at: 20000 + 600 * 1000,
      });

      // No finaliza porque newScore (1) < target (3)
      const finishAction = actions.find((a) => a.type === 'finish_match');
      expect(finishAction).toBeUndefined();
    });

    it('finaliza la partida inmediatamente cuando un jugador alcanza la meta target (doc 02 §4)', () => {
      // user-1 ya tiene score: 2
      const ctx = createRondasContext({
        now: 50000,
        scores: {
          'user-1': {
            user_id: 'user-1',
            gamertag: 'coder1',
            score: 2,
            cases_total: 20,
            time_total_ms: 400,
            current_problem_idx: 2,
          },
          'user-2': {
            user_id: 'user-2',
            gamertag: 'coder2',
            score: 1,
            cases_total: 10,
            time_total_ms: 200,
            current_problem_idx: 1,
          },
        },
      });

      const submission: SubmissionVerdictContext = {
        submission_id: 'sub-winning',
        user_id: 'user-1',
        round_id: 'round-u-user-1-3',
        problem_id: 'prob-3',
        admission_seq: 10,
        received_at: 48000,
        verdict: 'AC',
        passed_cases: 10,
        total_cases: 10,
        exec_time_ms: 150,
      };

      const actions = mode.onSubmissionVerdict(ctx, submission);

      expect(actions).toContainEqual({
        type: 'finish_match',
        winner_ids: ['user-1'],
        winner_id: 'user-1',
        finish_reason: 'target_reached',
      });
    });

    it('no avanza al jugador ni adjudica puntos si el veredicto no es AC', () => {
      const ctx = createRondasContext();
      const submission: SubmissionVerdictContext = {
        submission_id: 'sub-wa',
        user_id: 'user-1',
        round_id: 'round-u-user-1-1',
        problem_id: 'prob-1',
        admission_seq: 2,
        received_at: 5000,
        verdict: 'WA',
        passed_cases: 5,
        total_cases: 10,
        exec_time_ms: 80,
      };

      const actions = mode.onSubmissionVerdict(ctx, submission);

      expect(actions).toEqual([
        {
          type: 'award_score',
          user_id: 'user-1',
          round_id: 'round-u-user-1-1',
          score_delta: 0,
          cases_delta: 5,
          solve_elapsed_ms: 0,
        },
      ]);
    });
  });

  describe('onTimeout', () => {
    it('finaliza la partida al expirar la duración global y resuelve ganador por desempate', () => {
      const ctx = createRondasContext({
        scores: {
          'user-1': {
            user_id: 'user-1',
            gamertag: 'coder1',
            score: 2,
            cases_total: 20,
            time_total_ms: 300,
            current_problem_idx: 2,
          },
          'user-2': {
            user_id: 'user-2',
            gamertag: 'coder2',
            score: 1,
            cases_total: 15,
            time_total_ms: 200,
            current_problem_idx: 1,
          },
        },
      });

      const actions = mode.onTimeout(ctx);

      expect(actions).toEqual([
        {
          type: 'finish_match',
          winner_ids: ['user-1'],
          winner_id: 'user-1',
          finish_reason: 'time_expired',
        },
      ]);
    });
  });

  describe('onPlayerStatusChange', () => {
    it('declara victoria por abandono si solo queda un jugador activo', () => {
      const ctx = createRondasContext({
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
  });
});
