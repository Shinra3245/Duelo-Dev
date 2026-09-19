import { describe, expect, it } from 'vitest';
import { authorizeYjsAccess, parseYjsPath } from '../src/yjs/auth.js';

describe('Yjs Auth & Routing', () => {
  describe('parseYjsPath', () => {
    it('extrae matchId y targetUserId de una ruta válida', () => {
      const res = parseYjsPath('/yjs/match-100/user-200');
      expect(res).toEqual({
        matchId: 'match-100',
        targetUserId: 'user-200',
      });
    });

    it('soporta rutas con barra final', () => {
      const res = parseYjsPath('/yjs/m1/u1/');
      expect(res).toEqual({
        matchId: 'm1',
        targetUserId: 'u1',
      });
    });

    it('retorna null ante rutas que no coinciden con el patrón Yjs', () => {
      expect(parseYjsPath('/yjs')).toBeNull();
      expect(parseYjsPath('/yjs/')).toBeNull();
      expect(parseYjsPath('/yjs/only-one-param')).toBeNull();
      expect(parseYjsPath('/yjs/m1/u1/extra')).toBeNull();
      expect(parseYjsPath('/other/m1/u1')).toBeNull();
      expect(parseYjsPath('')).toBeNull();
    });
  });

  describe('authorizeYjsAccess', () => {
    const authOwner = { userId: 'user-1', gamertag: 'coder1', role: 'user' };
    const authRival = { userId: 'user-2', gamertag: 'coder2', role: 'user' };
    const authStranger = { userId: 'stranger', gamertag: 'stranger', role: 'user' };

    it('deniega acceso si el usuario no es miembro de la partida', () => {
      const decision = authorizeYjsAccess({
        auth: authStranger,
        matchId: 'match-1',
        targetUserId: 'user-1',
        isMember: false,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.canRead).toBe(false);
      expect(decision.canWrite).toBe(false);
    });

    it('concede lectura y escritura al dueño del documento', () => {
      const decision = authorizeYjsAccess({
        auth: authOwner,
        matchId: 'match-1',
        targetUserId: 'user-1',
        isMember: true,
      });

      expect(decision.allowed).toBe(true);
      expect(decision.canRead).toBe(true);
      expect(decision.canWrite).toBe(true);
    });

    it('concede lectura a rivales miembros aunque el código se presente desenfocado', () => {
      const decision = authorizeYjsAccess({
        auth: authRival,
        matchId: 'match-1',
        targetUserId: 'user-1',
        isMember: true,
      });

      expect(decision.allowed).toBe(true);
      expect(decision.canRead).toBe(true);
      expect(decision.canWrite).toBe(false);
    });
  });
});
