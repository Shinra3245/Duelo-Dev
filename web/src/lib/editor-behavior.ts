const AUTO_CLOSE_PAIRS: Readonly<Record<string, string>> = {
  '(': ')',
  '[': ']',
  '{': '}',
};

const CLOSING_DELIMITERS = new Set(Object.values(AUTO_CLOSE_PAIRS));
const CLIPBOARD_SHORTCUT_KEYS = new Set(['c', 'v', 'x', 'insert']);

export interface DelimiterInsertion {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export function insertAutoClosePair(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  openingDelimiter: string,
): DelimiterInsertion | null {
  const closingDelimiter = AUTO_CLOSE_PAIRS[openingDelimiter];
  if (!closingDelimiter) return null;

  const selectedText = value.slice(selectionStart, selectionEnd);
  return {
    value: `${value.slice(0, selectionStart)}${openingDelimiter}${selectedText}${closingDelimiter}${value.slice(selectionEnd)}`,
    selectionStart: selectionStart + 1,
    selectionEnd: selectionStart + 1 + selectedText.length,
  };
}

export function getClosingDelimiterSkipPosition(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  key: string,
): number | null {
  if (
    selectionStart !== selectionEnd ||
    !CLOSING_DELIMITERS.has(key) ||
    value[selectionStart] !== key
  ) {
    return null;
  }
  return selectionStart + 1;
}

export function isClipboardShortcut(
  key: string,
  options: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
): boolean {
  const normalizedKey = key.toLowerCase();
  return (
    ((options.ctrlKey || options.metaKey) && CLIPBOARD_SHORTCUT_KEYS.has(normalizedKey)) ||
    (normalizedKey === 'insert' && options.shiftKey)
  );
}
