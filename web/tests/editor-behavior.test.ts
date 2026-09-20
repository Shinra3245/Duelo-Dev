import { describe, expect, it } from 'vitest';
import {
  getClosingDelimiterSkipPosition,
  insertAutoClosePair,
  isClipboardShortcut,
} from '../src/lib/editor-behavior.js';

describe('comportamiento seguro del editor Python', () => {
  it.each([
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ])('completa %s con %s y deja el cursor dentro del par', (opening, closing) => {
    expect(insertAutoClosePair('print', 5, 5, opening)).toEqual({
      value: `print${opening}${closing}`,
      selectionStart: 6,
      selectionEnd: 6,
    });
  });

  it('envuelve el texto seleccionado y conserva su selección interior', () => {
    expect(insertAutoClosePair('items', 0, 5, '[')).toEqual({
      value: '[items]',
      selectionStart: 1,
      selectionEnd: 6,
    });
  });

  it('omite un cierre que ya existe justo después del cursor', () => {
    expect(getClosingDelimiterSkipPosition('value)', 5, 5, ')')).toBe(6);
    expect(getClosingDelimiterSkipPosition('value)', 4, 4, ')')).toBeNull();
    expect(getClosingDelimiterSkipPosition('value)', 5, 6, ')')).toBeNull();
  });

  it.each([
    ['c', { ctrlKey: true, metaKey: false, shiftKey: false }],
    ['v', { ctrlKey: true, metaKey: false, shiftKey: true }],
    ['x', { ctrlKey: false, metaKey: true, shiftKey: false }],
    ['Insert', { ctrlKey: false, metaKey: false, shiftKey: true }],
    ['Insert', { ctrlKey: true, metaKey: false, shiftKey: false }],
  ])('bloquea el atajo de portapapeles %s', (key, options) => {
    expect(isClipboardShortcut(key, options)).toBe(true);
  });

  it('no interfiere con letras ni con selección completa', () => {
    expect(isClipboardShortcut('p', { ctrlKey: false, metaKey: false, shiftKey: false })).toBe(
      false,
    );
    expect(isClipboardShortcut('a', { ctrlKey: true, metaKey: false, shiftKey: false })).toBe(
      false,
    );
  });
});
