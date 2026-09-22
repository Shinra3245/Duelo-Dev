export const RECOMMENDED_GAME_VIEWPORT = {
  minWidth: 1024,
  minHeight: 640,
} as const;

export function isCompactGameViewport(width: number, height: number): boolean {
  return width < RECOMMENDED_GAME_VIEWPORT.minWidth || height < RECOMMENDED_GAME_VIEWPORT.minHeight;
}
