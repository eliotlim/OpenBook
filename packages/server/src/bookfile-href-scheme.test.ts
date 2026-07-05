import {describe, expect, it} from 'vitest';
import {isSafeHref, pageToBookHtml, type PageSnapshot} from '@book.dev/sdk';

/**
 * Security (Sasha, adjacent to #94): `runHtml` rendered `<a href="${esc(a.a)}">`
 * — `esc()` escapes the attribute but NOT the URI scheme, so a run attribute
 * `a:{a:"javascript:alert(1)"}` produced a live, clickable `javascript:` link in
 * the static `.book.html` body (a `file://`-origin, click-gated XSS). The fix
 * scheme-allowlists via {@link isSafeHref}; a rejected href degrades to inert
 * text. The same guard is applied to every static-HTML href sink in the export
 * paths (covered in the ui package's export tests).
 */

const NOW = '2026-07-05T00:00:00.000Z';

/** A block-editor snapshot with a single paragraph carrying one linked run. */
const linkSnap = (href: string): PageSnapshot => ({
  editorjs: {blocks: []},
  values: [],
  names: [],
  editor: 'blocks',
  blockdoc: {blocks: [{id: 'p', type: 'paragraph', text: [{t: 'click', a: {a: href}}]}]},
});

const record = (data: PageSnapshot) => ({id: 'p1', name: 'P', icon: null, updatedAt: NOW, data});

describe('isSafeHref', () => {
  it('permits http(s), mailto, and relative / anchor / query links', () => {
    for (const ok of [
      'https://example.com/x?q=1#h',
      'http://example.com',
      'HTTPS://EXAMPLE.COM',
      'mailto:a@b.com',
      '/pages/1',
      './rel',
      '../up',
      '#anchor',
      '?q=1',
      'plain/path.html',
      '', // empty href — harmless, byte-preserving with the old esc('') path
    ]) {
      expect(isSafeHref(ok), ok).toBe(true);
    }
  });

  it('denies javascript:, data:, vbscript:, file:, tel:, and other schemes', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      '  javascript:alert(1)', // leading whitespace stripped before the test
      'java\tscript:alert(1)', // embedded tab (browsers ignore it)
      'java\nscript:alert(1)', // embedded newline
      'java\u0000script:alert(1)', // embedded NUL (all C0 control chars stripped before the scheme test)
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'tel:+15551234',
    ]) {
      expect(isSafeHref(bad), bad).toBe(false);
    }
  });

  it('denies protocol-relative // (and backslash-folded variants)', () => {
    expect(isSafeHref('//evil.example')).toBe(false);
    expect(isSafeHref('/\\evil.example')).toBe(false); // `\` folds to `/` → `//`
    expect(isSafeHref('\\\\evil.example')).toBe(false);
    expect(isSafeHref('  //evil.example')).toBe(false);
  });
});

describe('pageToBookHtml — anchor href is scheme-gated', () => {
  it('drops the anchor for a javascript: href (degrades to inert text)', () => {
    const html = pageToBookHtml(record(linkSnap('javascript:alert(1)')));
    const body = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
    expect(body).not.toMatch(/<a\b/i); // no anchor element at all
    expect(body).not.toContain('javascript:');
    expect(body).toContain('click'); // the text survives, just unlinked
  });

  it('drops the anchor for data: / vbscript: / protocol-relative hrefs', () => {
    for (const bad of ['data:text/html,<script>x</script>', 'vbscript:msgbox(1)', '//evil.example']) {
      const body = pageToBookHtml(record(linkSnap(bad)));
      const article = body.slice(body.indexOf('<article'), body.indexOf('</article>'));
      expect(article, bad).not.toMatch(/<a\b/i);
    }
  });

  it('renders benign links byte-identically (http/https/mailto/relative)', () => {
    for (const ok of ['https://example.com/x', 'mailto:a@b.com', '/pages/1']) {
      const body = pageToBookHtml(record(linkSnap(ok)));
      const article = body.slice(body.indexOf('<article'), body.indexOf('</article>'));
      expect(article, ok).toContain(`<a href="${ok}">click</a>`);
    }
  });
});
