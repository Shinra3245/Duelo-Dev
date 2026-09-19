import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRealtimeServer } from '../src/server.js';
import type { MatchControlListener } from '../src/queue/control.js';

describe('sincronización de control administrativo', () => {
  let close: (() => void) | undefined;

  afterEach(() => {
    close?.();
    close = undefined;
  });

  it('conecta el suscriptor de control con el cierre del MatchHub', async () => {
    let listener: MatchControlListener | undefined;
    const subscriber = {
      subscribe(next: MatchControlListener) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    };
    const server = createRealtimeServer({ matchControlSubscriber: subscriber });
    close = () => void server.close();
    const closeMatchFromAdmin = vi
      .spyOn(server.matchHub, 'closeMatchFromAdmin')
      .mockResolvedValue(true);

    expect(listener).toBeDefined();
    await listener?.({
      schema_version: 1,
      type: 'match_closed',
      match_id: 'match-1',
      state_version: 4,
      issued_at_ms: Date.now(),
    });

    expect(closeMatchFromAdmin).toHaveBeenCalledWith('match-1', 4);
  });

  it('conecta el aviso de inicio persistido con la orquestación de partida', async () => {
    let listener: MatchControlListener | undefined;
    const matchStore = {
      async getMatch() {
        return { problem_ids: ['problem-1', 'problem-2'] };
      },
    };
    const subscriber = {
      subscribe(next: MatchControlListener) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    };
    const server = createRealtimeServer({
      matchStore: matchStore as never,
      matchControlSubscriber: subscriber,
    });
    close = () => void server.close();
    const startMatch = vi.spyOn(server.matchHub, 'startMatch').mockResolvedValue();

    await listener?.({
      schema_version: 1,
      type: 'match_started',
      match_id: 'match-1',
      state_version: 4,
      issued_at_ms: Date.now(),
    });

    expect(startMatch).toHaveBeenCalledWith('match-1', ['problem-1', 'problem-2']);
  });
});
