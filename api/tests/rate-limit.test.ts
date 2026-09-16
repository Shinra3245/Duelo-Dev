import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ERROR_CODES, type ApiError } from '@duelodev/shared';
import { RateLimiter, defaultKeyGenerator } from '../src/plugins/rate-limit.js';
import { HttpError } from '../src/plugins/body-parser.js';
import { createApp } from '../src/app.js';

describe('RateLimiter Plugin', () => {
  it('permite solicitudes dentro del límite y decrementa el remaining', () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 3 });
    const now = Date.now();

    const r1 = limiter.consume('ip-1', 3, 1000, now);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);
    expect(r1.resetAfterSeconds).toBeGreaterThan(0);

    const r2 = limiter.consume('ip-1', 3, 1000, now + 10);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = limiter.consume('ip-1', 3, 1000, now + 20);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    const r4 = limiter.consume('ip-1', 3, 1000, now + 30);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.resetAfterSeconds).toBeGreaterThan(0);
  });

  it('restablece la cuota una vez expirada la ventana de tiempo', () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 2 });
    const t0 = 100000;

    expect(limiter.consume('user-a', 2, 1000, t0).allowed).toBe(true);
    expect(limiter.consume('user-a', 2, 1000, t0 + 100).allowed).toBe(true);
    expect(limiter.consume('user-a', 2, 1000, t0 + 200).allowed).toBe(false);

    // Después de que expire la primera solicitud (t0 + 1001), se libera 1 cupo
    const afterFirst = t0 + 1001;
    const rAfterFirst = limiter.consume('user-a', 2, 1000, afterFirst);
    expect(rAfterFirst.allowed).toBe(true);
    expect(rAfterFirst.remaining).toBe(0);

    // Después de que expiren todas las solicitudes (t0 + 2500)
    const afterAll = t0 + 2500;
    const rAfterAll = limiter.consume('user-a', 2, 1000, afterAll);
    expect(rAfterAll.allowed).toBe(true);
    expect(rAfterAll.remaining).toBe(1);
  });

  it('limpia todos los registros con clear()', () => {
    const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 1 });
    expect(limiter.consume('ip-test').allowed).toBe(true);
    expect(limiter.consume('ip-test').allowed).toBe(false);

    limiter.clear();
    expect(limiter.consume('ip-test').allowed).toBe(true);
  });

  it('check() establece Retry-After y lanza HttpError 429 si excede el límite', () => {
    const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 1 });
    const headers: Record<string, string> = {};
    const mockReq = {
      headers: {},
      socket: { remoteAddress: '192.168.1.50' },
    } as unknown as IncomingMessage;
    const mockRes = {
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = value;
      },
    } as unknown as ServerResponse;

    limiter.check(mockReq, mockRes, 'action', 1);

    expect(() => {
      limiter.check(mockReq, mockRes, 'action', 1);
    }).toThrowError(HttpError);

    try {
      limiter.check(mockReq, mockRes, 'action', 1);
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const httpErr = err as HttpError;
      expect(httpErr.statusCode).toBe(429);
      expect(httpErr.code).toBe(ERROR_CODES.RATE_LIMITED);
      expect(headers['retry-after']).toBeDefined();
    }
  });

  it('defaultKeyGenerator extrae IP de x-forwarded-for o remoteAddress', () => {
    const reqForwarded = {
      headers: { 'x-forwarded-for': '203.0.113.195, 70.41.3.18' },
      socket: {},
    } as unknown as IncomingMessage;
    expect(defaultKeyGenerator(reqForwarded)).toBe('203.0.113.195');

    const reqForwardedArray = {
      headers: { 'x-forwarded-for': ['198.51.100.22', '10.0.0.1'] },
      socket: {},
    } as unknown as IncomingMessage;
    expect(defaultKeyGenerator(reqForwardedArray)).toBe('198.51.100.22');

    const reqSocket = {
      headers: {},
      socket: { remoteAddress: '10.0.0.99' },
    } as unknown as IncomingMessage;
    expect(defaultKeyGenerator(reqSocket)).toBe('10.0.0.99');

    const reqFallback = {
      headers: {},
      socket: {},
    } as unknown as IncomingMessage;
    expect(defaultKeyGenerator(reqFallback)).toBe('127.0.0.1');
  });
});

describe('Rate Limiting en rutas de autenticación', () => {
  it('bloquea POST /api/v1/auth/register al exceder registerLimit con 429 y Retry-After', async () => {
    const app = createApp({
      serviceName: 'api-rate-limit-test',
      authSecret: 'test-rate-limit-secret-1234567890',
      rateLimitConfig: {
        registerLimit: 2,
        windowMs: 60000,
        enabled: true,
      },
    });

    await app.start(0, '127.0.0.1');
    const addr = app.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // Intento 1: permitido (201)
      const res1 = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'user1@example.com',
          password: 'Password123!',
          gamertag: 'user1',
        }),
      });
      expect(res1.status).toBe(201);

      // Intento 2: permitido (201)
      const res2 = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'user2@example.com',
          password: 'Password123!',
          gamertag: 'user2',
        }),
      });
      expect(res2.status).toBe(201);

      // Intento 3: excede el límite (429)
      const res3 = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'user3@example.com',
          password: 'Password123!',
          gamertag: 'user3',
        }),
      });
      expect(res3.status).toBe(429);
      expect(res3.headers.get('retry-after')).toBeTruthy();

      const body3 = (await res3.json()) as ApiError;
      expect(body3.error.code).toBe(ERROR_CODES.RATE_LIMITED);
      expect(body3.error.message).toContain('Demasiadas solicitudes');
      expect(body3.error.details?.['retry_after_s']).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('bloquea POST /api/v1/auth/login al exceder loginLimit con 429', async () => {
    const app = createApp({
      serviceName: 'api-rate-limit-login-test',
      authSecret: 'test-rate-limit-secret-1234567890',
      rateLimitConfig: {
        loginLimit: 2,
        windowMs: 60000,
        enabled: true,
      },
    });

    await app.start(0, '127.0.0.1');
    const addr = app.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // Creamos un usuario primero
      await app.ctx.authService.register({
        email: 'target@example.com',
        password: 'Password123!',
        gamertag: 'targetuser',
      });

      // Intento 1: permitido (login fallido por credenciales, pero rate limiter permite)
      const res1 = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'target@example.com', password: 'WrongPassword1!' }),
      });
      expect(res1.status).toBe(401);

      // Intento 2: permitido
      const res2 = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'target@example.com', password: 'WrongPassword1!' }),
      });
      expect(res2.status).toBe(401);

      // Intento 3: excede el límite
      const res3 = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'target@example.com', password: 'Password123!' }),
      });
      expect(res3.status).toBe(429);
      expect(res3.headers.get('retry-after')).toBeTruthy();
      const body3 = (await res3.json()) as ApiError;
      expect(body3.error.code).toBe(ERROR_CODES.RATE_LIMITED);
    } finally {
      await app.close();
    }
  });

  it('no limita cuando rateLimitConfig.enabled es false', async () => {
    const app = createApp({
      serviceName: 'api-rate-limit-disabled-test',
      authSecret: 'test-rate-limit-secret-1234567890',
      rateLimitConfig: {
        registerLimit: 1,
        enabled: false,
      },
    });

    await app.start(0, '127.0.0.1');
    const addr = app.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: `disuser${i}@example.com`,
            password: 'Password123!',
            gamertag: `disuser${i}`,
          }),
        });
        expect(res.status).toBe(201);
      }
    } finally {
      await app.close();
    }
  });
});
