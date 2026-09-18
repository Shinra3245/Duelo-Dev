import { describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import {
  AUTH_COOKIE_NAMES,
  clearAuthCookies,
  isSecureRequest,
  parseCookies,
  serializeCookie,
  setAuthCookies,
} from '../src/plugins/cookies.js';

describe('Cookies Plugin', () => {
  describe('parseCookies', () => {
    it('devuelve objeto vacío ante valores nulos, undefined o vacíos', () => {
      expect(parseCookies(undefined)).toEqual({});
      expect(parseCookies('')).toEqual({});
      expect(parseCookies(null as unknown as string)).toEqual({});
    });

    it('parsea múltiples cookies separadas por punto y coma', () => {
      const header = 'theme=dark; session_id=abc-123; user=alice%20smith';
      const parsed = parseCookies(header);
      expect(parsed).toEqual({
        theme: 'dark',
        session_id: 'abc-123',
        user: 'alice smith',
      });
    });

    it('ignora fragmentos sin signo igual o claves vacías', () => {
      const header = '; ; foo=bar; invalid; =empty-key; baz=qux;';
      const parsed = parseCookies(header);
      expect(parsed).toEqual({
        foo: 'bar',
        baz: 'qux',
      });
    });
  });

  describe('serializeCookie', () => {
    it('aplica opciones por defecto seguras (HttpOnly, SameSite=Lax, Path=/)', () => {
      const cookie = serializeCookie('token', 'xyz123');
      expect(cookie).toBe('token=xyz123; Path=/; HttpOnly; SameSite=Lax');
    });

    it('incluye Secure y Max-Age cuando se especifican', () => {
      const cookie = serializeCookie('auth', 'val', {
        secure: true,
        maxAge: 3600,
        path: '/api',
        sameSite: 'Strict',
        httpOnly: false,
      });
      expect(cookie).toBe('auth=val; Path=/api; SameSite=Strict; Secure; Max-Age=3600');
    });

    it('codifica valores de cookie adecuadamente con URI encoding', () => {
      const cookie = serializeCookie('name', 'user @ example / test');
      expect(cookie).toContain('name=user%20%40%20example%20%2F%20test');
    });
  });

  describe('isSecureRequest', () => {
    it('no marca como segura una cookie en HTTP LAN aunque production esté activo', () => {
      const request = {
        headers: {},
        socket: { encrypted: false },
      };

      expect(isSecureRequest(request as never)).toBe(false);
    });

    it('detecta HTTPS directo y HTTPS indicado por un proxy confiable', () => {
      const directRequest = {
        headers: {},
        socket: { encrypted: true },
      };
      const proxiedRequest = {
        headers: { 'x-forwarded-proto': 'https, http' },
        socket: { encrypted: false },
      };

      expect(isSecureRequest(directRequest as never)).toBe(true);
      expect(isSecureRequest(proxiedRequest as never)).toBe(true);
    });
  });

  describe('setAuthCookies y clearAuthCookies', () => {
    it('agrega encabezados Set-Cookie para access_token y refresh_token', () => {
      const headers: Record<string, string | string[]> = {};
      const mockRes = {
        getHeader: (name: string) => headers[name.toLowerCase()],
        setHeader: (name: string, value: string | string[]) => {
          headers[name.toLowerCase()] = value;
        },
      };

      setAuthCookies(
        mockRes as unknown as ServerResponse,
        {
          accessToken: 'jwt-access',
          refreshToken: 'sec-refresh',
        },
        false,
      );

      const setCookie = headers['set-cookie'];
      expect(Array.isArray(setCookie)).toBe(true);
      const cookiesArr = setCookie as string[];
      expect(cookiesArr).toHaveLength(2);

      const refreshStr = cookiesArr.find((c) =>
        c.startsWith(`${AUTH_COOKIE_NAMES.REFRESH_TOKEN}=`),
      );
      const accessStr = cookiesArr.find((c) => c.startsWith(`${AUTH_COOKIE_NAMES.ACCESS_TOKEN}=`));

      expect(refreshStr).toBeDefined();
      expect(refreshStr).toContain('Path=/api/v1/auth');
      expect(refreshStr).toContain('HttpOnly');

      expect(accessStr).toBeDefined();
      expect(accessStr).toContain('Path=/');
      expect(accessStr).toContain('HttpOnly');
    });

    it('limpia las cookies estableciendo Max-Age=0', () => {
      const headers: Record<string, string | string[]> = {};
      const mockRes = {
        getHeader: (name: string) => headers[name.toLowerCase()],
        setHeader: (name: string, value: string | string[]) => {
          headers[name.toLowerCase()] = value;
        },
      };

      clearAuthCookies(mockRes as unknown as ServerResponse, false);

      const setCookie = headers['set-cookie'];
      expect(Array.isArray(setCookie)).toBe(true);
      const cookiesArr = setCookie as string[];
      expect(cookiesArr).toHaveLength(2);

      for (const cookie of cookiesArr) {
        expect(cookie).toContain('Max-Age=0');
      }
    });
  });
});
