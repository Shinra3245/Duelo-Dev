import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));

/** Directorio absoluto donde residen las migraciones SQL. */
export const MIGRATIONS_DIR = join(currentDir, '..', '..', 'migrations');

/**
 * Carga el contenido SQL de una migración según su nombre y dirección ('up' o 'down').
 */
export function getMigrationSql(name: string, direction: 'up' | 'down'): string {
  const filename = `${name}.${direction}.sql`;
  const filePath = join(MIGRATIONS_DIR, filename);
  return readFileSync(filePath, 'utf8');
}
