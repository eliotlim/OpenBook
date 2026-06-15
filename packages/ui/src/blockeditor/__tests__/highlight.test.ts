import {describe, expect, it} from 'vitest';
import {escapeAttr, escapeText, highlightCode} from '../highlight';

/** Invert the render: HTML → the plain character stream it represents. If this
 *  round-trips the source for every input, the caret math (caret = number of
 *  characters before it) is preserved no matter how the tokens are wrapped. */
function htmlToText(html: string): string {
  return html
    .replace(/<br>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

describe('escapeText', () => {
  it('escapes the characters the browser serializes, and newlines', () => {
    expect(escapeText('a < b > c & d')).toBe('a &lt; b &gt; c &amp; d');
    expect(escapeText('line1\nline2')).toBe('line1<br>line2');
    expect(escapeText(' ')).toBe('&nbsp;');
  });

  it('does NOT escape quotes (browsers keep them literal in text content)', () => {
    // The cursor-jump bug: escaping " → &quot; made el.innerHTML never equal
    // the generated HTML for any code containing a quote, so every recompute
    // rewrote the DOM and reset the caret to the start.
    expect(escapeText('say "hi" and \'bye\'')).toBe('say "hi" and \'bye\'');
  });
});

describe('escapeAttr', () => {
  it('escapes quotes (attribute values must)', () => {
    expect(escapeAttr('a"b')).toBe('a&quot;b');
  });
});

describe('highlightCode', () => {
  it('preserves the exact character stream for varied inputs', () => {
    const samples = [
      'const x = "hello \\"world\\"";',
      'function f(a, b) {\n  return a + b; // sum\n}',
      'a < b && c > d & e',
      'x = `template ${y} <tag>`',
      'def f():\n    return None  # done',
      'const s = "a\nb"', // unterminated string spanning a newline
      '',
      '   leading + trailing   ',
      'url("http://x?a=1&b=2")',
    ];
    for (const src of samples) {
      expect(htmlToText(highlightCode(src, 'js'))).toBe(src);
    }
  });

  it('wraps keywords, strings, numbers and comments', () => {
    const html = highlightCode('const n = 42; // note', 'js');
    expect(html).toContain('<span class="obe-tok-kw">const</span>');
    expect(html).toContain('<span class="obe-tok-num">42</span>');
    expect(html).toContain('<span class="obe-tok-com">// note</span>');
    const str = highlightCode('let s = "hi"', 'js');
    expect(str).toContain('<span class="obe-tok-str">"hi"</span>');
  });

  it('treats # as a comment only in hash-comment languages', () => {
    expect(highlightCode('# heading', 'py')).toContain('<span class="obe-tok-com"># heading</span>');
    // In JS, # is not a line comment — it must not swallow the rest of the line.
    expect(highlightCode('a # b', 'js')).not.toContain('obe-tok-com');
  });

  it('highlights literals distinctly from keywords', () => {
    expect(highlightCode('x = null', 'js')).toContain('<span class="obe-tok-lit">null</span>');
    expect(highlightCode('x = True', 'py')).toContain('<span class="obe-tok-lit">True</span>');
  });
});
