/**
 * Logger estructurado compartido (contexto H10).
 *
 * Una línea JSON por evento a stdout. Sin dependencias: en el MVP no hace falta
 * más, y esto funciona igual en la API, el Realtime y los scripts de prueba.
 *
 * Nunca registres: contraseñas, hashes, tokens, cookies, `source_code` ni el
 * contenido de casos ocultos (doc 04 y doc 06 §4b).
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Campos de correlación que atraviesan servicios. */
export interface LogContext {
  request_id?: string;
  match_id?: string;
  submission_id?: string;
  user_id?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  /** Deriva un logger que arrastra contexto fijo (p. ej. el `request_id`). */
  child(ctx: LogContext): Logger;
}

const REDACTED = '[redactado]';
const SENSITIVE = new Set([
  'password',
  'password_hash',
  'token',
  'access_token',
  'refresh_token',
  'authorization',
  'cookie',
  'source_code',
  'jwt',
  'secret',
]);

/** Poda claves sensibles en cualquier profundidad antes de serializar. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE.has(k.toLowerCase()) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

export function createLogger(service: string, minLevel: LogLevel = 'info'): Logger {
  const threshold = LEVEL_ORDER[minLevel];

  function make(base: LogContext): Logger {
    function emit(level: LogLevel, msg: string, ctx?: LogContext): void {
      if (LEVEL_ORDER[level] < threshold) return;
      const line = {
        ts: new Date().toISOString(),
        level,
        service,
        msg,
        ...(redact({ ...base, ...ctx }) as LogContext),
      };
      // Único punto del proyecto que escribe a stdout directamente.
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(line));
    }

    return {
      debug: (m, c) => emit('debug', m, c),
      info: (m, c) => emit('info', m, c),
      warn: (m, c) => emit('warn', m, c),
      error: (m, c) => emit('error', m, c),
      child: (c) => make({ ...base, ...c }),
    };
  }

  return make({});
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  return value && value in LEVEL_ORDER ? (value as LogLevel) : fallback;
}
