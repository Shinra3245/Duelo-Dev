import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type ApiApp } from '../src/app.js';
import { parseCorsOrigins } from '../src/plugins/cors.js';

describe('CORS para clientes web del torneo', () => {
  let app: ApiApp;
  let baseUrl: string;

  beforeAll(async () => {
    app = createApp({
      serviceName: 'cors-test-api',
      corsOptions: {
        allowedOrigins: ['http://192.168.1.20:3000'],
        allowCredentials: true,
      },
      csrfOptions: {
        allowedOrigins: ['http://192.168.1.20:3000'],
      },
    });
    await app.start(0, '127.0.0.1');
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('responde preflight autorizado con credenciales y encabezados permitidos', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/guest`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://192.168.1.20:3000',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,idempotency-key',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://192.168.1.20:3000');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('content-type');
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('incluye encabezados CORS en una petición real desde origen autorizado', async () => {
    const res = await fetch(`${baseUrl}/healthz`, {
      headers: {
        Origin: 'http://192.168.1.20:3000',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://192.168.1.20:3000');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('rechaza preflight de un origen no autorizado sin exponer credenciales', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/guest`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://192.168.1.99:3000',
        'Access-Control-Request-Method': 'POST',
      },
    });

    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('parsea CORS_ORIGINS como lista separada por comas', () => {
    expect(parseCorsOrigins(' http://a.local:3000,https://b.local ,, ')).toEqual([
      'http://a.local:3000',
      'https://b.local',
    ]);
  });
});
