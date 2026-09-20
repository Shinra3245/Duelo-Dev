import { describe, expect, it } from 'vitest';
import { highlightPython } from '../src/lib/python-highlight.js';

describe('resaltado del editor Python', () => {
  it('no interpreta como comentario un # dentro de una cadena', () => {
    const html = highlightPython('print("# esto es texto") # esto es comentario');

    expect(html).toContain('<span class="text-amber-300">&quot;# esto es texto&quot;</span>');
    expect(html).toContain('<span class="text-emerald-300"># esto es comentario</span>');
    expect(html).not.toContain('<span class="text-emerald-300"># esto es texto</span>');
  });

  it('respeta comillas escapadas y cadenas multilínea', () => {
    const escapedQuote = ['value = "quote: ', '\\', '"# still text', '\\', '""'].join('');
    const html = highlightPython(escapedQuote);
    const multiline = highlightPython(
      ['doc = """# sigue siendo texto', 'en otra línea"""'].join('\n'),
    );
    const expectedDocstring = [
      '<span class="text-amber-300">&quot;&quot;&quot;# sigue siendo texto',
      'en otra línea&quot;&quot;&quot;</span>',
    ].join('\n');

    expect(html).toContain('text-amber-300');
    expect(html).not.toContain('text-emerald-300');
    expect(multiline).toContain(expectedDocstring);
    expect(multiline).not.toContain('text-emerald-300');
  });

  it('escapa HTML del código antes de insertarlo en el resaltado', () => {
    const html = highlightPython('print("<img src=x onerror=alert(1)>")');

    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });
});
