import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { ReadyResponse } from '@duelodev/shared';
import { createPostgresProbe, createRedisProbe } from '../src/infrastructure/probes.js';
import { createApp } from '../src/app.js';

describe('Infrastructure Probes', () => {
  describe('createPostgresProbe', () => {
    it('retorna estado ready con latencia si el ping es exitoso', async () => {
      const probe = createPostgresProbe(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });

      const res = await probe();
      expect(res).toBeDefined();
      if (res) {
        expect(res.name).toBe('postgres');
        expect(res.status).toBe('ready');
        expect(res.latency_ms).toBeGreaterThanOrEqual(0);
        expect(res.message).toBeUndefined();
      }
    });

    it('retorna estado degraded y mensaje de error si el ping falla', async () => {
      const probe = createPostgresProbe(async () => {
        throw new Error('Connection refused to postgresql://localhost:5432');
      });

      const res = await probe();
      expect(res).toBeDefined();
      if (res) {
        expect(res.name).toBe('postgres');
        expect(res.status).toBe('degraded');
        expect(res.latency_ms).toBeGreaterThanOrEqual(0);
        expect(res.message).toContain('Connection refused');
      }
    });

    it('retorna estado degraded si el ping excede timeoutMs', async () => {
      const probe = createPostgresProbe(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
        },
        { timeoutMs: 20 },
      );

      const res = await probe();
      expect(res).toBeDefined();
      if (res) {
        expect(res.name).toBe('postgres');
        expect(res.status).toBe('degraded');
        expect(res.message).toContain('tiempo límite');
      }
    });

    it('respeta opciones personalizadas de nombre', async () => {
      const probe = createPostgresProbe(async () => {}, { name: 'pg-replica-1' });
      const res = await probe();
      expect(res?.name).toBe('pg-replica-1');
    });
  });

  describe('createRedisProbe', () => {
    it('retorna estado ready con nombre redis por defecto', async () => {
      const probe = createRedisProbe(async () => {});
      const res = await probe();
      expect(res).toBeDefined();
      if (res) {
        expect(res.name).toBe('redis');
        expect(res.status).toBe('ready');
      }
    });

    it('retorna estado degraded si el ping de redis falla', async () => {
      const probe = createRedisProbe(async () => {
        throw new Error('REDIS_AUTH_FAILED');
      });
      const res = await probe();
      expect(res).toBeDefined();
      if (res) {
        expect(res.name).toBe('redis');
        expect(res.status).toBe('degraded');
        expect(res.message).toBe('REDIS_AUTH_FAILED');
      }
    });
  });

  describe('Integración con /readyz en createApp', () => {
    it('agrega databasePing y redisPing como sondas en /readyz y responde 200 si ambas pasan', async () => {
      let pgPingCount = 0;
      let redisPingCount = 0;

      const app = createApp({
        serviceName: 'api-probes-test',
        databasePing: async () => {
          pgPingCount++;
        },
        redisPing: async () => {
          redisPingCount++;
        },
      });

      await app.start(0, '127.0.0.1');
      const addr = app.server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      try {
        const res = await fetch(`${baseUrl}/readyz`);
        expect(res.status).toBe(200);

        const data = (await res.json()) as ReadyResponse;
        expect(data.status).toBe('ready');
        expect(data.checks).toHaveLength(2);

        const pgCheck = data.checks.find((c) => c.name === 'postgres');
        expect(pgCheck?.ok).toBe(true);

        const redisCheck = data.checks.find((c) => c.name === 'redis');
        expect(redisCheck?.ok).toBe(true);

        expect(pgPingCount).toBe(1);
        expect(redisPingCount).toBe(1);
      } finally {
        await app.close();
      }
    });

    it('responde 503 degraded si databasePing falla', async () => {
      const app = createApp({
        serviceName: 'api-pg-fail-test',
        databasePing: async () => {
          throw new Error('database offline');
        },
        redisPing: async () => {},
      });

      await app.start(0, '127.0.0.1');
      const addr = app.server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      try {
        const res = await fetch(`${baseUrl}/readyz`);
        expect(res.status).toBe(503);

        const data = (await res.json()) as ReadyResponse;
        expect(data.status).toBe('degraded');

        const pgCheck = data.checks.find((c) => c.name === 'postgres');
        expect(pgCheck?.ok).toBe(false);
        expect(pgCheck?.error).toBe('database offline');

        const redisCheck = data.checks.find((c) => c.name === 'redis');
        expect(redisCheck?.ok).toBe(true);
      } finally {
        await app.close();
      }
    });

    it('responde 503 degraded si redisPing falla', async () => {
      const app = createApp({
        serviceName: 'api-redis-fail-test',
        databasePing: async () => {},
        redisPing: async () => {
          throw new Error('redis cluster unavailable');
        },
      });

      await app.start(0, '127.0.0.1');
      const addr = app.server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      try {
        const res = await fetch(`${baseUrl}/readyz`);
        expect(res.status).toBe(503);

        const data = (await res.json()) as ReadyResponse;
        expect(data.status).toBe('degraded');

        const redisCheck = data.checks.find((c) => c.name === 'redis');
        expect(redisCheck?.ok).toBe(false);
        expect(redisCheck?.error).toBe('redis cluster unavailable');
      } finally {
        await app.close();
      }
    });
  });
});
