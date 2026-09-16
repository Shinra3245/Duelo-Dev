/**
 * Implementación pura del modo Rondas (doc 02 §4, doc 03 § Límites de responsabilidad).
 *
 * Reglas de juego:
 * - Cada participante recorre individualmente la lista de problemas a su propio ritmo.
 * - Cada AC de un jugador incrementa su puntuación (`score_delta: 1`) y avanza su problema.
 * - Victoria inmediata si un jugador alcanza la meta (`target` en {3, 6, 9, 10}):
 *   `finish_reason: 'target_reached'`.
 * - Reloj global continuo (`match_duration_s`). Si expira el tiempo antes de que alguien
 *   alcance la meta, se resuelve por desempates:
 *   1. Mayor cantidad de problemas resueltos (`score`).
 *   2. Mayor cantidad de casos superados (`cases_total`).
 *   3. Menor tiempo de resolución acumulado (`time_total_ms`).
 * - Función pura: sin I/O, sin temporizadores ni variables globales.
 */

import type {
  MatchContext,
  ModeAction,
  PureGameMode,
  RondasMatchConfig,
  SubmissionVerdictContext,
} from '@duelodev/shared';
import { determineWinners, resolveWinnerId } from '@duelodev/shared';

export class RondasMode implements PureGameMode {
  readonly modeName = 'rondas' as const;

  /**
   * Al iniciar la partida en modo Rondas:
   * - Pasa la partida a 'running'.
   * - Cada jugador avanza individualmente a su problema 0.
   */
  onMatchStart(ctx: MatchContext): ModeAction[] {
    if (ctx.problem_ids.length === 0) {
      return [{ type: 'abandon_match', finish_reason: 'judge_unavailable' }];
    }

    const config = ctx.config as RondasMatchConfig;
    const endsAt = ctx.now + config.match_duration_s * 1000;
    const firstProblemId = ctx.problem_ids[0]!;

    const actions: ModeAction[] = [{ type: 'set_match_status', status: 'running' }];

    for (const userId of Object.keys(ctx.players)) {
      actions.push({
        type: 'advance_player',
        user_id: userId,
        next_problem_id: firstProblemId,
        next_problem_index: 0,
        next_round_id: `round-u-${userId}-1`,
        ends_at: endsAt,
      });
    }

    return actions;
  }

  /**
   * Procesa un veredicto en modo Rondas:
   * - Si es AC:
   *   - Suma 1 punto al jugador.
   *   - Si alcanza `target`: ¡Victoria por meta alcanzada!
   *   - Si no alcanza `target` pero hay más problemas: avanza al jugador a su siguiente problema.
   *   - Si completó todos los problemas disponibles y todos terminaron: finaliza por problemas agotados.
   * - Si no es AC: acumula casos superados para desempate.
   */
  onSubmissionVerdict(ctx: MatchContext, submission: SubmissionVerdictContext): ModeAction[] {
    if (ctx.status !== 'running') {
      return [];
    }

    const config = ctx.config as RondasMatchConfig;
    const actions: ModeAction[] = [];

    const playerScore = ctx.scores[submission.user_id];
    const currentScore = playerScore ? playerScore.score : 0;
    const currentProblemIdx = playerScore ? playerScore.current_problem_idx : 0;

    if (submission.verdict === 'AC') {
      const newScore = currentScore + 1;
      const solveElapsedMs = Math.max(0, submission.exec_time_ms);

      // Adjudicar punto al jugador
      actions.push({
        type: 'award_score',
        user_id: submission.user_id,
        round_id: submission.round_id,
        score_delta: 1,
        cases_delta: submission.passed_cases,
        solve_elapsed_ms: solveElapsedMs,
      });

      // 1. ¿Alcanzó la meta target?
      if (newScore >= config.target) {
        actions.push({
          type: 'finish_match',
          winner_ids: [submission.user_id],
          winner_id: submission.user_id,
          finish_reason: 'target_reached',
        });
        return actions;
      }

      // 2. ¿Tiene más problemas disponibles en la lista?
      const nextProblemIdx = currentProblemIdx + 1;
      if (nextProblemIdx < ctx.problem_ids.length && nextProblemIdx < config.num_problems) {
        const nextProblemId = ctx.problem_ids[nextProblemIdx]!;
        const endsAt = ctx.now + config.match_duration_s * 1000;

        actions.push({
          type: 'advance_player',
          user_id: submission.user_id,
          next_problem_id: nextProblemId,
          next_problem_index: nextProblemIdx,
          next_round_id: `round-u-${submission.user_id}-${nextProblemIdx + 1}`,
          ends_at: endsAt,
        });
      } else {
        // Se le agotaron los problemas a este jugador
        // Verificar si todos los jugadores terminaron todos sus problemas
        const simulatedScores = this.simulateScoresWithAward(
          ctx,
          submission.user_id,
          1,
          submission.passed_cases,
          solveElapsedMs,
        );

        const allFinished = simulatedScores.every(
          (s) => s.current_problem_idx >= config.num_problems - 1 || s.score >= config.target,
        );

        if (allFinished) {
          const winnerIds = determineWinners(simulatedScores);
          const winnerId = resolveWinnerId(winnerIds);

          actions.push({
            type: 'finish_match',
            winner_ids: winnerIds,
            winner_id: winnerId,
            finish_reason: 'problems_exhausted',
          });
        }
      }
    } else {
      // No fue AC: acumular casos para desempate
      if (submission.passed_cases > 0) {
        actions.push({
          type: 'award_score',
          user_id: submission.user_id,
          round_id: submission.round_id,
          score_delta: 0,
          cases_delta: submission.passed_cases,
          solve_elapsed_ms: 0,
        });
      }
    }

    return actions;
  }

  /**
   * Fin de tiempo global de la partida en Rondas (`match_duration_s`):
   * Se evalúa la clasificación con las puntuaciones y desempates acumulados.
   */
  onTimeout(ctx: MatchContext): ModeAction[] {
    if (ctx.status !== 'running') {
      return [];
    }

    const scores = Object.values(ctx.scores);
    const winnerIds = determineWinners(scores);
    const winnerId = resolveWinnerId(winnerIds);

    return [
      {
        type: 'finish_match',
        winner_ids: winnerIds,
        winner_id: winnerId,
        finish_reason: 'time_expired',
      },
    ];
  }

  /**
   * Evalúa abandonos.
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
    if (totalRegistered >= 2 && activePlayers.length === 1 && ctx.status === 'running') {
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
