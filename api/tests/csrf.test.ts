import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { validateCsrfOrigin } from '../src/plugins/csrf.js';
import { HttpError } from '../src/plugins/body-parser.js';
import { createApp, type ApiApp } from '../src/app.js';

describe('CSRF and Origin Protection Plugin (doc 04 §2)', () => {
  describe('validateCsrfOrigin (lógica pura)', () => {
    function createMockRequest(options: {
      method: string;
      headers?: Record<string, string>;
    }): IncomingMessage {
      return {
        method: options.method,
        headers: options.headers ?? {},
      } as unknown as IncomingMessage;
    }

    it('ignora métodos seguros (GET, HEAD, OPTIONS) sin importar el origen', () => {
      const getReq = createMockRequest({
        method: 'GET',
        headers: { origin: 'https://evil-attacker.com' },
      });
      expect(() => validateCsrfOrigin(getReq)).not.toThrow();

      const headReq = createMockRequest({
        method: 'HEAD',
        headers: { origin: 'https://evil-attacker.com' },
      });
      expect(() => validateCsrfOrigin(headReq)).not.toThrow();
    });

    it('permite solicitudes sin Origin ni Referer por defecto (clientes CLI/curl/tests)', () => {
      const postReq = createMockRequest({ method: 'POST' });
      expect(() => validateCsrfOrigin(postReq)).not.toThrow();
    });

    it('rechaza solicitudes sin Origin si requireOrigin es true', () => {
      const postReq = createMockRequest({ method: 'POST' });
      expect(() => validateCsrfOrigin(postReq, { requireOrigin: true })).toThrow(HttpError);
    });

    it('permite solicitudes originadas en localhost o 127.0.0.1', () => {
      const localReq1 = createMockRequest({
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
      });
      expect(() => validateCsrfOrigin(localReq1)).not.toThrow();

      const localReq2 = createMockRequest({
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:5173' },
      });
      expect(() => validateCsrfOrigin(localReq2)).not.toThrow();
    });

    it('permite solicitudes originadas en la lista de orígenes permitidos', () => {
      const customReq = createMockRequest({
        method: 'POST',
        headers: { origin: 'https://app.duelodev.com' },
      });
      expect(() =>
        validateCsrfOrigin(customReq, { allowedOrigins: ['https://app.duelodev.com'] }),
      ).not.toThrow();
    });

    it('permite solicitudes cuyo Origin coincide con el Host', () => {
      const sameHostReq = createMockRequest({
        method: 'POST',
        headers: {
          host: 'api.duelodev.com',
          origin: 'https://api.duelodev.com',
        },
      });
      expect(() => validateCsrfOrigin(sameHostReq)).not.toThrow();
    });

    it('rechaza con 403 orígenes cruzados no autorizados', () => {
      const attackReq = createMockRequest({
        method: 'POST',
        headers: {
          host: 'api.duelodev.com',
          origin: 'https://malicious-site.evil',
        },
      });

      expect(() => validateCsrfOrigin(attackReq)).toThrow(HttpError);
      try {
        validateCsrfOrigin(attackReq);
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(403);
      }
    });

    it('evalúa el Referer cuando Origin está ausente', () => {
      const refererReq = createMockRequest({
        method: 'POST',
        headers: {
          referer: 'http://localhost:3000/lobby',
        },
      });
      expect(() => validateCsrfOrigin(refererReq)).not.toThrow();

      const evilRefererReq = createMockRequest({
        method: 'POST',
        headers: {
          referer: 'https://malicious-site.evil/attack',
        },
      });
      expect(() => validateCsrfOrigin(evilRefererReq)).toThrow(HttpError);
    });
  });

  describe('Integración HTTP con createApp', () => {
    let app: ApiApp;
    let baseUrl: string;

    beforeAll(async () => {
      app = createApp({
        serviceName: 'csrf-test-api',
        csrfOptions: {
          allowedOrigins: ['https://trusted-site.com'],
        },
      });
      await app.start(0, '127.0.0.1');
      const addr = app.server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterAll(async () => {
      await app.close();
    });

    it('bloquea peticiones POST con Origin malicioso devolviendo 403 y cuerpo ApiError', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: 'https://malicious-phishing.com',
        },
        body: JSON.stringify({
          email: 'user@test.com',
          password: 'Password123!',
        }),
      });

      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: { code: string; message: string } };
      expect(data.error.code).toBe('FORBIDDEN');
      expect(data.error.message).toContain('no autorizado');
    });

    it('permite peticiones POST con Origin autorizado en allowedOrigins', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: 'https://trusted-site.com',
        },
        body: JSON.stringify({
          email: 'notfound@test.com',
          password: 'Password123!',
        }),
      });

      // No es bloqueado por CSRF (falla con 401 por credenciales de usuario inexistente)
      expect(res.status).toBe(401);
    });
  });
});
