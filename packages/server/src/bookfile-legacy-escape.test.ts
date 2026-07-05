import {describe, expect, it} from 'vitest';
import {
  bookHtmlToPage,
  pageToBookHtml,
  readIsland,
  sanitizeLegacyInline,
  type PageSnapshot,
} from '@book.dev/sdk';

/**
 * Security (Sasha's review): `pageToBookHtml` rendered LEGACY EditorJS `d.text`
 * and string list-items UNESCAPED into the static `.book.html` body — a stored
 * XSS sink. A hostile EditorJS-shaped snapshot (crafted import / pre-migration
 * page) meant opening the mirrored/exported file from `file://` executed
 * injected `<script>`. Block-editor pages were always escaped (`runHtml`); only
 * the legacy path was exposed.
 *
 * Treatment: escape-then-restore an attribute-less inline-formatting ALLOWLIST
 * (`sanitizeLegacyInline`) — default-inert, restores only bare b/i/u/s/code/br
 * (what the editor's own `htmlToRuns` migration honors), never anchors or
 * anything carrying an attribute. The JSON island stays authoritative.
 */

const NOW = '2026-07-05T00:00:00.000Z';

/** A legacy EditorJS snapshot from raw paragraph/list HTML strings. */
const legacy = (blocks: Array<{id: string; type: string; data: Record<string, unknown>}>): PageSnapshot => ({
  editorjs: {blocks},
  values: [],
  names: [],
});

const record = (data: PageSnapshot, over: Partial<{id: string; name: string}> = {}) => ({
  id: over.id ?? 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  name: over.name ?? 'Legacy Page',
  icon: null,
  updatedAt: NOW,
  data,
});

describe('sanitizeLegacyInline', () => {
  it('neutralizes scripts, event handlers, and javascript: hrefs', () => {
    const dirty =
      '<script>alert(1)</script><img src=x onerror="alert(2)"><b onclick="steal()">x</b><a href="javascript:alert(3)">y</a>';
    const clean = sanitizeLegacyInline(dirty);
    // Nothing EXECUTABLE survives — no live tag of any kind is emitted (the
    // payloads remain only as inert, escaped `&lt;…&gt;` text).
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/<img/i);
    expect(clean).not.toMatch(/<a\b/i);
    // No live element carries an event handler or a javascript: href (i.e. no
    // real `<tag …>` at all here — only bare allowlisted tags are ever emitted).
    expect(clean).not.toMatch(/<[a-z]+[^>]*\son\w+=/i);
    expect(clean).not.toMatch(/<[a-z]+[^>]*javascript:/i);
    // The attributed <b onclick=…> is NOT restored (only a BARE <b> would be),
    // so the handler survives only as inert escaped text.
    expect(clean).toContain('&lt;b onclick=');
  });

  it('restores the attribute-less formatting allowlist (what htmlToRuns honors)', () => {
    expect(sanitizeLegacyInline('<b>bold</b>')).toBe('<b>bold</b>');
    expect(sanitizeLegacyInline('a <i>it</i> <u>u</u> <s>s</s> <code>c</code> <strong>S</strong> <em>E</em>')).toBe(
      'a <i>it</i> <u>u</u> <s>s</s> <code>c</code> <strong>S</strong> <em>E</em>',
    );
    expect(sanitizeLegacyInline('line<br>break')).toBe('line<br>break');
    expect(sanitizeLegacyInline('x<br/>y<br />z')).toBe('x<br>y<br>z');
  });

  it('is idempotent-safe against a literal escaped sequence (no double-unescape)', () => {
    // An author who literally typed "&lt;b&gt;" must NOT get a live <b>.
    expect(sanitizeLegacyInline('&lt;b&gt;')).toBe('&amp;lt;b&amp;gt;');
  });

  it('does not restore an unknown/dangerous bare tag', () => {
    expect(sanitizeLegacyInline('<iframe></iframe><style>x</style>')).toBe(
      '&lt;iframe&gt;&lt;/iframe&gt;&lt;style&gt;x&lt;/style&gt;',
    );
  });
});

describe('pageToBookHtml — legacy body is inert', () => {
  it('renders a hostile EditorJS paragraph + list inert, keeps legit formatting', () => {
    const html = pageToBookHtml(
      record(
        legacy([
          {id: 'p', type: 'paragraph', data: {text: '<script>alert(1)</script> and <b>ok</b>'}},
          {id: 'h', type: 'header', data: {level: 2, text: '<img src=x onerror=alert(2)> Title'}},
          {id: 'l', type: 'list', data: {style: 'unordered', items: ['<script>evil()</script>', 'plain <i>italic</i>']}},
        ]),
      ),
    );
    // Scope the safety check to the rendered BODY — the JSON island below it
    // losslessly carries the raw text as DATA (inside a non-executable
    // `application/openbook+json` script), which is correct and expected.
    const body = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
    // The static body carries NO executable markup from the hostile content.
    expect(body).not.toMatch(/<script/i);
    expect(body).not.toMatch(/<img/i);
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(body).toContain('&lt;img src=x onerror=alert(2)&gt;');
    // Legitimate inline formatting is preserved in the readable body.
    expect(body).toContain('<b>ok</b>');
    expect(body).toContain('plain <i>italic</i>');
    // The only real <script> ELEMENT is the canonical source island. (The island
    // content may itself contain the literal text `<script>` as inert DATA — it
    // can't close the island, since `</script>` is written `<\/script>`, and its
    // type is non-executable; so we count real island tags, not the substring.)
    expect(html.match(/<script type="application\/openbook\+json"/g)?.length).toBe(1);
  });

  it('a forged early island in legacy text cannot win the island reader (boot-hijack class)', () => {
    // #92 adds a runtime boot that extracts the FIRST openbook+json island to
    // hydrate. A hostile legacy page tries to smuggle a forged island (a
    // different id/data) BEFORE the real trailing one. Tested here against the
    // sdk island reader (ISLAND_RE via readIsland) since the boot isn't on this
    // branch — closing the body sink closes both: the forged <script> is escaped
    // to text, so no extractor (reader or boot) can ever match it.
    const forged =
      '<script type="application/openbook+json">{"version":1,"id":"EVIL","name":"pwned","icon":null,"updatedAt":"","data":{"editorjs":{"blocks":[]},"values":[],"names":[]}}</script>';
    const html = pageToBookHtml(
      record(legacy([{id: 'p', type: 'paragraph', data: {text: `${forged} hello`}}]), {id: 'real-id-1234'}),
    );
    // The forged script never forms a real tag in the body — escaped to text.
    const body = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
    expect(body).toContain('&lt;script type=&quot;application/openbook+json&quot;&gt;');
    expect(body).not.toMatch(/<script/i);
    // Exactly one REAL openbook+json script tag exists (the trailing island).
    expect(html.match(/<script type="application\/openbook\+json"/g)?.length).toBe(1);
    // The reader — and, by construction, #92's identical extractor — sees only
    // the REAL trailing island, never the forged one. (The authoritative island
    // still carries the page's literal text, incl. the word EVIL, as DATA — that
    // is lossless-by-design, hence the id check rather than a string-absence one.)
    expect(readIsland<{id: string}>(html)!.id).toBe('real-id-1234');
    expect(bookHtmlToPage(html)!.id).toBe('real-id-1234');
  });
});

describe('block-editor path is unaffected (byte-compat)', () => {
  it('block-editor pages still escape raw run text and emit format tags (never the legacy sanitizer)', () => {
    const blockdoc = {
      blocks: [
        {
          id: 'a',
          type: 'paragraph',
          // A run whose TEXT is a literal `<script>` — the block path escapes it
          // via runHtml (independent of the legacy sink), plus a real bold run.
          text: [{t: 'hi '}, {t: 'bold', a: {b: true}}, {t: ' <script>x</script>'}],
        },
      ],
    };
    const data: PageSnapshot = {editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc};
    const html = pageToBookHtml(record(data));
    expect(html).toContain('hi <strong>bold</strong> &lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>x</script>');
  });
});
