import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const SALT_BYTES = 16;
const KEY_BYTES = 64;

/**
 * Genera un hash seguro para contraseñas usando scrypt con salt aleatorio criptográfico.
 * Formato resultante: `<salt_hex>:<derived_key_hex>`.
 */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('La contraseña a hashear debe ser una cadena no vacía.');
  }

  const salt = randomBytes(SALT_BYTES).toString('hex');
  const derivedKey = (await scryptAsync(password, salt, KEY_BYTES)) as Buffer;
  return `${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Verifica una contraseña en texto claro contra su hash scrypt usando comparación en tiempo constante.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (
    typeof password !== 'string' ||
    typeof storedHash !== 'string' ||
    password.length === 0 ||
    storedHash.length === 0
  ) {
    return false;
  }

  const parts = storedHash.split(':');
  if (parts.length !== 2) {
    return false;
  }

  const [saltHex, keyHex] = parts;
  if (!saltHex || !keyHex) {
    return false;
  }

  try {
    const keyBuffer = Buffer.from(keyHex, 'hex');
    if (keyBuffer.length === 0) {
      return false;
    }

    const derivedKey = (await scryptAsync(password, saltHex, keyBuffer.length)) as Buffer;

    if (keyBuffer.length !== derivedKey.length) {
      return false;
    }

    return timingSafeEqual(keyBuffer, derivedKey);
  } catch {
    return false;
  }
}
