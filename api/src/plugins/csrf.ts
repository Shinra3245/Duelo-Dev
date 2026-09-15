/**
 * Plugin de verificación de origen y protección CSRF para peticiones de mutación (doc 04 §2).
 */
import type { IncomingMessage } from 'node:http';
import { ERROR_CODES } from '@duelodev/shared';
import { HttpError } from './body-parser.js';

export interface CsrfOptions {
  /** Lista explícita de orígenes permitidos (p. ej. ['http://localhost:3000', 'https://duelodev.com']) */
  allowedOrigins?: string[];
  /** Si es true, exige la presencia de Origin en métodos de mutación (por defecto: false para permitir CLI/tests) */
  requireOrigin?: boolean;
}

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Valida el origen de la solicitud HTTP para prevenir ataques de falsificación de peticiones
 * en sitios cruzados (CSRF) en operaciones que modifican el estado (doc 04 §2).
 */
export function validateCsrfOrigin(req: IncomingMessage, options: CsrfOptions = {}): void {
  const method = req.method?.toUpperCase() ?? 'GET';

  // Solo las peticiones que mutan estado requieren verificación de origen
  if (!STATE_CHANGING_METHODS.has(method)) {
    return;
  }

  const rawOrigin = req.headers['origin'];
  const rawReferer = req.headers['referer'];

  // Si no hay encabezados de origen ni referer (p. ej. scripts, CLI, tests o curl)
  if (!rawOrigin && !rawReferer) {
    if (options.requireOrigin) {
      throw new HttpError(
        403,
        ERROR_CODES.FORBIDDEN,
        'La solicitud requiere encabezado Origin para operaciones de mutación.',
      );
    }
    return;
  }

  let requestOrigin: string | null = null;

  if (typeof rawOrigin === 'string' && rawOrigin.length > 0) {
    requestOrigin = rawOrigin.toLowerCase();
  } else if (typeof rawReferer === 'string' && rawReferer.length > 0) {
    try {
      const url = new URL(rawReferer);
      requestOrigin = url.origin.toLowerCase();
    } catch {
      throw new HttpError(
        403,
        ERROR_CODES.FORBIDDEN,
        'El encabezado Referer no tiene un formato de URL válido.',
      );
    }
  }

  if (!requestOrigin) {
    return;
  }

  // Lista de orígenes permitidos configurados
  const allowedList = (options.allowedOrigins ?? []).map((o) => o.toLowerCase());

  // Si está en la lista explícita, se permite de inmediato
  if (allowedList.includes(requestOrigin)) {
    return;
  }

  // Por defecto, permitir orígenes locales de desarrollo (localhost / 127.0.0.1)
  try {
    const originUrl = new URL(requestOrigin);
    const host = originUrl.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      return;
    }
  } catch {
    throw new HttpError(403, ERROR_CODES.FORBIDDEN, 'Origen de solicitud inválido.');
  }

  // Verificar si coincide con el encabezado Host de la solicitud entrante
  const hostHeader = req.headers['host'];
  if (hostHeader) {
    try {
      const originUrl = new URL(requestOrigin);
      if (originUrl.host.toLowerCase() === hostHeader.toLowerCase()) {
        return;
      }
    } catch {
      // Ignorar fallo de parseo
    }
  }

  throw new HttpError(
    403,
    ERROR_CODES.FORBIDDEN,
    `Origen '${requestOrigin}' no autorizado para operaciones de estado.`,
  );
}
