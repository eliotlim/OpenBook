/**
 * The on-disk **book file** format (OB-134): one HTML file per page. Each file
 * is human-readable (so external sync/backup tools and editors see real content)
 * yet round-trips losslessly back into pglite, because it embeds the canonical
 * {@link PageSnapshot} as a JSON island alongside the rendered body.
 *
 * Every rendered block carries a stable `data-block-id` and a `data-block-mtime`,
 * and the page itself carries `data-page-id` / `data-page-updated` (the DB
 * `updatedAt` the file was rendered from — the conflict base) / `data-page-mtime`.
 * Those attributes are the change signal the watcher and conflict resolver read.
 *
 * Pure and isomorphic: rendering and the island parse use no DOM, so the server
 * mirror can emit and re-read files directly. The readable body mirrors the
 * `export/` look (the `ob-*` class names) without depending on the ui package.
 */
import type {PageSnapshot} from './types';
import {latestBlockMtime} from './mtime';
import {islandScript, readIsland} from './island';

/** A page reduced to what a book file needs to carry. */
export interface BookPageRecord {
  id: string;
  name: string | null;
  icon: string | null;
  /** The DB `updatedAt` this file was rendered from — the conflict base. */
  updatedAt: string;
  data: PageSnapshot;
}

/**
 * The canonical **page source-island** payload: a versioned {@link BookPageRecord}.
 * This is exactly what a `.book.html` file AND a single-page / slide-deck HTML
 * export embed, so `bookHtmlToPage` (or the generic `readIsland`) reads any of
 * them back the same way. Downstream import consumes this shape.
 */
export interface PageIsland extends BookPageRecord {
  version: 1;
}

/** Wrap a page record as its source-island `<script>` (versioned, escaped). */
export function pageIslandScript(record: BookPageRecord, opts: {attrs?: string; indent?: string} = {}): string {
  const {id, name, icon, updatedAt, data} = record;
  return islandScript({version: 1, id, name, icon, updatedAt, data}, opts);
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The attribute-less inline formatting tags a legacy EditorJS text string may
 * carry, and the editor's own migration ({@link htmlToRuns} in the ui package)
 * honors: bold / italic / underline / strike / code. Every one is a bare tag
 * with NO attributes, so it can never carry a payload — that is the whole safety
 * argument for the escape-then-restore approach below.
 */
const LEGACY_INLINE_TAGS = ['b', 'strong', 'i', 'em', 'u', 's', 'del', 'code'];

/**
 * Sanitize a **legacy EditorJS** inline-HTML string for the readable `.book.html`
 * body (block-editor pages carry structured rich-text runs and never reach here;
 * they are already fully escaped by {@link runHtml}). This closes a stored-XSS
 * sink: a hostile EditorJS-shaped snapshot (a crafted import or a pre-migration
 * page) otherwise renders raw `<script>` / `<img onerror>` / event handlers /
 * `javascript:` hrefs straight into the static file, which execute when the
 * mirrored/exported file is opened from `file://`.
 *
 * DEFAULT-INERT: escape the ENTIRE string first (so everything is neutralized),
 * then restore ONLY the exact, attribute-less inline formatting tags above via a
 * regex that requires the tag name be followed immediately by `>` — so
 * `<b onclick=…>` (escaped, has an attribute) is never restored, only a bare
 * `<b>`. Anchors are DELIBERATELY not restored: safely reconstructing an `href`
 * would require attribute + scheme parsing (the classic sanitizer footgun) with
 * no DOM available in this isomorphic module — a legacy link degrades to inert
 * escaped text in this best-effort readable preview, while the JSON island keeps
 * it losslessly and the page migrates to fully-rendered runs the first time it
 * is opened. See the module's mirror byte-compat note.
 */
export function sanitizeLegacyInline(html: string): string {
  let out = esc(html);
  for (const tag of LEGACY_INLINE_TAGS) {
    // Bare open/close tags only (no attributes) — `&lt;b&gt;` / `&lt;/b&gt;`.
    out = out
      .replace(new RegExp(`&lt;${tag}&gt;`, 'gi'), `<${tag}>`)
      .replace(new RegExp(`&lt;/${tag}&gt;`, 'gi'), `</${tag}>`);
  }
  // `<br>` (void): the plain, self-closing, and spaced variants → a bare `<br>`.
  out = out.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  return out;
/** The folder-level runtime directory name (never a valid book-folder slug). */
export const BOOK_RUNTIME_DIR = '_openbook';

/** Relative path (from the folder root) of the shared viewer runtime bundle. */
export const BOOK_RUNTIME_FILE = `${BOOK_RUNTIME_DIR}/viewer.js`;

/**
 * The **byte-constant** runtime reference block a `.book.html` embeds in its
 * `<head>` when the folder carries the shared viewer bundle (`_openbook/viewer.js`
 * — ONE copy per folder, owner decision 2026-07-04: never vendored per-file).
 *
 * Stability contract: this block contains NO per-page and NO per-version variance
 * (no content hash, no build id), so
 *  - a page save re-renders to the same reference bytes (no mirror churn), and
 *  - a viewer-bundle upgrade rewrites ONLY `_openbook/viewer.js`, never the N
 *    page files. Only gaining/losing the runtime altogether changes page bytes
 *    (a deliberate one-time, upgrade-class rewrite).
 *
 * The boot script:
 *  - loads after parse (the src script is `defer`; boot waits for DOMContentLoaded),
 *    so both tags sit safely in `<head>` where hostile body text (an unterminated
 *    `<!--`) can never swallow them;
 *  - extracts the island by REGEX over the serialized document — the sdk
 *    `readIslandRaw` pattern, never `querySelector`/DOMParser (see viewer/index.tsx:
 *    a DOM query misses an island a stray open comment swallowed, while the
 *    serialized comment text still matches the regex);
 *  - mounts the interactive viewer over the static `<article>` and hides it; ANY
 *    failure (bundle deleted, no global, corrupt island, mount throw) leaves the
 *    readable static article exactly as-is — the runtime is progressive
 *    enhancement over the no-JS fallback.
 *
 * Inside the inline script every `/` that could form `</script>` (the regex
 * literal) is escaped as `<\/` so the block can never close itself early, and the
 * island marker appears only in its regex-escaped form (`application\/openbook\+json`),
 * which the sdk island reader does NOT match — the boot can never be mistaken for
 * the island itself.
 */
export function bookRuntimeScripts(): string {
  return `<script src="../${BOOK_RUNTIME_FILE}" defer data-openbook-runtime></script>
<script data-openbook-runtime-boot>
(function () {
  function boot() {
    try {
      if (typeof OpenBookViewer === 'undefined') return;
      var m = document.documentElement.outerHTML.match(/<script[^>]*type="application\\/openbook\\+json"[^>]*>([\\s\\S]*?)<\\/script>/i);
      if (!m) return;
      var island = JSON.parse(m[1].trim());
      var article = document.querySelector('article');
      var host = document.createElement('div');
      (article && article.parentNode ? article.parentNode : document.body).insertBefore(host, article);
      // Inline display:none (not the hidden attribute): the bundle injects the
      // app stylesheet, whose author-level display rules would defeat the UA's
      // [hidden] mapping. The inline style always wins; mount failure restores it.
      if (article) article.style.display = 'none';
      try {
        OpenBookViewer.mount(host, island);
      } catch (err) {
        host.remove();
        if (article) article.style.display = '';
      }
    } catch (err) { /* leave the static article untouched */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
</script>`;
}

/** Lower-case, dash-separated, filesystem-safe slug (for the on-disk filename). */
export function slugify(input: string, fallback = 'untitled'): string {
  const slug = (input || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

interface RawBlock {
  id?: string;
  type?: string;
  data?: Record<string, unknown>;
  text?: Array<{t: string; a?: Record<string, unknown>}>;
  props?: Record<string, unknown>;
  children?: RawBlock[];
}

/** Ordered top-level blocks with resolved ids (matching sdk `snapshotBlocks`). */
function orderedBlocks(data: PageSnapshot): Array<{id: string; type: string; block: RawBlock}> {
  const blockdoc = data.blockdoc as {blocks?: RawBlock[]} | undefined;
  const raw =
    data.editor === 'blocks' && Array.isArray(blockdoc?.blocks)
      ? blockdoc.blocks
      : ((data.editorjs as {blocks?: RawBlock[]} | undefined)?.blocks ?? []);
  return raw.map((b, i) => ({id: typeof b.id === 'string' && b.id ? b.id : `b${i}`, type: b.type ?? 'unknown', block: b}));
}

/** Inline HTML for a block-editor rich-text run. */
function runHtml(run: {t: string; a?: Record<string, unknown>}): string {
  let out = esc(run.t).replace(/\n/g, '<br>');
  const a = run.a ?? {};
  if (a.c) out = `<code>${out}</code>`;
  if (a.b) out = `<strong>${out}</strong>`;
  if (a.i) out = `<em>${out}</em>`;
  if (a.u) out = `<u>${out}</u>`;
  if (a.s) out = `<s>${out}</s>`;
  if (typeof a.m === 'string') out = `<a class="ob-mention" data-page-id="${esc(a.m)}">${out}</a>`;
  else if (typeof a.a === 'string') out = `<a href="${esc(a.a)}">${out}</a>`;
  return out;
}

const runsHtml = (runs: RawBlock['text']): string => (runs ?? []).map(runHtml).join('');

/** Best-effort readable inner HTML for one block (the island stays authoritative). */
function blockInnerHtml(type: string, block: RawBlock): {tag: string; inner: string} {
  const d = block.data ?? {};
  // Block-editor pages carry rich-text runs (escaped by runHtml); legacy EditorJS
  // pages carry raw inline-HTML strings — sanitize those before they reach the
  // static body (default-inert allowlist; see sanitizeLegacyInline).
  const textHtml = block.text ? runsHtml(block.text) : typeof d.text === 'string' ? sanitizeLegacyInline(d.text) : '';

  switch (type) {
  case 'heading':
  case 'header': {
    const level = Math.min(6, Math.max(1, Number((block.props as {level?: number})?.level ?? d.level ?? 2)));
    return {tag: `h${level}`, inner: textHtml};
  }
  case 'quote':
    return {tag: 'blockquote', inner: textHtml};
  case 'code':
    return {tag: 'pre', inner: `<code>${esc(block.text ? (block.text.map((r) => r.t).join('')) : String(d.code ?? ''))}</code>`};
  case 'list': {
    const items = Array.isArray(d.items) ? (d.items as unknown[]) : [];
    const ordered = d.style === 'ordered';
    const lis = items
      .map((it) => `<li>${typeof it === 'string' ? sanitizeLegacyInline(it) : esc(String((it as {content?: string})?.content ?? ''))}</li>`)
      .join('');
    return {tag: ordered ? 'ol' : 'ul', inner: lis};
  }
  case 'todo':
  case 'checklist': {
    const checked = (block.props as {checked?: boolean})?.checked === true || d.checked === true;
    return {tag: 'p', inner: `<input type="checkbox"${checked ? ' checked' : ''} disabled> ${textHtml}`};
  }
  case 'delimiter':
  case 'divider':
    return {tag: 'hr', inner: ''};
  case 'paragraph':
    return {tag: 'p', inner: textHtml};
  default:
    // Unknown / rich blocks (charts, tables, kit, …): readable text only — the
    // JSON island carries their full data for a faithful re-import.
    return {tag: 'div', inner: textHtml || `<em class="ob-raw">${esc(type)} block</em>`};
  }
}

/** Options for {@link pageToBookHtml}. */
export interface BookHtmlOptions {
  /**
   * Reference the folder's shared viewer runtime (`_openbook/viewer.js`) so the
   * file, opened directly in a browser, hydrates into the interactive locked
   * viewer. Pass true ONLY when the writer also ships the bundle into the folder
   * (sdk `spaceToBookFiles({runtime})` / server `BookMirror` with `runtimeBundle`)
   * — a reference without the bundle degrades gracefully (static article), but
   * writers keep the invariant anyway. Emitters MUST agree on this flag for the
   * SDK/server byte-compatibility contract to hold.
   */
  runtimeRef?: boolean;
}

/** Render a page to its on-disk book-file HTML (readable body + canonical island). */
export function pageToBookHtml(record: BookPageRecord, opts: BookHtmlOptions = {}): string {
  const {id, name, icon, updatedAt, data} = record;
  const title = (name ?? '').trim() || 'Untitled';
  const mtime = new Map<string, string>(data.mtimes ?? []);
  const pageMtime = latestBlockMtime(data) ?? updatedAt;

  const body = orderedBlocks(data)
    .map(({id: blockId, type, block}) => {
      const {tag, inner} = blockInnerHtml(type, block);
      const attrs = `data-block-id="${esc(blockId)}" data-block-type="${esc(type)}" data-block-mtime="${esc(mtime.get(blockId) ?? updatedAt)}"`;
      return tag === 'hr' ? `    <hr ${attrs}>` : `    <${tag} ${attrs}>${inner}</${tag}>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en" data-openbook="book-page" data-page-id="${esc(id)}" data-page-name="${esc(title)}" data-page-updated="${esc(updatedAt)}" data-page-mtime="${esc(pageMtime)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${opts.runtimeRef ? `${bookRuntimeScripts()}\n` : ''}</head>
<body class="ob-page">
  <article>
    <h1 class="ob-page-title">${icon ? `${esc(icon)} ` : ''}${esc(title)}</h1>
${body}
  </article>
${pageIslandScript({id, name, icon, updatedAt, data}, {attrs: 'data-openbook-snapshot', indent: '  '})}
</body>
</html>
`;
}

/** Cheap metadata read from the `<html>` tag — id + conflict base + name. */
export function readBookHtmlMeta(html: string): {id: string; name: string; updatedAt: string} | null {
  const tag = html.match(/<html\b[^>]*\bdata-openbook="book-page"[^>]*>/i)?.[0];
  if (!tag) return null;
  const attr = (n: string): string => {
    const m = tag.match(new RegExp(`\\b${n}="([^"]*)"`, 'i'));
    return m ? unesc(m[1]) : '';
  };
  const id = attr('data-page-id');
  if (!id) return null;
  return {id, name: attr('data-page-name'), updatedAt: attr('data-page-updated')};
}

const unesc = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

/**
 * Parse a book file back into its page record via the canonical JSON island.
 * Returns `null` if the file isn't an OpenBook book page or the island is
 * missing/corrupt. This is the lossless re-import path (sync clients, restored
 * backups, moved files all preserve the island).
 */
export function bookHtmlToPage(html: string): BookPageRecord | null {
  const parsed = readIsland<Partial<PageIsland>>(html);
  if (!parsed || !parsed.id || !parsed.data) return null;
  return {
    id: parsed.id,
    name: parsed.name ?? null,
    icon: parsed.icon ?? null,
    updatedAt: parsed.updatedAt ?? '',
    data: parsed.data,
  };
}
