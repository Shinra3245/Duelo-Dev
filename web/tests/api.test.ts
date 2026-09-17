import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api, ApiClientError } from '../src/lib/api.js';
import { ERROR_CODES } from '@duelodev/shared';

// Mock de fetch global
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('REST API Client', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });
  });

  it('debería configurar correctamente las peticiones (credentials, headers)', async () => {
    await api.auth.me();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, config] = mockFetch.mock.calls[0];

    expect(config.credentials).toBe('include');
    expect(config.headers).toHaveProperty('Content-Type', 'application/json');
  });

  it('debería lanzar ApiClientError en caso de respuesta !ok (error 400)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: { code: 'VALIDATION_FAILED', message: 'Nombre inválido', request_id: '123' },
      }),
    });

    await expect(api.auth.guest('@@@')).rejects.toThrow(ApiClientError);

    try {
      await api.auth.guest('@@@');
    } catch (err: unknown) {
      const error = err as ApiClientError;
      expect(error.status).toBe(400);
      expect(error.data.error?.code).toBe('VALIDATION_FAILED');
      expect(error.message).toBe('Nombre inválido');
    }
  });

  it('debería manejar errores de servidor donde no hay json disponible (fallback)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('Invalid JSON');
      },
    });

    try {
      await api.auth.me();
    } catch (err: unknown) {
      const error = err as ApiClientError;
      expect(error.status).toBe(502);
      expect(error.data.error?.code).toBe(ERROR_CODES.INTERNAL);
      expect(error.message).toBe('Error desconocido del servidor');
    }
  });

  it('debería enviar la cabecera de idempotencia al crear una sala', async () => {
    await api.rooms.create(
      {
        config: {
          mode: 'puntos',
          max_players: 2,
          num_problems: 1,
          categories: ['facil'],
          time_per_problem_s: 300,
        },
      },
      'my-idempotency-key',
    );

    const [, config] = mockFetch.mock.calls[0];
    expect(config.headers).toHaveProperty('Idempotency-Key', 'my-idempotency-key');
  });

  it('debería parsear un 204 No Content correctamente', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error('Should not be called');
      },
    });

    const result = await api.auth.logout();
    expect(result).toEqual({});
  });
});
