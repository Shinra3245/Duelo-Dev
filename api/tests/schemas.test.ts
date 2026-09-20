import { describe, expect, it } from 'vitest';
import {
  validateConvertGuestRequest,
  validateCreateRoomRequest,
  validateCreateSubmissionRequest,
  validateJoinRoomRequest,
  validateLoginRequest,
  validateRegisterRequest,
  validateRoomCode,
} from '../src/schemas/index.js';
import { SOURCE_CODE_MAX_BYTES } from '@duelodev/shared';

describe('API Runtime Schemas & Validation', () => {
  describe('validateRegisterRequest', () => {
    it('acepta datos de registro válidos y normaliza el correo', () => {
      const result = validateRegisterRequest({
        email: '  User.Test@Example.COM  ',
        password: 'password123',
        gamertag: 'coder-pro-99',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.email).toBe('user.test@example.com');
        expect(result.data.password).toBe('password123');
        expect(result.data.gamertag).toBe('coder-pro-99');
      }
    });

    it('rechaza cuerpo que no es un objeto', () => {
      expect(validateRegisterRequest('string').ok).toBe(false);
      expect(validateRegisterRequest(null).ok).toBe(false);
      expect(validateRegisterRequest([]).ok).toBe(false);
    });

    it('rechaza correos inválidos o vacíos', () => {
      const badEmails = ['', '   ', 'plainaddress', '@missinguser.com', 'user@.com'];
      for (const email of badEmails) {
        const res = validateRegisterRequest({
          email,
          password: 'validpassword',
          gamertag: 'valid-tag',
        });
        expect(res.ok).toBe(false);
      }
    });

    it('rechaza contraseñas demasiado cortas o largas', () => {
      const shortRes = validateRegisterRequest({
        email: 'user@example.com',
        password: '123',
        gamertag: 'valid-tag',
      });
      expect(shortRes.ok).toBe(false);

      const longRes = validateRegisterRequest({
        email: 'user@example.com',
        password: 'a'.repeat(129),
        gamertag: 'valid-tag',
      });
      expect(longRes.ok).toBe(false);
    });

    it('rechaza gamertags fuera de la expresión regular canónica', () => {
      const badTags = ['ab', 'a'.repeat(21), 'user with space', 'user@bad!', 'usuario_bajo'];
      for (const gamertag of badTags) {
        const res = validateRegisterRequest({
          email: 'user@example.com',
          password: 'password123',
          gamertag,
        });
        expect(res.ok).toBe(false);
      }
    });

    it('rechaza propiedades adicionales no permitidas', () => {
      const res = validateRegisterRequest({
        email: 'user@example.com',
        password: 'password123',
        gamertag: 'valid-tag',
        role: 'admin',
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((e) => e.code === 'ADDITIONAL_PROPERTY')).toBe(true);
      }
    });
  });

  describe('validateLoginRequest', () => {
    it('acepta credenciales válidas', () => {
      const result = validateLoginRequest({
        email: 'user@example.com',
        password: 'anypassword',
      });
      expect(result.ok).toBe(true);
    });

    it('rechaza campos faltantes o adicionales', () => {
      expect(validateLoginRequest({ email: 'user@example.com' }).ok).toBe(false);
      expect(
        validateLoginRequest({
          email: 'user@example.com',
          password: 'pwd',
          extra: true,
        }).ok,
      ).toBe(false);
    });
  });

  describe('validateConvertGuestRequest', () => {
    it('acepta solicitud de conversión válida', () => {
      const result = validateConvertGuestRequest({
        email: 'guest.promoted@example.com',
        password: 'newpassword123',
      });
      expect(result.ok).toBe(true);
    });

    it('rechaza contraseñas cortas', () => {
      const result = validateConvertGuestRequest({
        email: 'guest@example.com',
        password: 'short',
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('validateCreateRoomRequest', () => {
    it('acepta configuración válida para modo Puntos', () => {
      const res = validateCreateRoomRequest({
        config: {
          mode: 'puntos',
          max_players: 4,
          num_problems: 3,
          categories: ['facil', 'facil_medio'],
          time_per_problem_s: 300,
        },
      });
      expect(res.ok).toBe(true);
    });

    it('acepta configuración válida para modo Rondas', () => {
      const res = validateCreateRoomRequest({
        config: {
          mode: 'rondas',
          max_players: 3,
          categories: ['facil'],
          match_duration_s: 600,
          num_problems: 10,
          target: 6,
        },
      });
      expect(res.ok).toBe(true);
    });

    it('permite la categoría Senior (Difícil)', () => {
      const res = validateCreateRoomRequest({
        config: {
          mode: 'puntos',
          max_players: 2,
          categories: ['dificil'],
          num_problems: 1,
          time_per_problem_s: 60,
        },
      });

      expect(res.ok).toBe(true);
    });

    it('rechaza la categoría histórica al crear partidas nuevas', () => {
      const res = validateCreateRoomRequest({
        config: {
          mode: 'puntos',
          max_players: 2,
          categories: ['muy_facil'],
          num_problems: 1,
          time_per_problem_s: 60,
        },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((error) => error.code === 'INACTIVE_DIFFICULTY')).toBe(true);
      }
    });

    it('rechaza terminantemente la presencia de award_on_timeout', () => {
      const res = validateCreateRoomRequest({
        config: {
          mode: 'rondas',
          max_players: 2,
          categories: ['facil'],
          match_duration_s: 600,
          num_problems: 5,
          target: 3,
          award_on_timeout: true,
        },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((e) => e.code === 'FORBIDDEN_PROPERTY')).toBe(true);
      }
    });

    it('rechaza Rondas con target no permitido o target > num_problems', () => {
      // target 5 no está en {3, 6, 9, 10}
      const res1 = validateCreateRoomRequest({
        config: {
          mode: 'rondas',
          max_players: 2,
          categories: ['facil'],
          match_duration_s: 600,
          num_problems: 10,
          target: 5,
        },
      });
      expect(res1.ok).toBe(false);

      // target 6 > num_problems 4
      const res2 = validateCreateRoomRequest({
        config: {
          mode: 'rondas',
          max_players: 2,
          categories: ['facil'],
          match_duration_s: 600,
          num_problems: 4,
          target: 6,
        },
      });
      expect(res2.ok).toBe(false);
    });

    it('rechaza max_players < 2', () => {
      const res = validateCreateRoomRequest({
        config: {
          mode: 'puntos',
          max_players: 1,
          num_problems: 5,
          categories: ['facil'],
          time_per_problem_s: 120,
        },
      });
      expect(res.ok).toBe(false);
    });
  });

  describe('validateJoinRoomRequest & validateRoomCode', () => {
    it('acepta gamertag válido en join', () => {
      const res = validateJoinRoomRequest({ gamertag: 'SpeedCoder' });
      expect(res.ok).toBe(true);
    });

    it('rechaza gamertag inválido en join', () => {
      const res = validateJoinRoomRequest({ gamertag: 'x' });
      expect(res.ok).toBe(false);
    });

    it('valida formato de código de sala', () => {
      expect(validateRoomCode('AB12')).toBeNull();
      expect(validateRoomCode('ROOM1234')).toBeNull();
      expect(validateRoomCode('A')?.code).toBe('INVALID_ROOM_CODE');
      expect(validateRoomCode('INVALID-CODE-TOO-LONG')?.code).toBe('INVALID_ROOM_CODE');
    });
  });

  describe('validateCreateSubmissionRequest', () => {
    it('acepta envío válido en python, cpp y java', () => {
      for (const language of ['python', 'cpp', 'java'] as const) {
        const res = validateCreateSubmissionRequest({
          match_id: 'match-123',
          round_id: 'round-456',
          problem_id: 'prob-789',
          language,
          source_code: 'print("hello world")',
        });
        expect(res.ok).toBe(true);
      }
    });

    it('rechaza lenguaje no soportado', () => {
      const res = validateCreateSubmissionRequest({
        match_id: 'match-123',
        round_id: 'round-456',
        problem_id: 'prob-789',
        language: 'rust',
        source_code: 'fn main() {}',
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((e) => e.code === 'UNSUPPORTED_LANGUAGE')).toBe(true);
      }
    });

    it('rechaza código fuente vacío', () => {
      const res = validateCreateSubmissionRequest({
        match_id: 'match-123',
        round_id: 'round-456',
        problem_id: 'prob-789',
        language: 'python',
        source_code: '   \n  \t ',
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((e) => e.code === 'EMPTY_SOURCE_CODE')).toBe(true);
      }
    });

    it('rechaza código fuente que supera 64 KiB en bytes UTF-8', () => {
      const oversizedCode = 'a'.repeat(SOURCE_CODE_MAX_BYTES + 1);
      const res = validateCreateSubmissionRequest({
        match_id: 'match-123',
        round_id: 'round-456',
        problem_id: 'prob-789',
        language: 'python',
        source_code: oversizedCode,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((e) => e.code === 'SOURCE_TOO_LARGE')).toBe(true);
      }
    });

    it('cuenta correctamente caracteres multibyte para el límite de 64 KiB', () => {
      // Cada 'ñ' ocupa 2 bytes UTF-8. 32,769 caracteres 'ñ' = 65,538 bytes (> 64 KiB = 65,536 bytes)
      const multibyteCode = 'ñ'.repeat(32769);
      expect(multibyteCode.length).toBeLessThan(SOURCE_CODE_MAX_BYTES);
      expect(Buffer.byteLength(multibyteCode, 'utf8')).toBeGreaterThan(SOURCE_CODE_MAX_BYTES);

      const res = validateCreateSubmissionRequest({
        match_id: 'match-123',
        round_id: 'round-456',
        problem_id: 'prob-789',
        language: 'python',
        source_code: multibyteCode,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((e) => e.code === 'SOURCE_TOO_LARGE')).toBe(true);
      }
    });

    it('rechaza propiedades faltantes y adicionales', () => {
      const missing = validateCreateSubmissionRequest({
        match_id: 'match-123',
        language: 'python',
        source_code: 'code',
      });
      expect(missing.ok).toBe(false);

      const extra = validateCreateSubmissionRequest({
        match_id: 'match-123',
        round_id: 'round-456',
        problem_id: 'prob-789',
        language: 'python',
        source_code: 'code',
        injected: 'hack',
      });
      expect(extra.ok).toBe(false);
    });
  });
});
