import type { Language } from '@duelodev/shared';
import { escapeHtml, highlightPython } from './python-highlight';

const COMPILED_TOKENS =
  /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[ \t]*\w+|\b(?:alignas|auto|bool|break|case|catch|char|class|const|constexpr|continue|default|delete|do|double|else|enum|extends|false|final|finally|float|for|if|implements|import|include|instanceof|int|interface|long|namespace|new|null|nullptr|package|private|protected|public|return|short|signed|sizeof|static|std|String|struct|super|switch|template|this|throw|throws|true|try|typedef|typename|unsigned|using|virtual|void|volatile|while)\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fFlLuU]*\b/g;

/** Resaltado ligero y escapado; el texto del jugador nunca se interpreta como HTML. */
export function highlightCode(value: string, language: Language): string {
  if (language === 'python') return highlightPython(value);
  let result = '';
  let previousIndex = 0;
  for (const match of Array.from(value.matchAll(COMPILED_TOKENS))) {
    const token = match[0];
    result += escapeHtml(value.slice(previousIndex, match.index));
    const color =
      token.startsWith('//') || token.startsWith('/*')
        ? 'text-emerald-300'
        : token.startsWith('"') || token.startsWith("'")
          ? 'text-amber-300'
          : /^\d/.test(token)
            ? 'text-fuchsia-300'
            : 'text-cyan-300';
    result += `<span class="${color}">${escapeHtml(token)}</span>`;
    previousIndex = match.index + token.length;
  }
  return result + escapeHtml(value.slice(previousIndex));
}
