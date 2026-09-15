/**
 * Servicio de siembra determinista e idempotente de problemas (doc 04 §1, doc 07 § Aceptación).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ProblemEntity, TestCaseEntity } from '@duelodev/shared';
import type { ProblemRepository } from '../repositories/types.js';
import { PILOT_PROBLEMS } from './pilot-problems.js';
import type { SeedProblem, SeedResult, SeederOptions } from './types.js';

/**
 * Calcula un hash SHA-256 determinista de 64 caracteres del contenido del problema y sus casos.
 * Garantiza congelamiento de versión e integridad estricta (doc 04 §1, doc 07 §1).
 */
export function calculateProblemContentHash(problem: SeedProblem): string {
  const hash = createHash('sha256');

  hash.update(problem.slug);
  hash.update('\n');
  hash.update(problem.title);
  hash.update('\n');
  hash.update(problem.category);
  hash.update('\n');
  hash.update(problem.description);
  hash.update('\n');
  hash.update(String(problem.time_limit_ms));
  hash.update('\n');
  hash.update(String(problem.memory_limit_mb));
  hash.update('\n');
  hash.update(String(problem.version));
  hash.update('\n');

  // Ordenar casos de prueba por ordinal para hash determinista
  const sortedCases = [...problem.test_cases].sort((a, b) => a.ordinal - b.ordinal);
  for (const tc of sortedCases) {
    hash.update(`${tc.ordinal}:${tc.is_example ? 1 : 0}:${tc.input}:${tc.expected_output}\n`);
  }

  return hash.digest('hex');
}

/**
 * Siembra los problemas piloto en el repositorio de forma idempotente.
 * La segunda ejecución no duplica registros ni altera versiones existentes (doc 07 § Aceptación).
 */
export async function seedProblems(
  problemRepo: ProblemRepository,
  options: SeederOptions = {},
): Promise<SeedResult> {
  let seeded = 0;
  let skipped = 0;
  const problems: ProblemEntity[] = [];
  const testCases: TestCaseEntity[] = [];

  for (const seedDef of PILOT_PROBLEMS) {
    const contentHash = calculateProblemContentHash(seedDef);

    // Verificar si ya existe un problema con el mismo content_hash
    let existing: ProblemEntity | null = null;
    if (problemRepo.findProblemByContentHash) {
      existing = await problemRepo.findProblemByContentHash(contentHash);
    } else if (problemRepo.findAllProblems) {
      const all = await problemRepo.findAllProblems();
      existing = all.find((p) => p.content_hash === contentHash) ?? null;
    }

    if (existing && !options.force) {
      skipped++;
      problems.push(existing);
      const existingCases = await problemRepo.findTestCasesByProblemId(existing.id);
      testCases.push(...existingCases);
      continue;
    }

    const problemId = existing?.id ?? randomUUID();
    const now = new Date().toISOString();

    const problemEntity: ProblemEntity = {
      id: problemId,
      title: seedDef.title,
      description: seedDef.description,
      category: seedDef.category,
      time_limit_ms: seedDef.time_limit_ms,
      memory_limit_mb: seedDef.memory_limit_mb,
      version: seedDef.version,
      content_hash: contentHash,
      created_at: existing?.created_at ?? now,
    };

    await problemRepo.createProblem(problemEntity);
    problems.push(problemEntity);

    for (const tc of seedDef.test_cases) {
      const testCaseEntity: TestCaseEntity = {
        id: randomUUID(),
        problem_id: problemId,
        ordinal: tc.ordinal,
        input: tc.input,
        expected_output: tc.expected_output,
        is_example: tc.is_example,
        created_at: now,
      };

      await problemRepo.createTestCase(testCaseEntity);
      testCases.push(testCaseEntity);
    }

    seeded++;
  }

  return {
    seeded,
    skipped,
    problems,
    test_cases: testCases,
  };
}
