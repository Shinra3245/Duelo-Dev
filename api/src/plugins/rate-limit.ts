import type { IncomingMessage, ServerResponse } from 'node:http';
import { ERROR_CODES } from '@duelodev/shared';
import { HttpError } from './body-parser.js';

/** Opciones de configuración para el limitador de tasa en memoria. */
export interface RateLimiterOptions {
  windowMs?: number;
  maxRequests?: number;
  keyGenerator?: (req: IncomingMessage) => string;
}

/** Resultado de una operación de consumo de cuota de tasa. */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAfterSeconds: number;
}

/** Generador de clave por defecto a partir de IP (soporta x-forwarded-for y remoteAddress). */
export function defaultKeyGenerator(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  } else if (Array.isArray(forwarded) && forwarded.length > 0 && typeof forwarded[0] === 'string') {
    const first = forwarded[0].split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? '127.0.0.1';
}

/**
 * Limitador de tasa en memoria con ventana deslizante para endpoints públicos (ej. auth).
 */
export class RateLimiter {
  private readonly defaultWindowMs: number;
  private readonly defaultMaxRequests: number;
  private readonly keyGenerator: (req: IncomingMessage) => string;
  private readonly hits = new Map<string, number[]>();

  constructor(options?: RateLimiterOptions) {
    this.defaultWindowMs = options?.windowMs ?? 60_000;
    this.defaultMaxRequests = options?.maxRequests ?? 10;
    this.keyGenerator = options?.keyGenerator ?? defaultKeyGenerator;
  }

  /**
   * Consume una unidad de cuota para la clave dada en la ventana especificada.
   */
  consume(
    key: string,
    maxRequests?: number,
    windowMs?: number,
    now?: number,
  ): { allowed: boolean; remaining: number; resetAfterSeconds: number } {
    const window = windowMs ?? this.defaultWindowMs;
    const max = maxRequests ?? this.defaultMaxRequests;
    const currentTime = now ?? Date.now();
    const cutoff = currentTime - window;

    const existing = this.hits.get(key) ?? [];
    const valid = existing.filter((ts) => ts > cutoff);

    if (valid.length >= max) {
      this.hits.set(key, valid);
      const oldest = valid[0] ?? currentTime;
      const resetAfterSeconds = Math.max(1, Math.ceil((oldest + window - currentTime) / 1000));
      return {
        allowed: false,
        remaining: 0,
        resetAfterSeconds,
      };
    }

    valid.push(currentTime);
    this.hits.set(key, valid);
    const oldest = valid[0] ?? currentTime;
    const resetAfterSeconds = Math.max(1, Math.ceil((oldest + window - currentTime) / 1000));
    const remaining = Math.max(0, max - valid.length);

    return {
      allowed: true,
      remaining,
      resetAfterSeconds,
    };
  }

  /**
   * Verifica la cuota para una petición HTTP. Si excede el límite, fija Retry-After y lanza HttpError 429.
   */
  check(
    req: IncomingMessage,
    res: ServerResponse,
    actionPrefix: string,
    maxRequests?: number,
    windowMs?: number,
  ): void {
    const rawKey = this.keyGenerator(req);
    const key = actionPrefix ? `${actionPrefix}:${rawKey}` : rawKey;
    const result = this.consume(key, maxRequests, windowMs);

    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.resetAfterSeconds));
      throw new HttpError(
        429,
        ERROR_CODES.RATE_LIMITED,
        'Demasiadas solicitudes. Por favor intente más tarde.',
        { retry_after_s: result.resetAfterSeconds },
      );
    }
  }

  /**
   * Limpia todos los registros almacenados (útil para pruebas).
   */
  clear(): void {
    this.hits.clear();
  }
}
