import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ERROR_CODES } from '@duelodev/shared';
import { api } from '../src/lib/api.js';

const mockFetch = vi.fn<typeof fetch>();
global.fetch = mockFetch;

describe('REST API Client', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    } as Response);
  });

  it('configura credentials y headers JSON por defecto', async () => {
    await api.auth.me();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, config] = mockFetch.mock.calls[0]!;

    expect(config?.credentials).toBe('include');
    expect(config?.headers).toHaveProperty('Content-Type', 'application/json');
  });

  it('lanza ApiClientError cuando el servidor responde con error JSON', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: { code: 'VALIDATION_FAILED', message: 'Nombre inválido', request_id: '123' },
      }),
    } as Response);

    await expect(api.auth.guest('@@@')).rejects.toMatchObject({
      name: 'ApiClientError',
      status: 400,
      message: 'Nombre inválido',
      data: {
        error: { code: 'VALIDATION_FAILED' },
      },
    });
  });

  it('usa un error fallback si el servidor no devuelve JSON válido', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('Invalid JSON');
      },
    } as unknown as Response);

    await expect(api.auth.me()).rejects.toMatchObject({
      status: 502,
      message: 'Error desconocido del servidor',
      data: {
        error: { code: ERROR_CODES.INTERNAL },
      },
    });
  });

  it('envía la cabecera de idempotencia al crear una sala', async () => {
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

    const [, config] = mockFetch.mock.calls[0]!;
    expect(config?.headers).toHaveProperty('Idempotency-Key', 'my-idempotency-key');
  });

  it('usa los endpoints administrativos para cerrar una o todas las salas', async () => {
    await api.admin.closeRoom('match-123');
    await api.admin.closeAllRooms();

    expect(mockFetch.mock.calls[0]?.[0]).toContain('/admin/rooms/match-123/close');
    expect(mockFetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(mockFetch.mock.calls[1]?.[0]).toContain('/admin/rooms/close-all');
    expect(mockFetch.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
  });

  it('parsea 204 No Content sin llamar response.json', async () => {
    const json = vi.fn();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json,
    } as unknown as Response);

    const result = await api.auth.logout();
    expect(result).toEqual({});
    expect(json).not.toHaveBeenCalled();
  });
});
