import { describe, expect, it } from 'vitest';
import { authenticateSocketHandshake, type AuthResult } from '../src/socket/auth.js';

describe('authenticateSocketHandshake', () => {
  const dummyVerifier = (token: string): AuthResult | null => {
    if (token === 'valid-token') {
      return {
        userId: 'user-123',
        gamertag: 'coderPro',
        role: 'user',
      };
    }
    if (token === 'admin-token') {
      return {
        userId: 'admin-1',
        gamertag: 'adminMaster',
        role: 'admin',
      };
    }
    return null;
  };

  it('autentica exitosamente mediante cabecera Authorization Bearer', () => {
    const res = authenticateSocketHandshake(
      'Bearer valid-token',
      undefined,
      undefined,
      dummyVerifier,
    );
    expect(res).toEqual({
      userId: 'user-123',
      gamertag: 'coderPro',
      role: 'user',
    });
  });

  it('autentica exitosamente mediante query token si no hay Bearer', () => {
    const res = authenticateSocketHandshake(undefined, 'valid-token', undefined, dummyVerifier);
    expect(res).toEqual({
      userId: 'user-123',
      gamertag: 'coderPro',
      role: 'user',
    });
  });

  it('autentica exitosamente mediante cookie duelodev_access si no hay Bearer ni query', () => {
    const cookieHeader = 'session=xyz; duelodev_access=valid-token; other=123';
    const res = authenticateSocketHandshake(undefined, undefined, cookieHeader, dummyVerifier);
    expect(res).toEqual({
      userId: 'user-123',
      gamertag: 'coderPro',
      role: 'user',
    });
  });

  it('respeta la prioridad: Bearer tiene precedencia sobre query y cookie', () => {
    const res = authenticateSocketHandshake(
      'Bearer valid-token',
      'admin-token',
      'duelodev_access=admin-token',
      dummyVerifier,
    );
    expect(res?.userId).toBe('user-123');
  });

  it('respeta la prioridad: query token tiene precedencia sobre cookie', () => {
    const res = authenticateSocketHandshake(
      undefined,
      'admin-token',
      'duelodev_access=valid-token',
      dummyVerifier,
    );
    expect(res?.userId).toBe('admin-1');
  });

  it('retorna null si el token es rechazado por el verificador (inválido/expirado)', () => {
    const res = authenticateSocketHandshake(
      'Bearer token-invalido',
      undefined,
      undefined,
      dummyVerifier,
    );
    expect(res).toBeNull();
  });

  it('retorna null si no se proporciona ninguna credencial', () => {
    const res = authenticateSocketHandshake(undefined, undefined, undefined, dummyVerifier);
    expect(res).toBeNull();
  });

  it('ignora esquemas de autorización distintos de Bearer', () => {
    const res = authenticateSocketHandshake(
      'Basic dXNlcjpwYXNz',
      undefined,
      undefined,
      dummyVerifier,
    );
    expect(res).toBeNull();
  });

  it('ignora Bearer con token vacío y continúa con fallback', () => {
    const res = authenticateSocketHandshake('Bearer   ', 'valid-token', undefined, dummyVerifier);
    expect(res?.userId).toBe('user-123');
  });
});
