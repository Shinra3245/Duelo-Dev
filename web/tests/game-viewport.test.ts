import { describe, expect, it } from 'vitest';
import { isCompactGameViewport, RECOMMENDED_GAME_VIEWPORT } from '../src/lib/game-viewport.js';

describe('viewport de partida', () => {
  it('acepta la dimensión mínima recomendada', () => {
    expect(
      isCompactGameViewport(
        RECOMMENDED_GAME_VIEWPORT.minWidth,
        RECOMMENDED_GAME_VIEWPORT.minHeight,
      ),
    ).toBe(false);
  });

  it.each([
    [1023, 640],
    [1024, 639],
    [800, 600],
  ])('marca como compacta una ventana de %i x %i', (width, height) => {
    expect(isCompactGameViewport(width, height)).toBe(true);
  });
});
