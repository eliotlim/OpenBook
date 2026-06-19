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

/** A page reduced to what a book file needs to carry. */
export interface BookPageRecord {
  id: string;
  name: string | null;
  icon: string | null;
  /** The DB `updatedAt` this file was rendered from — the conflict base. */
  updatedAt: string;
  data: PageSnapshot;
}

const MARKER = 'application/openbook+json';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
  // Block-editor pages carry rich-text runs; EditorJS pages carry HTML strings.
  const textHtml = block.text ? runsHtml(block.text) : typeof d.text === 'string' ? (d.text as string) : '';

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
      .map((it) => `<li>${typeof it === 'string' ? it : esc(String((it as {content?: string})?.content ?? ''))}</li>`)
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

/** Render a page to its on-disk book-file HTML (readable body + canonical island). */
export function pageToBookHtml(record: BookPageRecord): string {
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

  // The island JSON is escaped so a literal `</script>` in content can't close
  // the tag early; `<\/` is still valid JSON and parses back to `</`.
  const island = JSON.stringify({version: 1, id, name, icon, updatedAt, data}).replace(/<\//g, '<\\/');

  return `<!doctype html>
<html lang="en" data-openbook="book-page" data-page-id="${esc(id)}" data-page-name="${esc(title)}" data-page-updated="${esc(updatedAt)}" data-page-mtime="${esc(pageMtime)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
</head>
<body class="ob-page">
  <article>
    <h1 class="ob-page-title">${icon ? `${esc(icon)} ` : ''}${esc(title)}</h1>
${body}
  </article>
  <script type="${MARKER}" data-openbook-snapshot>
${island}
  </script>
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
  const m = html.match(
    new RegExp(`<script[^>]*type="${MARKER.replace(/[/+]/g, '\\$&')}"[^>]*>([\\s\\S]*?)</script>`, 'i'),
  );
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1].trim()) as Partial<BookPageRecord> & {version?: number};
    if (!parsed.id || !parsed.data) return null;
    return {
      id: parsed.id,
      name: parsed.name ?? null,
      icon: parsed.icon ?? null,
      updatedAt: parsed.updatedAt ?? '',
      data: parsed.data,
    };
  } catch {
    return null;
  }
}
