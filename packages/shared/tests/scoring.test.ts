import { describe, expect, it } from 'vitest';
import type { PlayerScore } from '../src/events.js';
import {
  comparePlayerScores,
  determineWinners,
  resolveRankings,
  resolveWinnerId,
} from '../src/scoring.js';

describe('reglas de cálculo, comparación y desempate del marcador (doc 02, H13)', () => {
  const pAlice: PlayerScore = {
    user_id: 'alice',
    gamertag: 'alice-pro',
    score: 3,
    cases_total: 30,
    time_total_ms: 10_000,
    current_problem_idx: 3,
  };

  const pBob: PlayerScore = {
    user_id: 'bob',
    gamertag: 'bob-dev',
    score: 2,
    cases_total: 25,
    time_total_ms: 8_000,
    current_problem_idx: 2,
  };

  const pCharlie: PlayerScore = {
    user_id: 'charlie',
    gamertag: 'charlie-fast',
    score: 2,
    cases_total: 25,
    time_total_ms: 9_000,
    current_problem_idx: 2,
  };

  const pDavid: PlayerScore = {
    user_id: 'david',
    gamertag: 'david-cases',
    score: 2,
    cases_total: 28,
    time_total_ms: 12_000,
    current_problem_idx: 2,
  };

  const pEve: PlayerScore = {
    user_id: 'eve',
    gamertag: 'eve-twin',
    score: 3,
    cases_total: 30,
    time_total_ms: 10_000,
    current_problem_idx: 3,
  };

  it('ordena prioritariamente por score descendente', () => {
    expect(comparePlayerScores(pAlice, pBob)).toBeLessThan(0); // Alice antes que Bob
    expect(comparePlayerScores(pBob, pAlice)).toBeGreaterThan(0);
  });

  it('desempata por cases_total descendente cuando el score es igual', () => {
    // David tiene score 2 pero 28 casos vs Bob con 25 casos
    expect(comparePlayerScores(pDavid, pBob)).toBeLessThan(0);
  });

  it('desempata por time_total_ms ascendente cuando score y cases_total son iguales', () => {
    // Bob y Charlie tienen score 2 y 25 casos; Bob resolvió en 8s vs Charlie en 9s
    expect(comparePlayerScores(pBob, pCharlie)).toBeLessThan(0);
    expect(comparePlayerScores(pCharlie, pBob)).toBeGreaterThan(0);
  });

  it('detecta empate exacto cuando coinciden los tres criterios', () => {
    expect(comparePlayerScores(pAlice, pEve)).toBe(0);
  });

  it('resolveRankings asigna clasificación estándar con soporte de empates (1, 1, 3)', () => {
    const scores = [pBob, pAlice, pEve];
    const rankings = resolveRankings(scores);

    expect(rankings).toHaveLength(3);
    // Alice y Eve empatan en el primer puesto
    expect(rankings[0]!.rank).toBe(1);
    expect(rankings[1]!.rank).toBe(1);
    // Bob recibe el puesto 3 (no 2)
    expect(rankings[2]!.rank).toBe(3);
    expect(rankings[2]!.player.user_id).toBe('bob');
  });

  it('resolveRankings maneja empates en puestos intermedios (1, 2, 2, 4)', () => {
    const pBobTwin: PlayerScore = {
      ...pBob,
      user_id: 'bob-twin',
    };
    const scores = [pCharlie, pBob, pBobTwin, pAlice];
    const rankings = resolveRankings(scores);

    expect(rankings[0]!.rank).toBe(1); // Alice
    expect(rankings[1]!.rank).toBe(2); // Bob
    expect(rankings[2]!.rank).toBe(2); // BobTwin
    expect(rankings[3]!.rank).toBe(4); // Charlie (4to puesto tras empate en 2do)
  });

  it('determineWinners devuelve múltiples ganadores en empate y único en victoria clara', () => {
    // Victoria clara
    expect(determineWinners([pAlice, pBob])).toEqual(['alice']);

    // Empate en primer lugar
    const winners = determineWinners([pAlice, pEve, pBob]);
    expect(winners).toContain('alice');
    expect(winners).toContain('eve');
    expect(winners).toHaveLength(2);

    // Arreglo vacío
    expect(determineWinners([])).toEqual([]);
  });

  it('resolveWinnerId devuelve ID único si no hay empate y null si hay empate', () => {
    expect(resolveWinnerId(['alice'])).toBe('alice');
    expect(resolveWinnerId(['alice', 'eve'])).toBeNull();
    expect(resolveWinnerId([])).toBeNull();
  });
});
