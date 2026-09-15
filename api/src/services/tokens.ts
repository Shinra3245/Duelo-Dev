import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { UserRole } from '@duelodev/shared';
import { ACCESS_TOKEN_MAX_AGE_S } from '../plugins/cookies.js';

export interface AccessTokenPayload {
  userId: string;
  role: UserRole;
  gamertag: string;
  exp: number;
  iat: number;
}

/**
 * Genera un token criptográficamente seguro en formato base64url.
 * Por defecto genera 32 bytes de entropía (256 bits).
 */
export function generateSecureToken(bytes = 32): string {
  if (bytes < 16) {
    throw new Error('El token debe tener al menos 16 bytes de entropía.');
  }
  return randomBytes(bytes).toString('base64url');
}

/**
 * Calcula el hash SHA-256 de un token para almacenamiento seguro en la base de datos (doc 04 §1).
 * Nunca se almacena el token en texto claro.
 */
export function hashToken(token: string): string {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('El token a hashear debe ser una cadena no vacía.');
  }
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Genera un nuevo identificador familiar para rotación de refresh tokens (doc 04 §1).
 */
export function generateFamilyId(): string {
  return randomUUID();
}

const JWT_HEADER_B64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
  'base64url',
);

/**
 * Crea un token de acceso firmado con HMAC-SHA256 (formato estándar JWT compacto).
 */
export function createAccessToken(
  payload: { userId: string; role: UserRole; gamertag: string },
  secret: string,
  expiresInSeconds: number = ACCESS_TOKEN_MAX_AGE_S,
): string {
  if (!secret || typeof secret !== 'string') {
    throw new Error('Se requiere una clave secreta para firmar el token de acceso.');
  }

  const now = Math.floor(Date.now() / 1000);
  const tokenPayload: AccessTokenPayload = {
    userId: payload.userId,
    role: payload.role,
    gamertag: payload.gamertag,
    iat: now,
    exp: now + expiresInSeconds,
  };

  const payloadB64 = Buffer.from(JSON.stringify(tokenPayload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`${JWT_HEADER_B64}.${payloadB64}`)
    .digest('base64url');

  return `${JWT_HEADER_B64}.${payloadB64}.${signature}`;
}

/**
 * Verifica la firma y vigencia de un access token firmado.
 * Devuelve el payload decodificado si es válido, o `null` si la firma o el formato son incorrectos o ha expirado.
 */
export function verifyAccessToken(token: string, secret: string): AccessTokenPayload | null {
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

  const expectedSignature = createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  const sigBuf = Buffer.from(signatureB64, 'utf8');
  const expBuf = Buffer.from(expectedSignature, 'utf8');

  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const rawPayload = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const parsed = JSON.parse(rawPayload) as unknown;

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const payload = parsed as AccessTokenPayload;
    if (
      typeof payload.userId !== 'string' ||
      typeof payload.role !== 'string' ||
      typeof payload.gamertag !== 'string' ||
      typeof payload.exp !== 'number'
    ) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
