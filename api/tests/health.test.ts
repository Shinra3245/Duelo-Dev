import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiApp } from '../src/app.js';
import { createApp } from '../src/app.js';
import type { ApiError, HealthResponse, ReadyResponse } from '@duelodev/shared';
import { ERROR_CODES, ERROR_MESSAGES } from '@duelodev/shared';

describe('API Health & Readiness Service', () => {
  let app: ApiApp;
  let baseUrl: string;

  beforeAll(async () => {
    // Puerto 0 asigna un puerto libre del sistema operativo
    app = createApp({
      serviceName: 'api',
      version: '0.1.0',
    });
    const { port } = await app.start(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /healthz (Liveness)', () => {
    it('responde 200 OK con contrato HealthResponse', async () => {
      const res = await fetch(`${baseUrl}/healthz`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-request-id')).toBeTruthy();

      const data = (await res.json()) as HealthResponse;
      expect(data.status).toBe('ok');
      expect(data.service).toBe('api');
      expect(typeof data.uptime_s).toBe('number');
      expect(data.uptime_s).toBeGreaterThanOrEqual(0);
      expect(data.version).toBe('0.1.0');
    });

    it('soporta solicitudes HEAD /healthz sin cuerpo', async () => {
      const res = await fetch(`${baseUrl}/healthz`, { method: 'HEAD' });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const text = await res.text();
      expect(text).toBe('');
    });

    it('rechaza métodos HTTP no permitidos con 405 y formato ApiError', async () => {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const res = await fetch(`${baseUrl}/healthz`, {
          method,
          headers: { 'x-request-id': 'req-test-405-health' },
        });
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('GET, HEAD');

        const err = (await res.json()) as ApiError;
        expect(err.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
        expect(err.error.message).toBe('Método HTTP no permitido.');
        expect(err.error.request_id).toBe('req-test-405-health');
        expect(err.error.details).toEqual({
          method,
          allowed: ['GET', 'HEAD'],
        });
      }
    });
  });

  describe('GET /readyz (Readiness)', () => {
    it('responde 200 OK cuando no hay sondas configuradas (default ready)', async () => {
      const res = await fetch(`${baseUrl}/readyz`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as ReadyResponse;
      expect(data.status).toBe('ready');
      expect(data.service).toBe('api');
      expect(data.checks).toEqual([]);
    });

    it('responde 200 OK cuando todas las sondas son exitosas', async () => {
      const readyApp = createApp({
        serviceName: 'api',
        probes: {
          postgres: async () => {},
          redis: async () => {},
        },
      });
      const { port } = await readyApp.start(0, '127.0.0.1');
      try {
        const res = await fetch(`http://127.0.0.1:${port}/readyz`);
        expect(res.status).toBe(200);

        const data = (await res.json()) as ReadyResponse;
        expect(data.status).toBe('ready');
        expect(data.checks).toHaveLength(2);
        for (const check of data.checks) {
          expect(check.ok).toBe(true);
          expect(typeof check.latency_ms).toBe('number');
          expect(check.latency_ms).toBeGreaterThanOrEqual(0);
          expect(check.error).toBeUndefined();
        }
      } finally {
        await readyApp.close();
      }
    });

    it('responde 503 degraded cuando alguna sonda falla', async () => {
      const degradedApp = createApp({
        serviceName: 'api',
        probes: {
          postgres: async () => {},
          redis: async () => {
            throw new Error('ECONNREFUSED 127.0.0.1:6379');
          },
        },
      });
      const { port } = await degradedApp.start(0, '127.0.0.1');
      try {
        const res = await fetch(`http://127.0.0.1:${port}/readyz`);
        expect(res.status).toBe(503);

        const data = (await res.json()) as ReadyResponse;
        expect(data.status).toBe('degraded');
        expect(data.checks).toHaveLength(2);

        const pgCheck = data.checks.find((c) => c.name === 'postgres');
        expect(pgCheck?.ok).toBe(true);

        const redisCheck = data.checks.find((c) => c.name === 'redis');
        expect(redisCheck?.ok).toBe(false);
        expect(redisCheck?.error).toBe('ECONNREFUSED 127.0.0.1:6379');
        expect(typeof redisCheck?.latency_ms).toBe('number');
      } finally {
        await degradedApp.close();
      }
    });

    it('soporta HEAD /readyz devolviendo 200 o 503 sin cuerpo', async () => {
      const res = await fetch(`${baseUrl}/readyz`, { method: 'HEAD' });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe('');
    });

    it('incluye métricas operativas si están configuradas', async () => {
      const metricsApp = createApp({
        serviceName: 'api',
        metrics: {
          active_connections: 5,
        },
      });
      const { port } = await metricsApp.start(0, '127.0.0.1');
      try {
        const res = await fetch(`http://127.0.0.1:${port}/readyz`);
        expect(res.status).toBe(200);

        const data = (await res.json()) as ReadyResponse;
        expect(data.metrics).toEqual({ active_connections: 5 });
      } finally {
        await metricsApp.close();
      }
    });

    it('incluye métricas dinámicas si se pasa una función proveedora', async () => {
      let count = 10;
      const metricsApp = createApp({
        serviceName: 'api',
        metrics: () => ({ requests_processed: count++ }),
      });
      const { port } = await metricsApp.start(0, '127.0.0.1');
      try {
        const res1 = await fetch(`http://127.0.0.1:${port}/readyz`);
        const data1 = (await res1.json()) as ReadyResponse;
        expect(data1.metrics).toEqual({ requests_processed: 10 });

        const res2 = await fetch(`http://127.0.0.1:${port}/readyz`);
        const data2 = (await res2.json()) as ReadyResponse;
        expect(data2.metrics).toEqual({ requests_processed: 11 });
      } finally {
        await metricsApp.close();
      }
    });

    it('rechaza métodos HTTP no permitidos con 405 y formato ApiError', async () => {
      const res = await fetch(`${baseUrl}/readyz`, {
        method: 'POST',
        headers: { 'x-request-id': 'req-test-405-ready' },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');

      const err = (await res.json()) as ApiError;
      expect(err.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(err.error.message).toBe('Método HTTP no permitido.');
      expect(err.error.request_id).toBe('req-test-405-ready');
    });
  });

  describe('Enrutamiento y manejo de errores 404', () => {
    it('responde 404 con contrato ApiError ante rutas desconocidas', async () => {
      const res = await fetch(`${baseUrl}/ruta-inexistente`, {
        headers: { 'x-request-id': 'custom-req-id-404' },
      });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('x-request-id')).toBe('custom-req-id-404');

      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.NOT_FOUND);
      expect(data.error.message).toBe(ERROR_MESSAGES.NOT_FOUND);
      expect(data.error.request_id).toBe('custom-req-id-404');
    });

    it('genera un UUID para x-request-id si el cliente no lo envía', async () => {
      const res = await fetch(`${baseUrl}/ruta-inexistente`);
      const reqId = res.headers.get('x-request-id');
      expect(reqId).toBeTruthy();

      const data = (await res.json()) as ApiError;
      expect(data.error.request_id).toBe(reqId);
    });
  });
});
