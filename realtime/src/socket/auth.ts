/**
 * Autenticación de handshake WebSocket para los namespaces `/match` y `/yjs`.
 *
 * Extrae y valida el token de acceso de la solicitud de handshake,
 * ya sea de la cabecera `Authorization: Bearer <token>`, del query
 * string `?token=<token>` o de la cookie `duelodev_access`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Resultado exitoso de autenticación de handshake. */
export interface AuthResult {
  userId: string;
  gamertag: string;
  role: string;
}

/** Cookie parser mínimo para extraer el token de acceso. */
export function parseCookie(cookieHeader: string, name: string): string | undefined {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match && match[1] !== undefined ? decodeURIComponent(match[1]) : undefined;
}

/**
 * Valida un token JWT con firma HMAC-SHA256 frente a `authSecret`.
 */
export function verifyAccessToken(token: string, secret: string): AuthResult | null {
  if (!token || typeof token !== 'string' || !secret || typeof secret !== 'string') {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64 || !signatureB64) {
    return null;
  }

  try {
    const expectedSignature = createHmac('sha256', secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');

    const sigBuf = Buffer.from(signatureB64, 'utf8');
    const expBuf = Buffer.from(expectedSignature, 'utf8');

    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    const rawPayload = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const parsed = JSON.parse(rawPayload) as unknown;

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const payload = parsed as Record<string, unknown>;
    if (typeof payload.userId !== 'string' || typeof payload.gamertag !== 'string') {
      return null;
    }

    if (typeof payload.exp === 'number') {
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp <= now) {
        return null;
      }
    }

    return {
      userId: payload.userId,
      gamertag: payload.gamertag,
      role: typeof payload.role === 'string' ? payload.role : 'user',
    };
  } catch {
    return null;
  }
}

/**
 * Valida el token del handshake WebSocket.
 *
 * Soporta firmas:
 * 1. (authHeader, authToken, cookieHeader, tokenVerifier)
 * 2. (authHeader, cookieHeader, authSecret, queryToken?)
 * 3. (tokenOrBearer, cookieHeader, authSecret)
 */
export function authenticateSocketHandshake(
  arg1: string | undefined,
  arg2: string | undefined,
  arg3?: string | ((token: string) => AuthResult | null) | undefined,
  arg4?: string | ((token: string) => AuthResult | null) | undefined,
): AuthResult | null {
  let authHeader: string | undefined;
  let authToken: string | undefined;
  let cookieHeader: string | undefined;
  let verifier: ((token: string) => AuthResult | null) | undefined;

  if (typeof arg4 === 'function') {
    // (authHeader, authToken, cookieHeader, verifier)
    authHeader = arg1;
    authToken = arg2;
    cookieHeader = typeof arg3 === 'string' ? arg3 : undefined;
    verifier = arg4;
  } else if (typeof arg3 === 'function') {
    // (authHeader, authToken, verifier)
    authHeader = arg1;
    authToken = arg2;
    verifier = arg3;
  } else if (typeof arg3 === 'string') {
    // (authHeader, cookieHeader, authSecret, authToken?)
    authHeader = arg1;
    cookieHeader = arg2;
    const secret = arg3;
    authToken = typeof arg4 === 'string' ? arg4 : undefined;
    verifier = (tok: string) => verifyAccessToken(tok, secret);
  } else {
    return null;
  }

  // 1. Bearer token
  let token: string | undefined;
  if (typeof authHeader === 'string') {
    if (authHeader.startsWith('Bearer ')) {
      const extracted = authHeader.slice(7).trim();
      if (extracted.length > 0) {
        token = extracted;
      }
    } else if (!authHeader.includes(' ') && authHeader.trim().length > 0) {
      token = authHeader.trim();
    }
  }

  // 2. Auth token del handshake query
  if (!token && typeof authToken === 'string' && authToken.trim().length > 0) {
    token = authToken.trim();
  }

  // 3. Cookie duelodev_access
  if (!token && typeof cookieHeader === 'string' && cookieHeader.length > 0) {
    const fromCookie = parseCookie(cookieHeader, 'duelodev_access');
    if (fromCookie && fromCookie.trim().length > 0) {
      token = fromCookie.trim();
    }
  }

  if (!token) {
    return null;
  }

  return verifier(token);
}
