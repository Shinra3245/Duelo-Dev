/**
 * Límites del juez (decisiones D3 y D7).
 *
 * IMPORTANTE (contexto H9): la fuente de verdad de estos valores es
 * `judge/limits.py`. Este archivo es su espejo en TypeScript para que la API
 * pueda resolver el límite por lenguaje ANTES de encolar el job. La igualdad
 * entre ambos se verifica en `tests/limits-contract.test.ts`.
 *
 * No escribas un número de tiempo, memoria o pids en ningún otro archivo.
 */

export const LANGUAGES = ['python', 'cpp', 'java'] as const;
export type Language = (typeof LANGUAGES)[number];

/** Multiplicador de tiempo respecto al límite base, que es el de C++ (D3). */
export const TIME_MULTIPLIERS: Record<Language, number> = {
  python: 3,
  cpp: 1,
  java: 2,
};

/** Límite base por defecto en milisegundos; C++ (D7). Cada problema puede subirlo. */
export const DEFAULT_TIME_LIMIT_MS = 2000;

/** Límites duros del contenedor, iguales para todo lenguaje (D7). */
export const MEMORY_LIMIT_MB = 256;
export const CPU_LIMIT = 1.0;
export const PIDS_LIMIT = 64;
export const OUTPUT_LIMIT_BYTES = 1024 * 1024;
export const SOURCE_CODE_MAX_BYTES = 64 * 1024;

/** Timeouts de compilación en milisegundos. Python no compila. */
export const COMPILE_TIMEOUT_MS: Record<Language, number> = {
  python: 0,
  cpp: 10_000,
  java: 15_000,
};

/**
 * Margen del timeout externo de pared respecto al límite interno.
 * Red de seguridad si el `timeout` dentro del contenedor falla (doc 06 §1).
 */
export const WALL_CLOCK_MARGIN = 1.5;

/** Cooldown entre envíos por jugador, en segundos (D7). */
export const SUBMIT_COOLDOWN_S = 10;

/** Resuelve el límite efectivo para un lenguaje a partir del límite base del problema. */
export function resolveTimeLimitMs(baseMs: number, language: Language): number {
  return Math.round(baseMs * TIME_MULTIPLIERS[language]);
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}
