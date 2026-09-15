import { createHash, randomBytes, randomUUID } from 'node:crypto';

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
