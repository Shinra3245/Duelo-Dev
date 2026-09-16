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

/**
 * Ejecuta las migraciones 001 y 002 hacia arriba en orden secuencial.
 */
export async function runMigrations(clientOrPool: {
  query: (sql: string) => Promise<unknown>;
}): Promise<void> {
  await clientOrPool.query(getMigrationSql('001_initial_schema', 'up'));
  await clientOrPool.query(getMigrationSql('002_judge_lease_fencing', 'up'));
}

/**
 * Revierte las migraciones 002 y 001 hacia abajo en orden inverso.
 */
export async function rollbackMigrations(clientOrPool: {
  query: (sql: string) => Promise<unknown>;
}): Promise<void> {
  await clientOrPool.query(getMigrationSql('002_judge_lease_fencing', 'down'));
  await clientOrPool.query(getMigrationSql('001_initial_schema', 'down'));
}
