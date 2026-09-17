/**
 * Servicio de siembra determinista e idempotente de problemas (doc 04 §1, doc 07 § Aceptación).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ProblemEntity, TestCaseEntity } from '@duelodev/shared';
import type { ProblemRepository } from '../repositories/types.js';
import { PILOT_PROBLEMS } from './pilot-problems.js';
import type { SeedProblem, SeedResult, SeederOptions } from './types.js';

/**
 * Genera un UUID estable para problemas semilla. Esto permite que el juez encuentre
 * paquetes de casos versionados en disco mediante `cases/{problem_id}/v{version}`.
 */
export function deterministicProblemId(slug: string, version: number): string {
  if (!/^[a-z0-9-]+$/.test(slug) || !Number.isInteger(version) || version < 1) {
    throw new Error('La identidad de problema semilla es inválida');
  }

  const bytes = createHash('sha256')
    .update('duelodev.problem.seed\n')
    .update(slug)
    .update('\n')
    .update(String(version))
    .digest()
    .subarray(0, 16);

  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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

    const problemId = existing?.id ?? deterministicProblemId(seedDef.slug, seedDef.version);
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
