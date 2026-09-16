import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RealtimeServer } from '../src/server.js';
import { createRealtimeServer } from '../src/server.js';
import { InMemoryMatchStore } from '../src/store/memory.js';
import type { ApiError, HealthResponse, ReadyResponse } from '@duelodev/shared';
import { ERROR_CODES } from '@duelodev/shared';
import type { RealtimeMatchSession } from '../src/types.js';

function createDummySession(
  id: string,
  status: RealtimeMatchSession['status'],
): RealtimeMatchSession {
  return {
    match_id: id,
    room_code: 'ROOMX1',
    mode: 'puntos',
    config: {
      mode: 'puntos',
      num_problems: 1,
      categories: ['facil'],
      max_players: 2,
      time_per_problem_s: 60,
    },
    status,
    round_status: 'open',
    current_round_id: 'r-1',
    current_round_idx: 0,
    state_version: 1,
    players: new Map(),
    scores: [],
    created_at: new Date().toISOString(),
  };
}

describe('Realtime Health & Readiness Service', () => {
  let server: RealtimeServer;
  let matchStore: InMemoryMatchStore;
  let baseUrl: string;

  beforeAll(async () => {
    matchStore = new InMemoryMatchStore();
    server = createRealtimeServer({
      serviceName: 'realtime',
      version: '0.1.0',
      matchStore,
    });
    const { port } = await server.start(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.close();
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
      expect(data.service).toBe('realtime');
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

    it('rechaza métodos no permitidos con 405 y formato ApiError', async () => {
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
    it('responde 200 OK por defecto e incluye métricas operativas dinámicas', async () => {
      const res = await fetch(`${baseUrl}/readyz`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as ReadyResponse;
      expect(data.status).toBe('ready');
      expect(data.service).toBe('realtime');
      expect(data.checks).toEqual([]);
      expect(data.metrics).toBeDefined();
      expect(data.metrics?.['active_matches']).toBe(0);
      expect(typeof data.metrics?.['uptime_s']).toBe('number');
    });

    it('refleja partidas activas dinámicamente en las métricas de /readyz', async () => {
      await matchStore.saveMatch(createDummySession('match-active-1', 'running'));
      await matchStore.saveMatch(createDummySession('match-active-2', 'settling'));
      await matchStore.saveMatch(createDummySession('match-done', 'finished'));

      const res = await fetch(`${baseUrl}/readyz`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as ReadyResponse;
      expect(data.metrics?.['active_matches']).toBe(2);

      // Limpiar para siguientes pruebas
      matchStore.clear();
    });

    it('responde 200 OK cuando todas las sondas de preparación son exitosas', async () => {
      const customServer = createRealtimeServer({
        serviceName: 'realtime',
        readinessProbes: [
          { name: 'redis', check: async () => {} },
          { name: 'postgres', check: async () => {} },
        ],
      });
      const { port } = await customServer.start(0, '127.0.0.1');

      try {
        const res = await fetch(`http://127.0.0.1:${port}/readyz`);
        expect(res.status).toBe(200);

        const data = (await res.json()) as ReadyResponse;
        expect(data.status).toBe('ready');
        expect(data.checks).toHaveLength(2);
        for (const check of data.checks) {
          expect(check.ok).toBe(true);
          expect(typeof check.latency_ms).toBe('number');
        }
      } finally {
        await customServer.close();
      }
    });

    it('responde 503 Service Unavailable si alguna sonda falla', async () => {
      const degradedServer = createRealtimeServer({
        serviceName: 'realtime',
        readinessProbes: [
          { name: 'redis', check: async () => {} },
          {
            name: 'database',
            check: async () => {
              throw new Error('Connection refused');
            },
          },
        ],
      });
      const { port } = await degradedServer.start(0, '127.0.0.1');

      try {
        const res = await fetch(`http://127.0.0.1:${port}/readyz`);
        expect(res.status).toBe(503);

        const data = (await res.json()) as ReadyResponse;
        expect(data.status).toBe('degraded');
        expect(data.checks).toHaveLength(2);

        const okCheck = data.checks.find((c) => c.name === 'redis');
        expect(okCheck?.ok).toBe(true);

        const failedCheck = data.checks.find((c) => c.name === 'database');
        expect(failedCheck?.ok).toBe(false);
        expect(failedCheck?.error).toBe('Connection refused');
      } finally {
        await degradedServer.close();
      }
    });

    it('soporta solicitudes HEAD /readyz sin cuerpo', async () => {
      const res = await fetch(`${baseUrl}/readyz`, { method: 'HEAD' });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const text = await res.text();
      expect(text).toBe('');
    });

    it('rechaza métodos no permitidos en /readyz con 405 y formato ApiError', async () => {
      const res = await fetch(`${baseUrl}/readyz`, { method: 'POST' });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');

      const err = (await res.json()) as ApiError;
      expect(err.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });
  });

  describe('Enrutamiento y cabeceras de seguridad', () => {
    it('responde 404 con ApiError ante rutas no encontradas', async () => {
      const res = await fetch(`${baseUrl}/unknown-path`, {
        headers: { 'x-request-id': 'custom-404-id' },
      });
      expect(res.status).toBe(404);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-request-id')).toBe('custom-404-id');

      const err = (await res.json()) as ApiError;
      expect(err.error.code).toBe(ERROR_CODES.NOT_FOUND);
      expect(err.error.request_id).toBe('custom-404-id');
      expect(err.error.details).toEqual({ pathname: '/unknown-path' });
    });

    it('soporta HEAD en rutas 404 sin devolver cuerpo', async () => {
      const res = await fetch(`${baseUrl}/unknown-path`, { method: 'HEAD' });
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toBe('');
    });

    it('preserva el encabezado x-request-id enviado por el cliente', async () => {
      const customReqId = 'custom-uuid-1234-5678';
      const res = await fetch(`${baseUrl}/healthz`, {
        headers: { 'x-request-id': customReqId },
      });
      expect(res.headers.get('x-request-id')).toBe(customReqId);
    });
  });
});
