import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('configuración del smoke operativo', () => {
  for (const language of ['rust', '', 'python ']) {
    it(`rechaza ${JSON.stringify(language)} antes de crear cuentas o salas`, () => {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('../../scripts/tournament-smoke.mjs', import.meta.url))],
        {
          encoding: 'utf8',
          timeout: 5000,
          env: { ...process.env, SMOKE_LANGUAGE: language, API_URL: 'http://127.0.0.1:1/api/v1' },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('SMOKE_LANGUAGE debe ser python, cpp o java');
      expect(result.stdout).not.toContain('Usuarios creados');
    });
  }
});
