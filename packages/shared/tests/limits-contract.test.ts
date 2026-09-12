/**
 * Test de contrato TypeScript ↔ Python (contexto H9).
 *
 * `judge/limits.py` y `judge/verdicts.py` son la fuente de verdad; este test
 * falla si los espejos de `packages/shared` divergen. Sin esto, un TLE deja de
 * ser reproducible y nadie se entera hasta el evento.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  COMPILE_TIMEOUT_MS,
  CPU_LIMIT,
  DEFAULT_TIME_LIMIT_MS,
  LANGUAGES,
  MEMORY_LIMIT_MB,
  OUTPUT_LIMIT_BYTES,
  PIDS_LIMIT,
  SOURCE_CODE_MAX_BYTES,
  SUBMIT_COOLDOWN_S,
  TIME_MULTIPLIERS,
  WALL_CLOCK_MARGIN,
  resolveTimeLimitMs,
} from '../src/limits.js';
import { VERDICTS } from '../src/verdicts.js';

const here = dirname(fileURLToPath(import.meta.url));
const judgeDir = resolve(here, '../../../judge');
const limitsPy = readFileSync(resolve(judgeDir, 'limits.py'), 'utf8');
const verdictsPy = readFileSync(resolve(judgeDir, 'verdicts.py'), 'utf8');

/** Lee un escalar `NOMBRE: Final[tipo] = valor` de limits.py. */
function pyScalar(name: string): number {
  const match = limitsPy.match(new RegExp(`^${name}:\\s*Final\\[[^\\]]+\\]\\s*=\\s*(.+)$`, 'm'));
  if (!match?.[1]) throw new Error(`No se encontró ${name} en judge/limits.py`);
  // Soporta separadores de miles (1024 * 1024, 10_000) tal como se escriben en Python.
  return Number(new Function(`return (${match[1].replaceAll('_', '')});`)());
}

/** Lee un dict `NOMBRE: Final[dict[...]] = { "clave": valor, ... }` de limits.py. */
function pyDict(name: string): Record<string, number> {
  const match = limitsPy.match(new RegExp(`^${name}:[^=]+=\\s*\\{([\\s\\S]*?)\\}`, 'm'));
  if (!match?.[1]) throw new Error(`No se encontró ${name} en judge/limits.py`);
  const out: Record<string, number> = {};
  for (const entry of match[1].matchAll(/"(\w+)"\s*:\s*([\d_.]+)/g)) {
    out[entry[1] as string] = Number((entry[2] as string).replaceAll('_', ''));
  }
  return out;
}

describe('contrato de límites TS ↔ Python', () => {
  it('los multiplicadores de tiempo coinciden (D3)', () => {
    expect(pyDict('TIME_MULTIPLIERS')).toEqual(TIME_MULTIPLIERS);
  });

  it('los timeouts de compilación coinciden', () => {
    expect(pyDict('COMPILE_TIMEOUT_MS')).toEqual(COMPILE_TIMEOUT_MS);
  });

  it.each([
    ['DEFAULT_TIME_LIMIT_MS', DEFAULT_TIME_LIMIT_MS],
    ['CPU_LIMIT', CPU_LIMIT],
    ['MEMORY_LIMIT_MB', MEMORY_LIMIT_MB],
    ['PIDS_LIMIT', PIDS_LIMIT],
    ['OUTPUT_LIMIT_BYTES', OUTPUT_LIMIT_BYTES],
    ['SOURCE_CODE_MAX_BYTES', SOURCE_CODE_MAX_BYTES],
    ['WALL_CLOCK_MARGIN', WALL_CLOCK_MARGIN],
    ['SUBMIT_COOLDOWN_S', SUBMIT_COOLDOWN_S],
  ])('%s coincide con judge/limits.py', (name, tsValue) => {
    expect(pyScalar(name as string)).toBe(tsValue);
  });

  it('la lista de lenguajes coincide (D3)', () => {
    const block = limitsPy.match(/^LANGUAGES:[^=]+=\s*\(([^)]+)\)/m);
    expect(block?.[1], 'no se encontró LANGUAGES en judge/limits.py').toBeDefined();
    const pyLanguages = [...(block?.[1] ?? '').matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect(pyLanguages).toEqual([...LANGUAGES]);
  });

  it('el enum de veredictos coincide (§5.3)', () => {
    const pyVerdicts = [...verdictsPy.matchAll(/^\s{4}(\w+)\s*=\s*"(\w+)"/gm)].map((m) => m[2]);
    expect(pyVerdicts.sort()).toEqual(Object.keys(VERDICTS).sort());
  });
});

describe('resolveTimeLimitMs', () => {
  it('C++ usa el límite base sin multiplicar (D3)', () => {
    expect(resolveTimeLimitMs(2000, 'cpp')).toBe(2000);
  });

  it('Python triplica y Java duplica (D3)', () => {
    expect(resolveTimeLimitMs(2000, 'python')).toBe(6000);
    expect(resolveTimeLimitMs(2000, 'java')).toBe(4000);
  });

  it('respeta el límite base propio de cada problema', () => {
    expect(resolveTimeLimitMs(3500, 'java')).toBe(7000);
  });
});
