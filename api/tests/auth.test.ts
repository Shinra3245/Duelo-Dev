import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  ERROR_CODES,
  type ApiError,
  type AuthUserResponse,
  type LogoutResponse,
} from '@duelodev/shared';
import { createApp, type ApiApp } from '../src/app.js';
import { AUTH_COOKIE_NAMES } from '../src/plugins/cookies.js';

describe('Auth REST API (/api/v1/auth & /api/v1/users)', () => {
  let app: ApiApp;
  let baseUrl: string;

  beforeAll(async () => {
    app = createApp({
      serviceName: 'api-auth-test',
      authSecret: 'test-secret-duelodev-xyz-1234567890',
    });
    // Escuchar en un puerto efímero asignado por el SO
    await app.start(0, '127.0.0.1');
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  function extractCookies(res: Response): Record<string, string> {
    const rawCookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie') ?? ''];

    const result: Record<string, string> = {};
    for (const str of rawCookies) {
      if (!str) continue;
      const firstPart = str.split(';')[0];
      if (firstPart) {
        const idx = firstPart.indexOf('=');
        if (idx > 0) {
          const key = firstPart.slice(0, idx).trim();
          const val = firstPart.slice(idx + 1).trim();
          result[key] = decodeURIComponent(val);
        }
      }
    }
    return result;
  }

  describe('POST /api/v1/auth/register', () => {
    it('registra un usuario nuevo exitosamente y emite cookies de sesión', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@example.com',
          password: 'Password123!',
          gamertag: 'alice-coder',
        }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as AuthUserResponse;
      expect(data.user).toBeDefined();
      expect(data.user.email).toBe('alice@example.com');
      expect(data.user.gamertag).toBe('alice-coder');
      expect(data.user.role).toBe('user');
      expect(typeof data.user.id).toBe('string');
      expect(typeof data.user.created_at).toBe('string');

      // Comprobar cookies Set-Cookie
      const cookies = extractCookies(res);
      expect(cookies[AUTH_COOKIE_NAMES.ACCESS_TOKEN]).toBeDefined();
      expect(cookies[AUTH_COOKIE_NAMES.REFRESH_TOKEN]).toBeDefined();
    });

    it('rechaza registro con correo duplicado devolviendo 409 EMAIL_TAKEN', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'ALICE@EXAMPLE.COM', // Normalización case-insensitive
          password: 'AnotherPassword123!',
          gamertag: 'alice-coder-2',
        }),
      });

      expect(res.status).toBe(409);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.EMAIL_TAKEN);
    });

    it('rechaza registro con gamertag duplicado devolviendo 409 GAMERTAG_TAKEN', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'bob@example.com',
          password: 'Password123!',
          gamertag: 'alice-coder', // Mismo gamertag
        }),
      });

      expect(res.status).toBe(409);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.GAMERTAG_TAKEN);
    });

    it('rechaza datos de registro inválidos devolviendo 400 VALIDATION_FAILED', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'not-an-email',
          password: 'short',
          gamertag: 'ab', // Demasiado corto (mínimo 3)
        }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });

    it('responde 405 Method Not Allowed ante métodos distintos a POST', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'GET',
      });

      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    });
  });

  describe('POST /api/v1/auth/login', () => {
    it('inicia sesión con credenciales válidas y emite cookies', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@example.com',
          password: 'Password123!',
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as AuthUserResponse;
      expect(data.user.email).toBe('alice@example.com');
      expect(data.user.gamertag).toBe('alice-coder');

      const cookies = extractCookies(res);
      expect(cookies[AUTH_COOKIE_NAMES.ACCESS_TOKEN]).toBeDefined();
      expect(cookies[AUTH_COOKIE_NAMES.REFRESH_TOKEN]).toBeDefined();
    });

    it('inicia sesión con correo escrito en mayúsculas (insensible a mayúsculas)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'ALICE@EXAMPLE.COM',
          password: 'Password123!',
        }),
      });

      expect(res.status).toBe(200);
    });

    it('rechaza contraseña errónea con 401 INVALID_CREDENTIALS', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@example.com',
          password: 'WrongPassword999!',
        }),
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
    });

    it('rechaza usuario no existente con 401 INVALID_CREDENTIALS', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'nonexistent@example.com',
          password: 'Password123!',
        }),
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
    });
  });

  describe('POST /api/v1/auth/guest', () => {
    it('crea una sesión invitada, responde perfil y emite cookies', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/guest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gamertag: 'guest-login-1' }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as AuthUserResponse;
      expect(data.user.gamertag).toBe('guest-login-1');
      expect(data.user.role).toBe('guest');
      expect(data.user.email).toBeNull();
      expect(typeof data.user.id).toBe('string');

      const cookies = extractCookies(res);
      expect(cookies[AUTH_COOKIE_NAMES.ACCESS_TOKEN]).toBeDefined();
      expect(cookies[AUTH_COOKIE_NAMES.REFRESH_TOKEN]).toBeDefined();
    });

    it('rechaza gamertag inválido con 400 VALIDATION_FAILED', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/guest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gamertag: 'ab' }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });

    it('responde 405 Method Not Allowed ante métodos distintos a POST', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/guest`, {
        method: 'GET',
      });

      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    });
  });

  describe('POST /api/v1/auth/refresh y Detección de Reuso', () => {
    it('rota el token exitosamente con una cookie refresh válida', async () => {
      // 1. Iniciar sesión para obtener un refresh token fresco
      const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@example.com',
          password: 'Password123!',
        }),
      });
      const loginCookies = extractCookies(loginRes);
      const initialRefreshToken = loginCookies[AUTH_COOKIE_NAMES.REFRESH_TOKEN];
      expect(initialRefreshToken).toBeDefined();

      // 2. Ejecutar refresh enviando la cookie
      const refreshRes = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          Cookie: `${AUTH_COOKIE_NAMES.REFRESH_TOKEN}=${initialRefreshToken}`,
        },
      });

      expect(refreshRes.status).toBe(200);
      const data = (await refreshRes.json()) as AuthUserResponse;
      expect(data.user.email).toBe('alice@example.com');

      const rotatedCookies = extractCookies(refreshRes);
      const newRefreshToken = rotatedCookies[AUTH_COOKIE_NAMES.REFRESH_TOKEN];
      expect(newRefreshToken).toBeDefined();
      expect(newRefreshToken).not.toBe(initialRefreshToken);

      // 3. DETECCIÓN DE REUSO: Si alguien intenta reutilizar el token anterior,
      // debe invalidar toda la familia y responder 401 REFRESH_REUSED (doc 04 §2)
      const reuseRes = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          Cookie: `${AUTH_COOKIE_NAMES.REFRESH_TOKEN}=${initialRefreshToken}`,
        },
      });

      expect(reuseRes.status).toBe(401);
      const reuseData = (await reuseRes.json()) as ApiError;
      expect(reuseData.error.code).toBe(ERROR_CODES.REFRESH_REUSED);

      // 4. Tras la detección de reuso, el nuevo token de la misma familia también queda invalidado
      const invalidFamilyRes = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          Cookie: `${AUTH_COOKIE_NAMES.REFRESH_TOKEN}=${newRefreshToken}`,
        },
      });
      expect(invalidFamilyRes.status).toBe(401);
    });

    it('rechaza refresh sin token con 401 UNAUTHENTICATED', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.UNAUTHENTICATED);
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('retorna el perfil autenticado usando la cookie access_token', async () => {
      const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@example.com',
          password: 'Password123!',
        }),
      });
      const cookies = extractCookies(loginRes);
      const accessToken = cookies[AUTH_COOKIE_NAMES.ACCESS_TOKEN];
      expect(accessToken).toBeDefined();

      const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: {
          Cookie: `${AUTH_COOKIE_NAMES.ACCESS_TOKEN}=${accessToken}`,
        },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as AuthUserResponse;
      expect(data.user.email).toBe('alice@example.com');
      expect(data.user.gamertag).toBe('alice-coder');
      expect(data.user.role).toBe('user');
    });

    it('rechaza consulta sin access token con 401 UNAUTHENTICATED', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/me`);

      expect(res.status).toBe(401);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.UNAUTHENTICATED);
    });

    it('responde 405 Method Not Allowed ante métodos distintos a GET', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
        method: 'POST',
      });

      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET');
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('revoca la sesión, limpia las cookies y responde 200 ok', async () => {
      // 1. Iniciar sesión
      const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@example.com',
          password: 'Password123!',
        }),
      });
      const cookies = extractCookies(loginRes);
      const refreshToken = cookies[AUTH_COOKIE_NAMES.REFRESH_TOKEN];

      // 2. Logout
      const logoutRes = await fetch(`${baseUrl}/api/v1/auth/logout`, {
        method: 'POST',
        headers: {
          Cookie: `${AUTH_COOKIE_NAMES.REFRESH_TOKEN}=${refreshToken}`,
        },
      });

      expect(logoutRes.status).toBe(200);
      const data = (await logoutRes.json()) as LogoutResponse;
      expect(data.ok).toBe(true);

      const rawSetCookie = logoutRes.headers.get('set-cookie') ?? '';
      expect(rawSetCookie).toContain('Max-Age=0');

      // 3. Comprobar que el refresh token revocado ya no funciona
      const refreshRes = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          Cookie: `${AUTH_COOKIE_NAMES.REFRESH_TOKEN}=${refreshToken}`,
        },
      });
      expect(refreshRes.status).toBe(401);
    });
  });

  describe('POST /api/v1/users/convert', () => {
    it('convierte un invitado a usuario registrado conservando su ID', async () => {
      // 1. Crear usuario invitado en el servicio
      const guestResult = await app.ctx.authService.createGuest('guest-player-1');
      expect(guestResult.user.role).toBe('guest');
      const guestId = guestResult.user.id;

      // 2. Convertir el invitado a usuario registrado
      const convertRes = await fetch(`${baseUrl}/api/v1/users/convert`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: `${AUTH_COOKIE_NAMES.ACCESS_TOKEN}=${guestResult.accessToken}`,
        },
        body: JSON.stringify({
          email: 'converted@example.com',
          password: 'SecurePassword456!',
        }),
      });

      expect(convertRes.status).toBe(200);
      const data = (await convertRes.json()) as AuthUserResponse;
      expect(data.user.id).toBe(guestId); // Conserva el UUID original (doc 04 §1)
      expect(data.user.role).toBe('user');
      expect(data.user.email).toBe('converted@example.com');
      expect(data.user.gamertag).toBe('guest-player-1');

      // 3. El usuario convertido ahora puede iniciar sesión con su nueva contraseña
      const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'converted@example.com',
          password: 'SecurePassword456!',
        }),
      });
      expect(loginRes.status).toBe(200);
    });

    it('rechaza convertir sin access token válido con 401 UNAUTHENTICATED', async () => {
      const res = await fetch(`${baseUrl}/api/v1/users/convert`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'Password123!',
        }),
      });

      expect(res.status).toBe(401);
    });

    it('rechaza convertir si el usuario ya tiene rol user con 409 CONFLICT', async () => {
      // Obtener sesión de alice (usuario registrado)
      const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@example.com',
          password: 'Password123!',
        }),
      });
      const cookies = extractCookies(loginRes);
      const accessToken = cookies[AUTH_COOKIE_NAMES.ACCESS_TOKEN];

      const res = await fetch(`${baseUrl}/api/v1/users/convert`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          email: 'alice-new@example.com',
          password: 'Password123!',
        }),
      });

      expect(res.status).toBe(409);
      const data = (await res.json()) as ApiError;
      expect(data.error.code).toBe(ERROR_CODES.CONFLICT);
    });
  });
});
