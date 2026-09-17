import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROBLEM_CATEGORIES } from '@duelodev/shared';
import { InMemoryProblemRepository } from '../src/repositories/memory.js';
import {
  PILOT_PROBLEMS,
  calculateProblemContentHash,
  deterministicProblemId,
  seedProblems,
} from '../src/seeds/index.js';

interface CaseBundleManifest {
  schema_version: number;
  problem_id: string;
  problem_version: number;
  cases: Array<{ ordinal: number; input: string; expected: string }>;
}

function loadCaseBundle(problemId: string, version: number): CaseBundleManifest {
  const url = new URL(
    `../../problems/cases/${problemId}/v${version}/manifest.json`,
    import.meta.url,
  );
  return JSON.parse(readFileSync(url, 'utf8')) as CaseBundleManifest;
}

describe('Problem Seeds and Seeder Service (doc 04 §1, doc 07)', () => {
  describe('Catálogo de problemas piloto (PILOT_PROBLEMS)', () => {
    it('contiene exactamente los problemas piloto aprobados', () => {
      expect(PILOT_PROBLEMS).toHaveLength(4);
      const slugs = PILOT_PROBLEMS.map((p) => p.slug);
      expect(slugs).toEqual(['suma-parcial', 'parentesis', 'consultas-suma', 'fibonacci']);
    });

    it('cumple los invariantes de estructura, límites y origen en cada problema piloto', () => {
      for (const prob of PILOT_PROBLEMS) {
        expect(prob.slug).toMatch(/^[a-z0-9-]+$/);
        expect(prob.title.length).toBeGreaterThan(0);
        expect(PROBLEM_CATEGORIES).toContain(prob.category);
        expect(prob.time_limit_ms).toBeGreaterThan(0);
        expect(prob.memory_limit_mb).toBeGreaterThan(0);
        expect(prob.version).toBeGreaterThanOrEqual(1);
        expect(prob.description.length).toBeGreaterThan(20);

        // Origen verificado
        expect(prob.origin.verification_status).toBe('verified');
        expect(['original', 'adapted']).toContain(prob.origin.kind);

        // Exactamente 2 ejemplos y 10 casos ocultos (total 12)
        const examples = prob.test_cases.filter((tc) => tc.is_example);
        const hidden = prob.test_cases.filter((tc) => !tc.is_example);
        expect(examples).toHaveLength(2);
        expect(hidden).toHaveLength(10);
        expect(prob.test_cases).toHaveLength(12);

        // Ordinales estrictamente secuenciales de 0 a 11 sin duplicados
        const ordinals = prob.test_cases.map((tc) => tc.ordinal);
        expect(ordinals).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

        // Ejemplos tienen ordinales 0 y 1
        expect(examples[0]?.ordinal).toBe(0);
        expect(examples[1]?.ordinal).toBe(1);

        // Todos los casos tienen entradas y salidas formateadas con salto de línea
        for (const tc of prob.test_cases) {
          expect(tc.input.length).toBeGreaterThan(0);
          expect(tc.expected_output.length).toBeGreaterThan(0);
          expect(tc.input.endsWith('\n')).toBe(true);
          expect(tc.expected_output.endsWith('\n')).toBe(true);
        }
      }
    });
  });

  describe('Cálculo determinista de content_hash', () => {
    it('genera un hash SHA-256 de 64 caracteres hexadecimales', () => {
      const hash = calculateProblemContentHash(PILOT_PROBLEMS[0]!);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('es determinista entre múltiples llamadas con los mismos datos', () => {
      const hash1 = calculateProblemContentHash(PILOT_PROBLEMS[1]!);
      const hash2 = calculateProblemContentHash(PILOT_PROBLEMS[1]!);
      expect(hash1).toBe(hash2);
    });

    it('produce hashes distintos para problemas diferentes', () => {
      const hash0 = calculateProblemContentHash(PILOT_PROBLEMS[0]!);
      const hash1 = calculateProblemContentHash(PILOT_PROBLEMS[1]!);
      const hash2 = calculateProblemContentHash(PILOT_PROBLEMS[2]!);

      expect(hash0).not.toBe(hash1);
      expect(hash1).not.toBe(hash2);
      expect(hash0).not.toBe(hash2);
    });

    it('cambia el hash si se altera un caso de prueba o un límite', () => {
      const original = PILOT_PROBLEMS[0]!;
      const hashOriginal = calculateProblemContentHash(original);

      const modifiedLimit = {
        ...original,
        time_limit_ms: original.time_limit_ms + 100,
      };
      expect(calculateProblemContentHash(modifiedLimit)).not.toBe(hashOriginal);

      const modifiedCase = {
        ...original,
        test_cases: original.test_cases.map((tc) =>
          tc.ordinal === 0 ? { ...tc, expected_output: '999\n' } : tc,
        ),
      };
      expect(calculateProblemContentHash(modifiedCase)).not.toBe(hashOriginal);
    });
  });

  describe('Identidad estable para paquetes de casos del juez', () => {
    it('genera UUIDs deterministas y distintos por slug/version', () => {
      const sumaV1 = deterministicProblemId('suma-parcial', 1);
      expect(sumaV1).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(deterministicProblemId('suma-parcial', 1)).toBe(sumaV1);
      expect(deterministicProblemId('suma-parcial', 2)).not.toBe(sumaV1);
      expect(deterministicProblemId('parentesis', 1)).not.toBe(sumaV1);
    });

    it('siembra problemas nuevos con IDs compatibles con cases/{problem_id}/v{version}', async () => {
      const repo = new InMemoryProblemRepository();
      await seedProblems(repo);

      const problems = await repo.findAllProblems();
      const byTitle = new Map(problems.map((problem) => [problem.title, problem]));

      for (const seed of PILOT_PROBLEMS) {
        const problem = byTitle.get(seed.title);
        expect(problem?.id).toBe(deterministicProblemId(seed.slug, seed.version));
      }
    });

    it('mantiene sincronizados los bundles del juez con los casos sembrados en API', () => {
      for (const seed of PILOT_PROBLEMS) {
        const problemId = deterministicProblemId(seed.slug, seed.version);
        const manifest = loadCaseBundle(problemId, seed.version);

        expect(manifest.schema_version).toBe(1);
        expect(manifest.problem_id).toBe(problemId);
        expect(manifest.problem_version).toBe(seed.version);
        expect(manifest.cases).toHaveLength(seed.test_cases.length);
        expect(manifest.cases).toEqual(
          seed.test_cases.map((testCase) => ({
            ordinal: testCase.ordinal + 1,
            input: testCase.input,
            expected: testCase.expected_output,
          })),
        );
      }
    });
  });

  describe('seedProblems (siembra e idempotencia)', () => {
    it('siembra exitosamente todos los problemas piloto y sus casos en un repositorio vacío', async () => {
      const repo = new InMemoryProblemRepository();
      const result = await seedProblems(repo);

      expect(result.seeded).toBe(PILOT_PROBLEMS.length);
      expect(result.skipped).toBe(0);
      expect(result.problems).toHaveLength(PILOT_PROBLEMS.length);
      expect(result.test_cases).toHaveLength(PILOT_PROBLEMS.length * 12);

      // Verificar que los problemas existen en el repositorio
      const allProblems = await repo.findAllProblems();
      expect(allProblems).toHaveLength(PILOT_PROBLEMS.length);

      for (const p of allProblems) {
        const cases = await repo.findTestCasesByProblemId(p.id);
        expect(cases).toHaveLength(12);

        const examples = cases.filter((c) => c.is_example);
        const hidden = cases.filter((c) => !c.is_example);
        expect(examples).toHaveLength(2);
        expect(hidden).toHaveLength(10);
      }
    });

    it('es estrictamente idempotente: una segunda ejecución no duplica registros ni altera versiones', async () => {
      const repo = new InMemoryProblemRepository();

      const result1 = await seedProblems(repo);
      expect(result1.seeded).toBe(PILOT_PROBLEMS.length);
      expect(result1.skipped).toBe(0);

      const result2 = await seedProblems(repo);
      expect(result2.seeded).toBe(0);
      expect(result2.skipped).toBe(PILOT_PROBLEMS.length);

      const allProblems = await repo.findAllProblems();
      expect(allProblems).toHaveLength(PILOT_PROBLEMS.length);

      for (const p of allProblems) {
        const cases = await repo.findTestCasesByProblemId(p.id);
        expect(cases).toHaveLength(12);
      }
    });

    it('permite forzar la re-siembra sin violar la restricción de ordinal único', async () => {
      const repo = new InMemoryProblemRepository();

      await seedProblems(repo);
      const resultForce = await seedProblems(repo, { force: true });

      expect(resultForce.seeded).toBe(PILOT_PROBLEMS.length);
      expect(resultForce.skipped).toBe(0);

      const allProblems = await repo.findAllProblems();
      expect(allProblems).toHaveLength(PILOT_PROBLEMS.length);

      for (const p of allProblems) {
        const cases = await repo.findTestCasesByProblemId(p.id);
        expect(cases).toHaveLength(12);
        // Verificar que no hay ordinales duplicados
        const ordinals = cases.map((c) => c.ordinal);
        const uniqueOrdinals = new Set(ordinals);
        expect(uniqueOrdinals.size).toBe(12);
      }
    });

    it('recupera problemas por content_hash mediante findProblemByContentHash', async () => {
      const repo = new InMemoryProblemRepository();
      await seedProblems(repo);

      const expectedHash = calculateProblemContentHash(PILOT_PROBLEMS[0]!);
      const found = await repo.findProblemByContentHash(expectedHash);

      expect(found).not.toBeNull();
      expect(found?.title).toBe(PILOT_PROBLEMS[0]?.title);
      expect(found?.category).toBe(PILOT_PROBLEMS[0]?.category);
    });

    it('integra seedPilotProblems en createApp y expone el problema vía GET /problems/:id/public', async () => {
      const { createApp } = await import('../src/app.js');
      const app = createApp({ seedPilotProblems: true });
      const { port } = await app.start(0, '127.0.0.1');

      try {
        const allProblems = await app.ctx.problemRepo.findAllProblems!();
        expect(allProblems).toHaveLength(PILOT_PROBLEMS.length);

        const sumaProb = allProblems.find((p) => p.title === 'Suma parcial');
        expect(sumaProb).toBeDefined();

        // Registrar usuario para consultar endpoint protegido
        const regRes = await fetch(`http://127.0.0.1:${port}/api/v1/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'seeder-user@test.com',
            gamertag: 'SeederUser',
            password: 'Password123!',
          }),
        });
        const rawCookies =
          typeof regRes.headers.getSetCookie === 'function'
            ? regRes.headers.getSetCookie()
            : [regRes.headers.get('set-cookie') ?? ''];
        let cookieHeader = '';
        for (const str of rawCookies) {
          if (str.includes('access_token=')) {
            const part = str.split(';')[0]!;
            cookieHeader = part.trim();
            break;
          }
        }

        const probRes = await fetch(
          `http://127.0.0.1:${port}/api/v1/problems/${sumaProb!.id}/public`,
          {
            headers: { Cookie: cookieHeader },
          },
        );

        expect(probRes.status).toBe(200);
        const probData = (await probRes.json()) as {
          problem_id: string;
          title: string;
          description: string;
          time_limit_ms: number;
          memory_limit_mb: number;
          examples: Array<{ ordinal?: number; input: string; output: string }>;
        };

        expect(probData.problem_id).toBe(sumaProb!.id);
        expect(probData.title).toBe('Suma parcial');
        expect(probData.time_limit_ms).toBe(2000);
        expect(probData.memory_limit_mb).toBe(256);
        // Debe exponer ÚNICAMENTE los 2 ejemplos públicos
        expect(probData.examples).toHaveLength(2);
        expect(probData.examples[0]?.input).toBe('5\n1 2 3 4 5\n');
        expect(probData.examples[0]?.output).toBe('15\n');
      } finally {
        await app.close();
      }
    });
  });
});
