import type { IncomingMessage, ServerResponse } from 'node:http';

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  path?: string;
  maxAge?: number;
}

export const AUTH_COOKIE_NAMES = {
  ACCESS_TOKEN: 'access_token',
  REFRESH_TOKEN: 'refresh_token',
} as const;

/** Duración del refresh token en segundos (7 días). */
export const REFRESH_TOKEN_MAX_AGE_S = 7 * 24 * 60 * 60;
/** Duración del access token en segundos (15 minutos). */
export const ACCESS_TOKEN_MAX_AGE_S = 15 * 60;

/**
 * Parsea el encabezado `Cookie` de una solicitud HTTP en un diccionario clave-valor.
 */
export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return {};
  }

  const cookies: Record<string, string> = {};
  const pairs = cookieHeader.split(';');

  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key.length > 0) {
      cookies[key] = decodeURIComponent(val);
    }
  }

  return cookies;
}

/**
 * Obtiene las cookies desde una solicitud HTTP.
 */
export function getRequestCookies(req: IncomingMessage): Record<string, string> {
  return parseCookies(req.headers.cookie);
}

/**
 * Serializa una cookie en formato Set-Cookie.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts: string[] = [`${name}=${encodeURIComponent(value)}`];

  const path = options.path ?? '/';
  parts.push(`Path=${path}`);

  if (options.httpOnly ?? true) {
    parts.push('HttpOnly');
  }

  if (options.sameSite !== undefined) {
    parts.push(`SameSite=${options.sameSite}`);
  } else {
    parts.push('SameSite=Lax');
  }

  if (options.secure) {
    parts.push('Secure');
  }

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  return parts.join('; ');
}

/**
 * Añade una o varias cabeceras Set-Cookie a la respuesta HTTP preservando las existentes.
 */
export function appendSetCookie(res: ServerResponse, cookieStr: string): void {
  const existing = res.getHeader('set-cookie');
  if (!existing) {
    res.setHeader('set-cookie', [cookieStr]);
  } else if (Array.isArray(existing)) {
    res.setHeader('set-cookie', [...existing, cookieStr]);
  } else {
    res.setHeader('set-cookie', [String(existing), cookieStr]);
  }
}

/**
 * Establece las cookies de autenticación (access_token y refresh_token) en la respuesta HTTP.
 */
export function setAuthCookies(
  res: ServerResponse,
  tokens: { accessToken?: string; refreshToken?: string },
  secure = process.env['NODE_ENV'] === 'production',
): void {
  if (tokens.refreshToken) {
    const refreshCookie = serializeCookie(AUTH_COOKIE_NAMES.REFRESH_TOKEN, tokens.refreshToken, {
      httpOnly: true,
      secure,
      sameSite: secure ? 'Strict' : 'Lax',
      path: '/api/v1/auth',
      maxAge: REFRESH_TOKEN_MAX_AGE_S,
    });
    appendSetCookie(res, refreshCookie);
  }

  if (tokens.accessToken) {
    const accessCookie = serializeCookie(AUTH_COOKIE_NAMES.ACCESS_TOKEN, tokens.accessToken, {
      httpOnly: true,
      secure,
      sameSite: secure ? 'Strict' : 'Lax',
      path: '/',
      maxAge: ACCESS_TOKEN_MAX_AGE_S,
    });
    appendSetCookie(res, accessCookie);
  }
}

/**
 * Limpia las cookies de autenticación expirándolas inmediatamente.
 */
export function clearAuthCookies(
  res: ServerResponse,
  secure = process.env['NODE_ENV'] === 'production',
): void {
  const clearRefresh = serializeCookie(AUTH_COOKIE_NAMES.REFRESH_TOKEN, '', {
    httpOnly: true,
    secure,
    sameSite: secure ? 'Strict' : 'Lax',
    path: '/api/v1/auth',
    maxAge: 0,
  });
  const clearAccess = serializeCookie(AUTH_COOKIE_NAMES.ACCESS_TOKEN, '', {
    httpOnly: true,
    secure,
    sameSite: secure ? 'Strict' : 'Lax',
    path: '/',
    maxAge: 0,
  });

  appendSetCookie(res, clearRefresh);
  appendSetCookie(res, clearAccess);
}
