import { describe, expect, it } from 'vitest';
import { PILOT_PROBLEMS } from '../src/seeds/pilot-problems.js';

const ACTIVE_CATEGORIES = ['facil', 'facil_medio', 'dificil'] as const;
const ACTIVE_PILOT_SLUGS = ['parentesis', 'consultas-suma', 'palindromo', 'producto-punto'];

function tokens(input: string): string[] {
  return input.trim().split(/\s+/);
}

function referenceOutput(slug: string, input: string): string {
  const data = tokens(input);

  switch (slug) {
    case 'parentesis': {
      const closingFor: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
      const stack: string[] = [];
      for (const character of data[0]!) {
        if ('([{'.includes(character)) {
          stack.push(character);
        } else if (closingFor[character] !== stack.pop()) {
          return 'INVALIDO\n';
        }
      }
      return stack.length === 0 ? 'VALIDO\n' : 'INVALIDO\n';
    }
    case 'consultas-suma': {
      const count = Number(data[0]);
      const queryCount = Number(data[1]);
      const values = data.slice(2, count + 2).map(Number);
      const prefix = [0];
      for (const value of values) prefix.push(prefix.at(-1)! + value);

      const answers: number[] = [];
      for (let query = 0; query < queryCount; query++) {
        const start = Number(data[count + 2 + query * 2]);
        const end = Number(data[count + 3 + query * 2]);
        answers.push(prefix[end]! - prefix[start - 1]!);
      }
      return `${answers.join('\n')}\n`;
    }
    case 'palindromo': {
      const word = data[0]!;
      return `${word === [...word].reverse().join('') ? 'SI' : 'NO'}\n`;
    }
    case 'producto-punto': {
      const count = Number(data[0]);
      const left = data.slice(1, count + 1).map(BigInt);
      const right = data.slice(count + 1, count * 2 + 1).map(BigInt);
      const product = left.reduce((sum, value, index) => sum + value * right[index]!, 0n);
      return `${product}\n`;
    }
    default:
      throw new Error(`No existe referencia confiable para ${slug}`);
  }
}

describe('catálogo de dificultades activas', () => {
  const activeProblems = PILOT_PROBLEMS.filter((problem) => problem.category !== 'muy_facil');

  it('mantiene exactamente diez problemas por cada dificultad activa', () => {
    expect(activeProblems).toHaveLength(30);
    for (const category of ACTIVE_CATEGORIES) {
      expect(activeProblems.filter((problem) => problem.category === category)).toHaveLength(10);
    }
  });

  it('valida los 12 casos de cada problema piloto activo contra una referencia independiente', () => {
    const pilotProblems = activeProblems.filter((problem) =>
      ACTIVE_PILOT_SLUGS.includes(problem.slug),
    );

    expect(pilotProblems.map((problem) => problem.slug).sort()).toEqual(
      [...ACTIVE_PILOT_SLUGS].sort(),
    );

    for (const problem of pilotProblems) {
      expect(problem.test_cases, problem.slug).toHaveLength(12);
      for (const testCase of problem.test_cases) {
        expect(
          referenceOutput(problem.slug, testCase.input),
          `${problem.slug}, caso ${testCase.ordinal}`,
        ).toBe(testCase.expected_output);
      }
    }
  });
});
