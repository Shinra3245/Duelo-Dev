import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getMigrationSql, MIGRATIONS_DIR } from '../src/services/migrations.js';
import {
  GAMERTAG_REGEX,
  LANGUAGES,
  MATCH_FINISH_REASONS,
  MATCH_STATUSES,
  PLAYER_CONNECTIONS,
  PROBLEM_CATEGORIES,
  ROUND_STATUSES,
  USER_ROLES,
  VERDICTS,
} from '@duelodev/shared';

describe('PostgreSQL Database Migrations (001_initial_schema)', () => {
  it('los archivos de migración existen en api/migrations/', () => {
    expect(existsSync(MIGRATIONS_DIR)).toBe(true);
    expect(existsSync(join(MIGRATIONS_DIR, '001_initial_schema.up.sql'))).toBe(true);
    expect(existsSync(join(MIGRATIONS_DIR, '001_initial_schema.down.sql'))).toBe(true);
  });

  it('el script UP define todas las 13 tablas requeridas por los contratos de datos', () => {
    const sql = getMigrationSql('001_initial_schema', 'up');

    const expectedTables = [
      'users',
      'refresh_tokens',
      'problems',
      'test_cases',
      'matches',
      'match_players',
      'match_rounds',
      'submissions',
      'match_solves',
      'match_round_results',
      'match_processed_submissions',
      'match_code_snapshots',
      'events',
    ];

    for (const table of expectedTables) {
      const regex = new RegExp(`CREATE TABLE (IF NOT EXISTS )?${table}\\b`, 'i');
      expect(sql).toMatch(regex);
    }
  });

  it('el script DOWN elimina todas las tablas en orden inverso con CASCADE', () => {
    const sql = getMigrationSql('001_initial_schema', 'down');

    const expectedTables = [
      'events',
      'match_code_snapshots',
      'match_processed_submissions',
      'match_round_results',
      'match_solves',
      'submissions',
      'match_rounds',
      'match_players',
      'matches',
      'test_cases',
      'problems',
      'refresh_tokens',
      'users',
    ];

    for (const table of expectedTables) {
      const regex = new RegExp(`DROP TABLE (IF EXISTS )?${table} CASCADE`, 'i');
      expect(sql).toMatch(regex);
    }
  });

  it('las restricciones CHECK de SQL coinciden con los contratos y enumeraciones de shared', () => {
    const sql = getMigrationSql('001_initial_schema', 'up');

    // 1. Roles de usuario
    for (const role of USER_ROLES) {
      expect(sql).toContain(`'${role}'`);
    }

    // 2. Regex de gamertag
    expect(sql).toContain(GAMERTAG_REGEX.source);

    // 3. Categorías de problemas
    for (const category of PROBLEM_CATEGORIES) {
      expect(sql).toContain(`'${category}'`);
    }

    // 4. Estados de partida
    for (const status of MATCH_STATUSES) {
      expect(sql).toContain(`'${status}'`);
    }

    // 5. Motivos de finalización
    for (const reason of MATCH_FINISH_REASONS) {
      expect(sql).toContain(`'${reason}'`);
    }

    // 6. Conexión de jugadores
    for (const conn of PLAYER_CONNECTIONS) {
      expect(sql).toContain(`'${conn}'`);
    }

    // 7. Estados de ronda
    for (const rStatus of ROUND_STATUSES) {
      expect(sql).toContain(`'${rStatus}'`);
    }

    // 8. Lenguajes soportados
    for (const lang of LANGUAGES) {
      expect(sql).toContain(`'${lang}'`);
    }

    // 9. Veredictos del juez
    for (const verdict of Object.values(VERDICTS)) {
      expect(sql).toContain(`'${verdict}'`);
    }

    // 10. Invariantes de envíos
    expect(sql).toContain('passed_cases <= total_cases');
    expect(sql).toContain('admission_seq >= 1');
  });

  it('incluye las restricciones de unicidad especificadas en doc 04 §1', () => {
    const sql = getMigrationSql('001_initial_schema', 'up');

    // Unicidad de solves por partida, usuario y ronda
    expect(sql).toMatch(/UNIQUE \(\s*match_id,\s*user_id,\s*round_id\s*\)/i);

    // Unicidad de resolución por ronda en Puntos
    expect(sql).toMatch(/UNIQUE \(\s*match_id,\s*round_id\s*\)/i);

    // Unicidad de orden de admisión por partida
    expect(sql).toMatch(/UNIQUE \(\s*match_id,\s*admission_seq\s*\)/i);

    // Unicidad de jugador por partida
    expect(sql).toMatch(/UNIQUE \(\s*match_id,\s*user_id\s*\)/i);

    // Unicidad de ordinal en test cases
    expect(sql).toMatch(/UNIQUE \(\s*problem_id,\s*ordinal\s*\)/i);
  });
});
