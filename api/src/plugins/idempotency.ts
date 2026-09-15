import type { IncomingMessage } from 'node:http';
import { ERROR_CODES, IDEMPOTENCY_KEY_HEADER } from '@duelodev/shared';
import { HttpError } from './body-parser.js';

/** Expresión regular para caracteres válidos en Idempotency-Key (ASCII seguro, alfanumérico, guiones, puntos). */
export const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_\-.:]{1,128}$/;

/**
 * Extrae y valida el encabezado `Idempotency-Key` si está presente.
 * Devuelve `null` si no se incluyó el encabezado.
 * Lanza `HttpError` (400) si el encabezado es inválido, duplicado o supera límites.
 */
export function extractIdempotencyKey(req: IncomingMessage): string | null {
  const headerValue = req.headers[IDEMPOTENCY_KEY_HEADER];

  if (headerValue === undefined) {
    return null;
  }

  if (Array.isArray(headerValue)) {
    throw new HttpError(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      'Se enviaron múltiples encabezados Idempotency-Key.',
      { header: IDEMPOTENCY_KEY_HEADER },
    );
  }

  const trimmed = headerValue.trim();
  if (trimmed.length === 0) {
    throw new HttpError(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      'El encabezado Idempotency-Key no puede estar vacío.',
      { header: IDEMPOTENCY_KEY_HEADER },
    );
  }

  if (trimmed.length > 128) {
    throw new HttpError(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      'El encabezado Idempotency-Key excede el límite máximo de 128 caracteres.',
      { header: IDEMPOTENCY_KEY_HEADER, length: trimmed.length },
    );
  }

  if (!IDEMPOTENCY_KEY_REGEX.test(trimmed)) {
    throw new HttpError(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      'El formato del encabezado Idempotency-Key contiene caracteres no permitidos.',
      { header: IDEMPOTENCY_KEY_HEADER, value: trimmed },
    );
  }

  return trimmed;
}
