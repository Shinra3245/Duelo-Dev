// Metadatos confiables, sin inputs ni salidas ocultas. Requiere npm run build.
import process from 'node:process';
import { PILOT_PROBLEMS } from '../../api/dist/seeds/pilot-problems.js';
import { deterministicProblemId } from '../../api/dist/seeds/seeder.js';

const active = PILOT_PROBLEMS.filter((problem) => problem.category !== 'muy_facil');
process.stdout.write(
  JSON.stringify(
    active.map((problem) => ({
      slug: problem.slug,
      problem_id: deterministicProblemId(problem.slug, problem.version),
      version: problem.version,
      time_limit_ms: problem.time_limit_ms,
      memory_limit_mb: problem.memory_limit_mb,
    })),
  ),
);
