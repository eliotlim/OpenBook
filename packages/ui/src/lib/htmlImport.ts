/**
 * **HTML file / paste → import IR.** Parses an HTML document (or fragment) into
 * the format-agnostic {@link ImportedDoc} (see the SDK's `import.ts`), so
 * `importDoc` can land it through the existing data paths — completing the import
 * trio (Notion · Markdown · HTML).
 *
 * **Why the UI, not the SDK.** Unlike the Markdown importer — pure, DOM-free, in
 * the SDK — HTML is parsed with the DOM. This module reuses the editor's existing
 * {@link htmlToBlocks} clipboard converter (`blockeditor/model.ts`): the very same
 * HTML→blocks mapping the editor already runs for paste, which needs a live
 * `document` / `DOMParser`. The import flow is client-side in the webview where
 * those exist, so HTML belongs here rather than in the DOM-free SDK — and it
 * therefore parses on the **main thread**, never in the import worker (which has
 * no DOM). A single HTML document is light, so an inline parse (like pasted
 * Markdown) is fine.
 *
 * **Mapping.** `htmlToBlocks` covers headings, paragraphs, lists (incl. nested),
 * tables, `<pre>`/code, blockquotes, links + inline emphasis → runs, and
 * `<hr>` → divider; unknown elements degrade to their text (never dropped). This
 * module adds the one thing paste omits — an `onImage` handler mapping every
 * `<img>` to the import core's {@link imagePlaceholderBlock} (preserving `src` +
 * `alt` + `title`) — so an image becomes a visible placeholder, never a silent
 * loss. The page title is derived from `<title>`, else a leading `<h1>`.
 */
import {
  imagePlaceholderBlock,
  type AssetBytes,
  type ImportedBlock,
  type ImportedDoc,
  type ImportTextRun,
} from '@book.dev/sdk';
import {htmlToBlocks, type HtmlImageRef, type NewBlock} from '../blockeditor/model';
import {
  detectHtmlIsland,
  readExportAssetMap,
  summarizeHtmlIsland,
  type HtmlIsland,
  type IslandSummary,
} from './islandImport';

/** Options for {@link htmlToImportedDoc}. */
export interface HtmlImportOptions {
  /** Explicit page title — overrides `<title>` and any leading heading. */
  title?: string;
  /** Title used when none can be derived. Default `'Imported document'`. */
  defaultTitle?: string;
  /**
   * When no explicit / `<title>` title is given, promote a leading heading to the
   * page title (consuming it from the body). Default `true`.
   */
  firstHeadingAsTitle?: boolean;
}

const DEFAULT_TITLE = 'Imported document';

/**
 * The `onImage` hook handed to {@link htmlToBlocks}: turn an `<img>` into the
 * import core's visible placeholder block (preserving the src as a clickable
 * link + the alt/title). Returns `null` for a degenerate `<img>` with nothing
 * worth keeping, so it is dropped rather than emitting an empty placeholder.
 */
function imageBlock(img: HtmlImageRef): NewBlock | null {
  if (!img.src && !img.alt && !img.title) return null;
  return imagePlaceholderBlock({
    kind: 'image',
    ref: img.src,
    ...(img.alt ? {alt: img.alt} : {}),
    ...(img.title ? {title: img.title} : {}),
  }) as NewBlock;
}

/**
 * Normalise an editor {@link NewBlock} into the SDK import IR's
 * {@link ImportedBlock}. The two are structurally the same but for `text`: the
 * editor's `code` block carries a plain *string*, whereas the IR is runs-only —
 * so a string is wrapped as a single run. Recurses `children`.
 */
function toImportedBlock(block: NewBlock): ImportedBlock {
  const out: ImportedBlock = {type: block.type};
  if (typeof block.text === 'string') {
    if (block.text) out.text = [{t: block.text}];
  } else if (block.text && block.text.length > 0) {
    out.text = block.text.map((r): ImportTextRun => (r.a ? {t: r.t, a: r.a} : {t: r.t}));
  }
  if (block.id) out.id = block.id;
  if (block.props) out.props = block.props;
  if (block.children && block.children.length > 0) out.children = block.children.map(toImportedBlock);
  return out;
}

/**
 * Split an HTML string into `{title, bodyHtml}`. A full document is parsed with
 * `DOMParser` (present wherever `htmlToBlocks` runs — the webview and the
 * happy-dom test env), which correctly separates `<head><title>` from the body;
 * a bare fragment lands entirely in `body`. Falls back to a `<title>` regex + the
 * raw string when `DOMParser` is somehow absent (`htmlToBlocks` then parses the
 * fragment via its own `document`-based path).
 */
function splitHtml(html: string): {title?: string; bodyHtml: string} {
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const title = doc.querySelector('title')?.textContent?.trim() || undefined;
    return {title, bodyHtml: doc.body?.innerHTML ?? ''};
  }
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return {title: (m?.[1].trim() || undefined) ?? undefined, bodyHtml: html};
}

const plainText = (runs: ImportTextRun[] | undefined): string => (runs ?? []).map((r) => r.t).join('');

/**
 * Parse an HTML string into {@link ImportedBlock}s (images → visible
 * placeholders, unknown elements → text). Reusable wherever only the block list
 * is wanted (e.g. importing a fragment into an existing page).
 */
export function htmlToImportedBlocks(html: string): ImportedBlock[] {
  const {bodyHtml} = splitHtml(html ?? '');
  return htmlToBlocks(bodyHtml, {onImage: imageBlock}).map(toImportedBlock);
}

/**
 * Parse a full HTML document (or fragment) into an {@link ImportedDoc} (a single
 * page) ready for `importDoc`. The page title is resolved as:
 *
 *  1. `opts.title` (explicit), else
 *  2. the document's `<title>`, else
 *  3. a leading `<h1>` promoted to the title (consumed from the body) when
 *     `opts.firstHeadingAsTitle !== false`, else
 *  4. `opts.defaultTitle` (default `'Imported document'`).
 */
export function htmlToImportedDoc(html: string, opts: HtmlImportOptions = {}): ImportedDoc {
  const {title: docTitle, bodyHtml} = splitHtml(html ?? '');
  const blocks = htmlToBlocks(bodyHtml, {onImage: imageBlock}).map(toImportedBlock);

  let title = opts.title ?? docTitle;
  // Promote a leading top-level <h1> (not h2/h3) — the most predictable page
  // title, and what the docs describe.
  if (
    title === undefined &&
    opts.firstHeadingAsTitle !== false &&
    blocks[0]?.type === 'heading' &&
    (blocks[0].props as {level?: number} | undefined)?.level === 1
  ) {
    const headingText = plainText(blocks[0].text).trim();
    if (headingText !== '') {
      title = headingText;
      blocks.shift();
    }
  }
  title = title?.trim() || opts.defaultTitle || DEFAULT_TITLE;

  return {pages: [{title, blocks}]};
}

/** What {@link parseHtmlImport} produced: a lossless island restore, or the
 *  legacy DOM-converted IR for foreign HTML. */
export type ParsedHtmlImport =
  | {kind: 'island'; island: HtmlIsland; assets: Map<string, AssetBytes>; summary: IslandSummary}
  | {kind: 'doc'; doc: ImportedDoc};

/**
 * The single HTML-import entry point: scan for an OpenBook source island FIRST
 * (a pure string scan — see `islandImport.ts`), and only when the file has none
 * fall back to the lossy DOM conversion ({@link htmlToImportedDoc}). An OpenBook
 * export therefore re-imports losslessly (block-doc, structure, databases,
 * asset references intact), while foreign/legacy HTML routes exactly as before.
 */
export function parseHtmlImport(html: string, opts: HtmlImportOptions = {}): ParsedHtmlImport {
  const island = detectHtmlIsland(html ?? '');
  if (island) {
    return {kind: 'island', island, assets: readExportAssetMap(html), summary: summarizeHtmlIsland(island)};
  }
  return {kind: 'doc', doc: htmlToImportedDoc(html, opts)};
}
