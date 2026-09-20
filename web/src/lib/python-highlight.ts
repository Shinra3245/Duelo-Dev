const PYTHON_TOKENS =
  /#[^\r\n]*|'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\b(?:and|as|assert|class|def|elif|else|for|from|if|import|in|is|not|or|return|while|True|False|None)\b|\b\d+(?:\.\d+)?\b/g;

export function highlightPython(value: string): string {
  let result = '';
  let previousIndex = 0;

  for (let match = PYTHON_TOKENS.exec(value); match !== null; match = PYTHON_TOKENS.exec(value)) {
    const token = match[0];
    const index = match.index;
    result += escapeHtml(value.slice(previousIndex, index));

    const color = token.startsWith('#')
      ? 'text-emerald-300'
      : token.startsWith('"') || token.startsWith("'")
        ? 'text-amber-300'
        : /^\d/.test(token)
          ? 'text-fuchsia-300'
          : 'text-cyan-300';
    result += `<span class="${color}">${escapeHtml(token)}</span>`;
    previousIndex = index + token.length;
  }

  return result + escapeHtml(value.slice(previousIndex));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
