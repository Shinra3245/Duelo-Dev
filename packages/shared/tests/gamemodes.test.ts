import { describe, expect, it } from 'vitest';
import type {
  MatchContext,
  ModeAction,
  PureGameMode,
  RoundContext,
  SubmissionVerdictContext,
} from '../src/gamemodes.js';
import type { PlayerConnection } from '../src/events.js';

describe('contratos de modos de juego puros (doc 03)', () => {
  it('permite implementar un modo de juego puramente declarativo', () => {
    // Implementación mock de un modo simple para validar que las firmas y acciones son operables
    const mockPuntosMode: PureGameMode = {
      modeName: 'puntos',

      onMatchStart(ctx: MatchContext): ModeAction[] {
        const firstProblemId = ctx.problem_ids[0]!;
        const durationS = ctx.config.mode === 'puntos' ? ctx.config.time_per_problem_s : 300;
        return [
          {
            type: 'set_match_status',
            status: 'running',
          },
          {
            type: 'advance_round',
            next_problem_id: firstProblemId,
            next_problem_index: 0,
            next_round_id: 'round-1',
            ends_at: ctx.now + durationS * 1000,
          },
        ];
      },

      onSubmissionVerdict(ctx: MatchContext, sub: SubmissionVerdictContext): ModeAction[] {
        if (sub.verdict === 'AC') {
          return [
            {
              type: 'award_score',
              user_id: sub.user_id,
              round_id: sub.round_id,
              score_delta: 1,
              cases_delta: sub.passed_cases,
              solve_elapsed_ms: sub.received_at - (ctx.current_round?.opened_at ?? ctx.now),
            },
            {
              type: 'set_round_status',
              round_id: sub.round_id,
              status: 'settling',
            },
          ];
        }
        return [];
      },

      onTimeout(ctx: MatchContext): ModeAction[] {
        return [
          {
            type: 'set_round_status',
            round_id: ctx.current_round?.round_id ?? 'unknown',
            status: 'closed',
          },
        ];
      },

      onPlayerStatusChange(
        _ctx: MatchContext,
        _userId: string,
        newStatus: PlayerConnection,
      ): ModeAction[] {
        if (newStatus === 'left') {
          // Si abandona, el modo puede proponer terminar la partida
          return [
            {
              type: 'finish_match',
              winner_ids: ['survivor'],
              winner_id: 'survivor',
              finish_reason: 'abandonment',
            },
          ];
        }
        return [];
      },
    };

    const initialRound: RoundContext = {
      round_id: 'round-1',
      problem_id: 'prob-suma',
      problem_index: 0,
      status: 'open',
      opened_at: 1700000000000,
      ends_at: 1700000300000,
    };

    const dummyContext: MatchContext = {
      now: 1700000010000,
      match_id: 'match-123',
      mode: 'puntos',
      config: {
        mode: 'puntos',
        num_problems: 3,
        time_per_problem_s: 300,
        categories: ['facil'],
        max_players: 2,
      },
      status: 'running',
      state_version: 1,
      scores: {
        u1: {
          user_id: 'u1',
          gamertag: 'coder1',
          score: 0,
          cases_total: 0,
          time_total_ms: 0,
          current_problem_idx: 0,
        },
      },
      players: {
        u1: 'connected',
      },
      problem_ids: ['prob-suma', 'prob-resta', 'prob-multi'],
      current_round: initialRound,
    };

    // onMatchStart produce acciones válidas
    const startActions = mockPuntosMode.onMatchStart(dummyContext);
    expect(startActions).toHaveLength(2);
    expect(startActions[0]!.type).toBe('set_match_status');

    // onSubmissionVerdict con AC produce adjudicación y cambio a settling
    const verdictSub: SubmissionVerdictContext = {
      submission_id: 'sub-1',
      user_id: 'u1',
      round_id: 'round-1',
      problem_id: 'prob-suma',
      admission_seq: 1,
      received_at: 1700000015000,
      verdict: 'AC',
      passed_cases: 10,
      total_cases: 10,
      exec_time_ms: 50,
    };

    const verdictActions = mockPuntosMode.onSubmissionVerdict(dummyContext, verdictSub);
    expect(verdictActions).toHaveLength(2);
    expect(verdictActions[0]!.type).toBe('award_score');
    expect(verdictActions[1]!.type).toBe('set_round_status');
    if (verdictActions[1]!.type === 'set_round_status') {
      expect(verdictActions[1]!.status).toBe('settling');
    }

    // onPlayerStatusChange con abandono
    const leaveActions = mockPuntosMode.onPlayerStatusChange(dummyContext, 'u2', 'left');
    expect(leaveActions).toHaveLength(1);
    expect(leaveActions[0]!.type).toBe('finish_match');
  });
});
