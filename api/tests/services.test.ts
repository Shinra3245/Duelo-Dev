import { describe, expect, it } from 'vitest';
import {
  createAccessToken,
  generateFamilyId,
  generateSecureToken,
  hashPassword,
  hashToken,
  verifyAccessToken,
  verifyPassword,
} from '../src/services/index.js';

describe('API Security Services', () => {
  describe('Password Hashing & Verification (scrypt)', () => {
    it('genera un hash con formato <salt>:<key> y verifica la contraseña correctamente', async () => {
      const password = 'mySecurePassword123!';
      const hash = await hashPassword(password);

      expect(typeof hash).toBe('string');
      expect(hash).toContain(':');

      const [salt, key] = hash.split(':');
      expect(salt).toHaveLength(32); // 16 bytes hex = 32 chars
      expect(key).toHaveLength(128); // 64 bytes hex = 128 chars

      // Verificación positiva
      const isValid = await verifyPassword(password, hash);
      expect(isValid).toBe(true);
    });

    it('genera salts aleatorios únicos para la misma contraseña', async () => {
      const password = 'identicalPassword';
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);

      expect(hash1).not.toBe(hash2);
      expect(await verifyPassword(password, hash1)).toBe(true);
      expect(await verifyPassword(password, hash2)).toBe(true);
    });

    it('rechaza contraseñas incorrectas', async () => {
      const hash = await hashPassword('correctPassword');
      const isValid = await verifyPassword('wrongPassword', hash);
      expect(isValid).toBe(false);
    });

    it('maneja hashes corruptos o malformados de forma segura sin excepciones', async () => {
      const malformedHashes = [
        '',
        'nosaltorkey',
        'salt:nothex!',
        ':empty',
        'empty:',
        'short:short',
      ];

      for (const badHash of malformedHashes) {
        const result = await verifyPassword('password', badHash);
        expect(result).toBe(false);
      }
    });

    it('lanza error al intentar hashear una contraseña vacía', async () => {
      await expect(hashPassword('')).rejects.toThrow();
    });
  });

  describe('Tokens & Id Generation', () => {
    it('genera tokens seguros en base64url con entropía configurable', () => {
      const token1 = generateSecureToken();
      const token2 = generateSecureToken();

      expect(typeof token1).toBe('string');
      expect(token1.length).toBeGreaterThanOrEqual(32);
      expect(token1).not.toBe(token2);

      // Token de 64 bytes
      const tokenLong = generateSecureToken(64);
      expect(tokenLong.length).toBeGreaterThan(token1.length);
    });

    it('rechaza generar tokens con menos de 16 bytes de entropía', () => {
      expect(() => generateSecureToken(8)).toThrow();
    });

    it('genera hashes SHA-256 deterministas para tokens', () => {
      const token = 'sample-refresh-token-value';
      const hash1 = hashToken(token);
      const hash2 = hashToken(token);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex = 64 chars
      expect(/^[0-9a-f]{64}$/.test(hash1)).toBe(true);

      // Vector conocido: SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
      expect(() => hashToken('')).toThrow();
    });

    it('genera UUIDs válidos para family_id', () => {
      const family1 = generateFamilyId();
      const family2 = generateFamilyId();

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(uuidRegex.test(family1)).toBe(true);
      expect(uuidRegex.test(family2)).toBe(true);
      expect(family1).not.toBe(family2);
    });

    it('crea y verifica tokens de acceso válidos con firma HMAC-SHA256', () => {
      const secret = 'super-secret-key-1234';
      const token = createAccessToken(
        { userId: 'user-uuid-1', role: 'user', gamertag: 'coder-pro' },
        secret,
        300,
      );

      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);

      const verified = verifyAccessToken(token, secret);
      expect(verified).not.toBeNull();
      expect(verified?.userId).toBe('user-uuid-1');
      expect(verified?.role).toBe('user');
      expect(verified?.gamertag).toBe('coder-pro');
      expect(verified?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('rechaza access tokens con firma manipulada o clave incorrecta', () => {
      const secret1 = 'secret-1';
      const secret2 = 'secret-2';
      const token = createAccessToken(
        { userId: 'user-uuid-2', role: 'guest', gamertag: 'guest-123' },
        secret1,
        300,
      );

      // Verificación con otra clave debe fallar
      expect(verifyAccessToken(token, secret2)).toBeNull();

      // Manipulación del payload
      const [header, , sig] = token.split('.');
      const tamperedPayload = Buffer.from(
        JSON.stringify({ userId: 'hacker', role: 'user', exp: 9999999999 }),
      ).toString('base64url');
      const tamperedToken = `${header}.${tamperedPayload}.${sig}`;

      expect(verifyAccessToken(tamperedToken, secret1)).toBeNull();
    });

    it('rechaza access tokens expirados', () => {
      const secret = 'expiration-test-secret';
      // Token expirado (vigencia negativa de -10 segundos)
      const expiredToken = createAccessToken(
        { userId: 'user-expired', role: 'user', gamertag: 'ghost' },
        secret,
        -10,
      );

      expect(verifyAccessToken(expiredToken, secret)).toBeNull();
    });

    it('rechaza tokens malformados de forma segura', () => {
      const secret = 'malformed-secret';
      expect(verifyAccessToken('', secret)).toBeNull();
      expect(verifyAccessToken('part1.part2', secret)).toBeNull();
      expect(verifyAccessToken('part1.part2.part3.part4', secret)).toBeNull();
      expect(verifyAccessToken('invalid.invalid.invalid', secret)).toBeNull();
    });
  });
});
