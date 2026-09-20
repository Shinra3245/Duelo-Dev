/**
 * Implementación pura del modo Puntos (doc 02 §3, doc 03 § Límites de responsabilidad).
 *
 * Reglas de juego:
 * - Todos los participantes resuelven concurrentemente el mismo problema (ronda compartida).
 * - J1: El primer AC elegible gana el punto de la ronda.
 * - J2: Si expira el tiempo sin ningún AC, el punto queda desierto (`winner_id: null`).
 *   Los casos de prueba superados se acumulan para el desempate.
 * - Si se agotan los problemas, la partida finaliza y se determina el podio según scoring.
 * - Es una función pura: no realiza I/O, no accede a Date.now(), sockets ni base de datos.
 */

import type {
  MatchContext,
  ModeAction,
  PureGameMode,
  PuntosMatchConfig,
  SubmissionVerdictContext,
} from '@duelodev/shared';
import { determineWinners, resolveWinnerId } from '@duelodev/shared';

export class PuntosMode implements PureGameMode {
  readonly modeName = 'puntos' as const;

  /**
   * Determina las acciones al iniciar la partida:
   * - Cambia estado a 'running'.
   * - Crea la primera ronda con el problema inicial.
   * - Abre la ronda.
   */
  onMatchStart(ctx: MatchContext): ModeAction[] {
    if (ctx.problem_ids.length === 0) {
      return [{ type: 'abandon_match', finish_reason: 'judge_unavailable' }];
    }

    const config = ctx.config as PuntosMatchConfig;
    const durationMs = config.time_per_problem_s * 1000;
    const initialRoundId = 'round-1';
    const firstProblemId = ctx.problem_ids[0]!;

    return [
      { type: 'set_match_status', status: 'running' },
      {
        type: 'advance_round',
        next_problem_id: firstProblemId,
        next_problem_index: 0,
        next_round_id: initialRoundId,
        ends_at: ctx.now + durationMs,
      },
      {
        type: 'set_round_status',
        round_id: initialRoundId,
        status: 'open',
      },
    ];
  }

  /**
   * Procesa el veredicto de un envío:
   * - Si es AC: primer AC gana la ronda, se adjudica punto y tiempo.
   *   Se avanza a la siguiente ronda o finaliza si era el último problema.
   * - Si no es AC: acumula casos superados para desempate.
   */
  onSubmissionVerdict(ctx: MatchContext, submission: SubmissionVerdictContext): ModeAction[] {
    if (ctx.status !== 'running' && ctx.status !== 'settling') {
      return [];
    }

    const currentRound = ctx.current_round;
    if (!currentRound || currentRound.round_id !== submission.round_id) {
      return [];
    }

    if (currentRound.status === 'closed') {
      return [];
    }

    const config = ctx.config as PuntosMatchConfig;
    const actions: ModeAction[] = [];

    if (submission.verdict === 'AC') {
      const solveElapsedMs = Math.max(0, submission.received_at - currentRound.opened_at);

      // Adjudicar punto
      actions.push({
        type: 'award_score',
        user_id: submission.user_id,
        round_id: currentRound.round_id,
        score_delta: 1,
        cases_delta: submission.passed_cases,
        solve_elapsed_ms: solveElapsedMs,
      });

      // Cerrar ronda actual
      actions.push({
        type: 'set_round_status',
        round_id: currentRound.round_id,
        status: 'closed',
      });

      const nextIndex = currentRound.problem_index + 1;

      // Verificar si hay más problemas
      if (nextIndex < ctx.problem_ids.length && nextIndex < config.num_problems) {
        const nextRoundId = `round-${nextIndex + 1}`;
        const nextProblemId = ctx.problem_ids[nextIndex]!;
        const durationMs = config.time_per_problem_s * 1000;

        actions.push({
          type: 'advance_round',
          next_problem_id: nextProblemId,
          next_problem_index: nextIndex,
          next_round_id: nextRoundId,
          ends_at: ctx.now + durationMs,
        });
        actions.push({
          type: 'set_round_status',
          round_id: nextRoundId,
          status: 'open',
        });
      } else {
        // Se completaron todos los problemas: finalizar partida
        const simulatedScores = this.simulateScoresWithAward(
          ctx,
          submission.user_id,
          1,
          submission.passed_cases,
          solveElapsedMs,
        );
        const winnerIds = determineWinners(simulatedScores);
        const winnerId = resolveWinnerId(winnerIds);

        actions.push({
          type: 'finish_match',
          winner_ids: winnerIds,
          winner_id: winnerId,
          finish_reason: 'problems_exhausted',
        });
      }
    } else {
      // No fue AC: acumular casos para desempate si superó casos
      if (submission.passed_cases > 0) {
        actions.push({
          type: 'award_score',
          user_id: submission.user_id,
          round_id: currentRound.round_id,
          score_delta: 0,
          cases_delta: submission.passed_cases,
          solve_elapsed_ms: 0,
        });
      }
    }

    return actions;
  }

  /**
   * Evalúa el fin de tiempo de una ronda:
   * J2: Si no hubo AC, el punto queda desierto (`winner_id: null`).
   * Avanza al siguiente problema o finaliza si no quedan más.
   */
  onTimeout(ctx: MatchContext): ModeAction[] {
    if (ctx.status !== 'running') {
      return [];
    }

    const currentRound = ctx.current_round;
    if (!currentRound || currentRound.status === 'closed') {
      return [];
    }

    const config = ctx.config as PuntosMatchConfig;
    const actions: ModeAction[] = [];

    // Cerrar ronda actual desierta
    actions.push({
      type: 'set_round_status',
      round_id: currentRound.round_id,
      status: 'closed',
    });

    const nextIndex = currentRound.problem_index + 1;

    if (nextIndex < ctx.problem_ids.length && nextIndex < config.num_problems) {
      // Avanzar al siguiente problema
      const nextRoundId = `round-${nextIndex + 1}`;
      const nextProblemId = ctx.problem_ids[nextIndex]!;
      const durationMs = config.time_per_problem_s * 1000;

      actions.push({
        type: 'advance_round',
        next_problem_id: nextProblemId,
        next_problem_index: nextIndex,
        next_round_id: nextRoundId,
        ends_at: ctx.now + durationMs,
      });
      actions.push({
        type: 'set_round_status',
        round_id: nextRoundId,
        status: 'open',
      });
    } else {
      // Fin de la partida
      const scores = Object.values(ctx.scores);
      const winnerIds = determineWinners(scores);
      const winnerId = resolveWinnerId(winnerIds);

      actions.push({
        type: 'finish_match',
        winner_ids: winnerIds,
        winner_id: winnerId,
        finish_reason: 'time_expired',
      });
    }

    return actions;
  }

  /**
   * Evalúa abandonos o desconexiones definitivas.
   * J3: Si todos abandonan, partida abandonada. Si queda exactamente 1 activo, gana por abandono.
   */
  onPlayerStatusChange(ctx: MatchContext): ModeAction[] {
    if (ctx.status === 'finished' || ctx.status === 'abandoned') {
      return [];
    }

    const activePlayers = Object.entries(ctx.players).filter(([, conn]) => conn === 'connected');

    if (activePlayers.length === 0) {
      return [{ type: 'abandon_match', finish_reason: 'all_players_left' }];
    }

    const totalRegistered = Object.keys(ctx.players).length;
    if (
      totalRegistered >= 2 &&
      activePlayers.length === 1 &&
      (ctx.status === 'running' || ctx.status === 'settling')
    ) {
      const winnerUserId = activePlayers[0]![0];
      return [
        {
          type: 'finish_match',
          winner_ids: [winnerUserId],
          winner_id: winnerUserId,
          finish_reason: 'abandonment',
        },
      ];
    }

    return [];
  }

  private simulateScoresWithAward(
    ctx: MatchContext,
    awardedUserId: string,
    scoreDelta: number,
    casesDelta: number,
    timeDelta: number,
  ) {
    return Object.values(ctx.scores).map((s) => {
      if (s.user_id === awardedUserId) {
        return {
          ...s,
          score: s.score + scoreDelta,
          cases_total: s.cases_total + casesDelta,
          time_total_ms: s.time_total_ms + timeDelta,
        };
      }
      return s;
    });
  }
}
