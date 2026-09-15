import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { extractIdempotencyKey, HttpError, parseJsonBody } from '../src/plugins/index.js';
import { ERROR_CODES, IDEMPOTENCY_KEY_HEADER } from '@duelodev/shared';

function createMockRequest(
  chunks: string[] | Buffer[],
  headers: Record<string, string | string[] | undefined> = {},
  method = 'POST',
): IncomingMessage {
  const stream = Readable.from(chunks.map((c) => (typeof c === 'string' ? Buffer.from(c) : c)));
  const req = Object.assign(stream, {
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    method,
  }) as unknown as IncomingMessage;
  return req;
}

describe('API Plugins: Body Parser & Idempotency', () => {
  describe('parseJsonBody', () => {
    it('parsea correctamente un cuerpo JSON válido', async () => {
      const payload = { key: 'value', count: 42 };
      const req = createMockRequest([JSON.stringify(payload)]);
      const result = await parseJsonBody(req);
      expect(result).toEqual(payload);
    });

    it('devuelve undefined para solicitudes GET o HEAD sin cuerpo', async () => {
      const req = createMockRequest([], {}, 'GET');
      const result = await parseJsonBody(req);
      expect(result).toBeUndefined();
    });

    it('rechaza con HttpError 400 cuando el JSON está mal formado', async () => {
      const req = createMockRequest(['{ invalid json']);
      await expect(parseJsonBody(req)).rejects.toThrowError(HttpError);
      try {
        await parseJsonBody(createMockRequest(['{ invalid json']));
      } catch (err) {
        expect(err instanceof HttpError).toBe(true);
        if (err instanceof HttpError) {
          expect(err.statusCode).toBe(400);
          expect(err.code).toBe(ERROR_CODES.VALIDATION_FAILED);
        }
      }
    });

    it('rechaza con HttpError 415 si el content-type no es application/json', async () => {
      const req = createMockRequest(['data'], {
        'content-type': 'text/plain',
      });
      await expect(parseJsonBody(req)).rejects.toThrowError(HttpError);
      try {
        await parseJsonBody(req);
      } catch (err) {
        if (err instanceof HttpError) {
          expect(err.statusCode).toBe(415);
        }
      }
    });

    it('acepta content-type application/json con directiva charset', async () => {
      const req = createMockRequest([JSON.stringify({ ok: true })], {
        'content-type': 'application/json; charset=utf-8',
      });
      const result = await parseJsonBody(req);
      expect(result).toEqual({ ok: true });
    });

    it('rechaza con HttpError 413 si el cuerpo excede el límite de bytes', async () => {
      const maxBytes = 50;
      const largePayload = JSON.stringify({ long_text: 'a'.repeat(100) });
      const req = createMockRequest([largePayload]);

      await expect(parseJsonBody(req, maxBytes)).rejects.toThrowError(HttpError);
      try {
        await parseJsonBody(createMockRequest([largePayload]), maxBytes);
      } catch (err) {
        if (err instanceof HttpError) {
          expect(err.statusCode).toBe(413);
          expect(err.code).toBe(ERROR_CODES.SOURCE_TOO_LARGE);
        }
      }
    });
  });

  describe('extractIdempotencyKey', () => {
    it('devuelve null si el encabezado no está presente', () => {
      const req = createMockRequest([]);
      expect(extractIdempotencyKey(req)).toBeNull();
    });

    it('extrae y limpia una clave de idempotencia válida', () => {
      const req = createMockRequest([], {
        [IDEMPOTENCY_KEY_HEADER]: '  idemp-key-1234_test.A:B  ',
      });
      expect(extractIdempotencyKey(req)).toBe('idemp-key-1234_test.A:B');
    });

    it('rechaza claves vacías o con solo espacios', () => {
      const req = createMockRequest([], {
        [IDEMPOTENCY_KEY_HEADER]: '   ',
      });
      expect(() => extractIdempotencyKey(req)).toThrowError(HttpError);
    });

    it('rechaza claves que exceden 128 caracteres', () => {
      const req = createMockRequest([], {
        [IDEMPOTENCY_KEY_HEADER]: 'k'.repeat(129),
      });
      expect(() => extractIdempotencyKey(req)).toThrowError(HttpError);
    });

    it('rechaza múltiples encabezados repetidos (arrays)', () => {
      const req = createMockRequest([], {
        [IDEMPOTENCY_KEY_HEADER]: ['key1', 'key2'],
      });
      expect(() => extractIdempotencyKey(req)).toThrowError(HttpError);
    });

    it('rechaza caracteres no permitidos en la clave', () => {
      const req = createMockRequest([], {
        [IDEMPOTENCY_KEY_HEADER]: 'key with spaces and @!',
      });
      expect(() => extractIdempotencyKey(req)).toThrowError(HttpError);
    });
  });

  describe('HttpError.toApiError', () => {
    it('convierte la excepción en una estructura ApiError compatible', () => {
      const err = new HttpError(400, ERROR_CODES.VALIDATION_FAILED, 'Error de prueba', {
        field: 'test',
      });
      const apiErr = err.toApiError('req-test-123');
      expect(apiErr.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(apiErr.error.message).toBe('Error de prueba');
      expect(apiErr.error.details).toEqual({ field: 'test' });
      expect(apiErr.error.request_id).toBe('req-test-123');
    });
  });
});
