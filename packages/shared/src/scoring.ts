/**
 * Reglas de cálculo, comparación y desempate del marcador (doc 02 § Marcador y desempates, H13).
 *
 * Criterios de orden oficial:
 * 1. `score` descendente (puntos adjudicados en Puntos / resueltos en Rondas).
 * 2. `cases_total` descendente (casos superados acumulados).
 * 3. `time_total_ms` ascendente (tiempo de resolución sumado, NO tiempo de CPU del juez).
 *
 * Si todos los criterios coinciden, los jugadores comparten posición en el podio.
 * La decisión H13 establece explícitamente: "no deducir podio de winner_id".
 */
import type { PlayerScore } from './events.js';

export interface RankedPlayer {
  rank: number;
  player: PlayerScore;
}

/**
 * Comparador estricto para ordenar participantes según las reglas de DueloDev.
 * Devuelve un valor negativo si `a` supera a `b`, positivo si `b` supera a `a`,
 * o 0 si están exactamente empatados en todos los criterios.
 */
export function comparePlayerScores(a: PlayerScore, b: PlayerScore): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  if (b.cases_total !== a.cases_total) {
    return b.cases_total - a.cases_total;
  }
  if (a.time_total_ms !== b.time_total_ms) {
    return a.time_total_ms - b.time_total_ms;
  }
  return 0;
}

/**
 * Genera la clasificación completa asignando rangos oficiales (1-indexed) con soporte para empates.
 * Utiliza clasificación estándar de competencia ("1224": si hay empate en el puesto 2,
 * el siguiente participante recibe el puesto 4).
 */
export function resolveRankings(scores: readonly PlayerScore[]): RankedPlayer[] {
  if (scores.length === 0) return [];

  const sorted = [...scores].sort(comparePlayerScores);
  const ranked: RankedPlayer[] = [];

  let currentRank = 1;

  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i]!;
    if (i > 0) {
      const prev = sorted[i - 1]!;
      if (comparePlayerScores(prev, current) !== 0) {
        currentRank = i + 1;
      }
    }
    ranked.push({
      rank: currentRank,
      player: current,
    });
  }

  return ranked;
}

/**
 * Determina los identificadores de los ganadores de la partida (doc 02 § Marcador y desempates).
 * Si hay empate absoluto en el primer puesto, devuelve todos los `user_id` correspondientes.
 * Si no hay participantes, devuelve un arreglo vacío.
 */
export function determineWinners(scores: readonly PlayerScore[]): string[] {
  const rankings = resolveRankings(scores);
  if (rankings.length === 0) return [];

  const firstRank = rankings[0]!.rank;
  return rankings.filter((r) => r.rank === firstRank).map((r) => r.player.user_id);
}

/**
 * Resuelve el campo singular `winner_id` para compatibilidad (doc 02 §6):
 * Si hay un único ganador, retorna su `user_id`. En caso de empate o sin ganadores, retorna `null`.
 */
export function resolveWinnerId(winnerIds: readonly string[]): string | null {
  return winnerIds.length === 1 ? winnerIds[0]! : null;
}
