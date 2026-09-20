import { describe, expect, it } from 'vitest';
import { fitRondasTarget, getActiveProblemLimit } from '../src/lib/admin-room-config.js';

describe('límites de configuración de sala en administración', () => {
  it('calcula el máximo de problemas según las dificultades elegidas', () => {
    expect(getActiveProblemLimit(['facil'])).toBe(10);
    expect(getActiveProblemLimit(['facil', 'facil_medio'])).toBe(20);
    expect(getActiveProblemLimit(['facil', 'facil_medio', 'dificil'])).toBe(30);
    expect(getActiveProblemLimit(['muy_facil'])).toBe(0);
  });

  it('ajusta la meta de Rondas sin salir de los targets permitidos', () => {
    expect(fitRondasTarget(6, 4)).toBe(3);
    expect(fitRondasTarget(3, 10)).toBe(3);
    expect(fitRondasTarget(10, 9)).toBe(9);
  });
});
