import { describe, expect, it } from 'vitest';
import { highlightCode } from '../src/lib/code-highlight.js';
import { editorLabel, LANGUAGE_FILES, LANGUAGE_TEMPLATES } from '../src/lib/code-language.js';

describe('editor multilenguaje', () => {
  it.each(['cpp', 'java'] as const)(
    'escapa HTML y distingue strings/comentarios en %s',
    (language) => {
      const result = highlightCode(
        'String s = "https://ejemplo/<script>"; // comentario\nint x = 42;',
        language,
      );
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
      expect(result).toContain('text-amber-300');
      expect(result).toContain('text-emerald-300');
      expect(result).toContain('text-fuchsia-300');
      expect(result).toContain('text-cyan-300');
      expect(result.match(/text-emerald-300/g)).toHaveLength(1);
    },
  );

  it('respeta comentarios multilínea y escapa caracteres fuera de tokens', () => {
    const result = highlightCode(
      '/* int x = 1;\nreturn 2; */\nvalue < other && third > last;',
      'cpp',
    );
    expect(result.match(/<span/g)).toHaveLength(1);
    expect(result).toContain('&lt;');
    expect(result).toContain('&amp;&amp;');
    expect(result).toContain('&gt;');
  });

  it('identifica el archivo Main.java exigido por el compilador y conserva Python vacío', () => {
    expect(LANGUAGE_FILES.java).toBe('Main.java');
    expect(LANGUAGE_TEMPLATES.java).toContain('public class Main');
    expect(LANGUAGE_TEMPLATES.cpp).toContain('int main()');
    expect(LANGUAGE_TEMPLATES.python).toBe('');
    expect(editorLabel('cpp')).toBe('Editor de solución C++');
  });
});
