/**
 * Lightweight, dependency-free syntax highlighting for code blocks.
 *
 * The editor owns the contenteditable DOM imperatively (see richtext.ts): the
 * rendered HTML's character stream has to stay an exact image of the Y.Text
 * string, because a caret is just "the number of characters before it". So the
 * highlighter only ever *wraps* runs in `<span>` — it never adds, drops, or
 * reorders a character — and newlines stay `<br>` (which the caret mapping
 * counts as one char). Tokenising is deliberately approximate: one pass of a
 * few regexes over a broad keyword union. A mis-tinted identifier is harmless;
 * a shifted caret is not.
 */

/**
 * Escape text for `innerHTML` so it round-trips the browser's own serializer:
 * `&`, `<`, `>` and U+00A0 are escaped and newlines become `<br>`, but quotes
 * are left alone. Browsers do *not* entity-escape quotes inside text content,
 * so escaping them here would make our generated HTML differ from `el.innerHTML`
 * on every render — which, on a caret-less re-render (a live recompute, an
 * autosave), would needlessly rewrite the DOM and drop the caret to the start.
 */
export function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\u00a0/g, '&nbsp;')
    .replace(/\n/g, '<br>');
}

/** Escape a value destined for a double-quoted HTML attribute. */
export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Languages whose line comment is `#` rather than `//`. Everything else falls
// back to the C-style `//` + `/* */` family (and unknown languages with it).
const HASH_COMMENT_LANGS = new Set([
  'py', 'python', 'sh', 'bash', 'shell', 'zsh', 'fish', 'ruby', 'rb', 'yaml', 'yml',
  'toml', 'ini', 'conf', 'cfg', 'r', 'perl', 'pl', 'make', 'makefile', 'dockerfile',
  'elixir', 'ex', 'exs', 'coffee', 'nim', 'jl', 'julia',
]);

// A broad union of keywords across the common languages. Over-matching an
// identifier that happens to share a keyword's spelling is an acceptable cost
// for staying language-agnostic and dependency-free.
const KEYWORDS = new Set([
  // JS / TS
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'default', 'new', 'delete', 'typeof',
  'instanceof', 'in', 'of', 'class', 'extends', 'super', 'this', 'import', 'from',
  'export', 'as', 'async', 'await', 'yield', 'try', 'catch', 'finally', 'throw',
  'void', 'enum', 'interface', 'type', 'implements', 'public', 'private',
  'protected', 'readonly', 'abstract', 'static', 'get', 'set', 'satisfies', 'keyof',
  'namespace', 'declare', 'module',
  // Python
  'def', 'elif', 'except', 'lambda', 'and', 'or', 'not', 'is', 'with', 'pass',
  'raise', 'global', 'nonlocal', 'assert', 'del', 'print', 'match', 'self',
  // Common to C-family / Go / Rust / etc.
  'fn', 'func', 'struct', 'impl', 'trait', 'use', 'pub', 'mut', 'package', 'defer',
  'go', 'chan', 'select', 'map', 'int', 'long', 'short', 'float', 'double', 'char',
  'bool', 'string', 'boolean', 'number', 'unsigned', 'signed', 'sizeof', 'using',
  'include', 'define', 'where', 'then', 'end', 'begin', 'when', 'unless', 'require',
]);

const LITERALS = new Set([
  'true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil', 'NaN', 'Infinity',
]);

/** One ordered token regex; capture groups: 1 comment · 2 string · 3 number · 4 identifier. */
function tokenRegex(lang: string): RegExp {
  const comment = HASH_COMMENT_LANGS.has(lang) ? '#[^\\n]*' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/';
  // Strings allow an unterminated tail (`"?`) so a half-typed string only tints
  // to the end of its line instead of swallowing the rest of the block.
  const str = '"(?:[^"\\\\\\n]|\\\\.)*"?|\'(?:[^\'\\\\\\n]|\\\\.)*\'?|`(?:[^`\\\\]|\\\\.)*`?';
  const num = '0[xX][0-9a-fA-F]+|0[bB][01]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?';
  const ident = '[A-Za-z_$][\\w$]*';
  return new RegExp(`(${comment})|(${str})|(${num})|(${ident})`, 'g');
}

/** Render `src` to highlighted HTML whose character stream equals `src` exactly. */
export function highlightCode(src: string, language?: string): string {
  if (src === '') return '';
  const re = tokenRegex((language ?? '').toLowerCase());
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out += escapeText(src.slice(last, m.index));
    const tok = m[0];
    let cls = '';
    if (m[1] !== undefined) cls = 'com';
    else if (m[2] !== undefined) cls = 'str';
    else if (m[3] !== undefined) cls = 'num';
    else if (m[4] !== undefined) cls = LITERALS.has(tok) ? 'lit' : KEYWORDS.has(tok) ? 'kw' : '';
    out += cls ? `<span class="obe-tok-${cls}">${escapeText(tok)}</span>` : escapeText(tok);
    last = m.index + tok.length;
    if (tok.length === 0) re.lastIndex += 1; // defensive: never spin on a zero-width match
  }
  if (last < src.length) out += escapeText(src.slice(last));
  return out;
}
