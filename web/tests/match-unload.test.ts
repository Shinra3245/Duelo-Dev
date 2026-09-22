import { describe, expect, it, vi } from 'vitest';
import { ACTIVE_MATCH_UNLOAD_WARNING, protectActiveMatchUnload } from '../src/lib/match-unload.js';

describe('confirmación al cerrar una partida activa', () => {
  it('solicita al navegador que confirme antes de abandonar la página', () => {
    const event = {
      preventDefault: vi.fn(),
      returnValue: null,
    } as unknown as BeforeUnloadEvent;

    protectActiveMatchUnload(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.returnValue).toBe(ACTIVE_MATCH_UNLOAD_WARNING);
  });
});
