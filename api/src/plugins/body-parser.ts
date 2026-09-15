import type { IncomingMessage } from 'node:http';
import {
  ERROR_CODES,
  SOURCE_CODE_MAX_BYTES,
  type ApiError,
  type ErrorCode,
} from '@duelodev/shared';

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    if (details) this.details = details;
  }

  toApiError(requestId: string): ApiError {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
        request_id: requestId,
      },
    };
  }
}

/** Límite por defecto para cuerpos JSON regulares (68 KiB: código 64 KiB + margen JSON). */
export const DEFAULT_BODY_MAX_BYTES = SOURCE_CODE_MAX_BYTES + 4 * 1024;

/**
 * Lee y parsea de forma segura el cuerpo JSON de una solicitud HTTP,
 * aplicando límite estricto de bytes para mitigar agotamiento de memoria.
 */
export async function parseJsonBody(
  req: IncomingMessage,
  maxBytes = DEFAULT_BODY_MAX_BYTES,
): Promise<unknown> {
  const contentType = req.headers['content-type'];

  // Si no hay Content-Type ni Content-Length y el método es GET o HEAD, no se espera cuerpo
  if (req.method === 'GET' || req.method === 'HEAD') {
    return undefined;
  }

  if (contentType !== undefined) {
    const mimeType = contentType.split(';')[0]?.trim().toLowerCase();
    if (mimeType !== 'application/json') {
      throw new HttpError(
        415,
        ERROR_CODES.VALIDATION_FAILED,
        `Tipo de contenido no soportado: '${contentType}'. Se requiere 'application/json'.`,
        { content_type: contentType },
      );
    }
  }

  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const chunks: Buffer[] = [];

    function onData(chunk: Buffer): void {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        cleanup();
        req.destroy();
        reject(
          new HttpError(
            413,
            ERROR_CODES.SOURCE_TOO_LARGE,
            `El cuerpo de la solicitud supera el límite máximo permitido de ${maxBytes} bytes.`,
            { max_bytes: maxBytes, received_bytes: totalBytes },
          ),
        );
        return;
      }
      chunks.push(chunk);
    }

    function onEnd(): void {
      cleanup();
      if (chunks.length === 0 || totalBytes === 0) {
        resolve(undefined);
        return;
      }

      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = JSON.parse(raw) as unknown;
        resolve(parsed);
      } catch (err) {
        reject(
          new HttpError(
            400,
            ERROR_CODES.VALIDATION_FAILED,
            'El cuerpo de la solicitud no es un JSON válido.',
            { parse_error: err instanceof Error ? err.message : String(err) },
          ),
        );
      }
    }

    function onError(err: Error): void {
      cleanup();
      reject(
        new HttpError(
          400,
          ERROR_CODES.VALIDATION_FAILED,
          `Error al leer la solicitud: ${err.message}`,
        ),
      );
    }

    function cleanup(): void {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}
