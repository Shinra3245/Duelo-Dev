import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PILOT_PROBLEMS } from '../src/seeds/pilot-problems.js';

describe('referencias privadas multilenguaje', () => {
  for (const filename of ['solution.py', 'main.cpp', 'Main.java']) {
    it(`${filename} cubre los treinta retos activos sin incorporar casos ocultos`, () => {
      const source = readFileSync(
        new URL(`../../problems/reference-solutions/${filename}`, import.meta.url),
        'utf8',
      );
      const active = PILOT_PROBLEMS.filter((problem) => problem.category !== 'muy_facil');
      expect(active).toHaveLength(30);
      expect(source.match(/__PROBLEM_SLUG__/g)).toHaveLength(1);
      for (const problem of active) {
        expect(source).toContain(`"${problem.slug}"`);
      }
      expect(source).not.toContain('expected_output');
      expect(source).not.toContain('manifest.json');
    });
  }
});
