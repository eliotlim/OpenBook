/**
 * The UI-side glue for the SDK importers (T1 `importDoc`, T2
 * `markdownToImportedDoc`, T4 `notionExportToImportedDoc`). Pure and DOM-free —
 * the dialog reads the file bytes/text from the picker and hands them here, so
 * format detection, parsing, the IR walk for a preview/result summary, and the
 * `importDoc` wiring are all unit-testable without React.
 *
 * Format is detected from the filename extension (the only honest signal we have
 * before reading): a `.zip` is a Notion *Markdown & CSV* export → the Notion
 * adapter; a `.md`/`.markdown`/`.txt` is a Markdown document → the Markdown
 * parser; a `.html`/`.htm` is an HTML document → the HTML parser. Every adapter
 * honours the "never silently drop content" contract — an image becomes a visible
 * placeholder rather than vanishing — so the summary counts placeholders to
 * report honestly what degraded.
 *
 * **HTML is main-thread only.** Notion/Markdown parse to the IR with no DOM, so
 * they run in the import Web Worker (`importParseCore`) off the main thread. HTML
 * is DOM-bound — it reuses the editor's `htmlToBlocks` clipboard converter, which
 * needs a live `document`/`DOMParser` the worker lacks — so it is parsed by the
 * dialog on the main thread (`htmlToImportedDoc` in `htmlImport.ts`) and is
 * deliberately NOT part of {@link ImportSource} / {@link parseImportSource}, which
 * are the worker-serialised formats. A single HTML document is light, so an
 * inline parse (like pasted Markdown) is fine.
 */
import {
  importDoc,
  markdownToImportedDoc,
  notionExportToImportedDoc,
  rehydrateImageUrls,
  rehydrateStoredImages,
  IMAGE_PLACEHOLDER_PROP,
  type ImportAssetResolver,
  type ImportedBlock,
  type ImportedDoc,
  type ImportedPage,
  type ImportedRow,
  type ImportWriteClient,
  type ImportWriteResult,
  type PageMeta,
  type RehydrateStoredClient,
} from '@book.dev/sdk';

/** The source formats the dialog can ingest. */
export type ImportFormat = 'notion-zip' | 'markdown' | 'html';

const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt']);
const HTML_EXTS = new Set(['.html', '.htm']);

/** The trailing `.ext` of a filename, lower-cased (`''` when none). */
function extOf(fileName: string): string {
  const m = /\.[^./\\]+$/.exec(fileName.toLowerCase());
  return m ? m[0] : '';
}

/**
 * Detect the import format from a filename's extension — a `.zip` is a Notion
 * export, a Markdown extension is a Markdown document, an `.html`/`.htm` is an
 * HTML document. Returns `null` for anything we can't ingest, so the caller can
 * show a friendly "unsupported file" message instead of guessing.
 */
export function detectImportFormat(fileName: string): ImportFormat | null {
  const ext = extOf(fileName);
  if (ext === '.zip') return 'notion-zip';
  if (MARKDOWN_EXTS.has(ext)) return 'markdown';
  if (HTML_EXTS.has(ext)) return 'html';
  return null;
}

/** A document title derived from a filename: drop the extension, tidy separators. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[/\\]/, '').replace(/\.[^.]+$/, '');
  return base.replace(/[_-]+/g, ' ').trim();
}

/** A flat, honest tally of what an {@link ImportedDoc} will land. */
export interface ImportSummary {
  pages: number;
  databases: number;
  rows: number;
  /** Image placeholders — assets import v1 keeps as visible markers, not files. */
  images: number;
}

/** Walk every block in a tree (children included), counting image placeholders. */
function countImagesInBlocks(blocks: ImportedBlock[] | undefined, acc: ImportSummary): void {
  for (const block of blocks ?? []) {
    if (block.props && block.props[IMAGE_PLACEHOLDER_PROP] !== undefined) acc.images += 1;
    countImagesInBlocks(block.children, acc);
  }
}

function countRows(rows: ImportedRow[], acc: ImportSummary): void {
  for (const row of rows) {
    acc.rows += 1;
    countImagesInBlocks(row.blocks, acc);
    if (row.children && row.children.length > 0) countRows(row.children, acc);
  }
}

function summarizePage(page: ImportedPage, acc: ImportSummary): void {
  acc.pages += 1;
  countImagesInBlocks(page.blocks, acc);
  if (page.database) {
    acc.databases += 1;
    countRows(page.database.rows, acc);
  }
  for (const child of page.children ?? []) summarizePage(child, acc);
}

/**
 * Tally the pages, databases, rows, and image placeholders in a parsed doc —
 * the basis for both the pre-import preview ("ready to import …") and the
 * post-import result line. Pure: a straight structural walk of the IR.
 */
export function summarizeImportedDoc(doc: ImportedDoc): ImportSummary {
  const acc: ImportSummary = {pages: 0, databases: 0, rows: 0, images: 0};
  for (const page of doc.pages) summarizePage(page, acc);
  return acc;
}

/** A picked source, already read off disk into the form its parser wants. */
export type ImportSource =
  | {format: 'notion-zip'; bytes: Uint8Array; fileName: string}
  | {format: 'markdown'; text: string; fileName?: string};

/**
 * Parse a picked source into the format-agnostic IR. Re-throws each parser's
 * failure as a friendly `Error` (the Notion adapter already says "not a
 * readable Notion export zip"; an unreadable zip should read as a message, not
 * a stack), so the dialog can surface it verbatim and never crash.
 */
export function parseImportSource(source: ImportSource): ImportedDoc {
  if (source.format === 'notion-zip') {
    try {
      return notionExportToImportedDoc(source.bytes);
    } catch (e) {
      throw new Error((e as Error)?.message || 'That file isn’t a readable Notion export zip.');
    }
  }
  // Markdown: lenient by design (unknown constructs degrade to text), so this
  // effectively never throws — but a filename gives the page a sensible title.
  return markdownToImportedDoc(source.text, {
    defaultTitle: source.fileName ? titleFromFileName(source.fileName) || undefined : undefined,
  });
}

/** Options controlling how imported images are rehydrated (Assets A4). */
export interface RunImportAssetOptions {
  /**
   * Resolve a still-placeholder image `ref` to its bytes for upload — a Notion zip
   * ({@link notionAssetResolver}) or, with {@link downloadUrls}, a URL fetcher
   * ({@link urlAssetResolver}). Absent → no bytes are uploaded (URL/`data:` images
   * still become real image blocks via the pure pre-pass).
   */
  resolveAssetBytes?: ImportAssetResolver;
  /**
   * Opt in to downloading `http(s)` linked images into the asset store (default
   * off — a linked image is preserved as a URL image block that loads from the
   * web). Requires {@link resolveAssetBytes}.
   */
  downloadUrls?: boolean;
  /** Per-asset byte cap (default 10 MiB); an over-cap image stays a placeholder. */
  maxAssetBytes?: number;
  /** Progress over the upload pass (pages processed / total). */
  onAssetProgress?: (done: number, total: number) => void;
}

/**
 * Run the actual import via the SDK core (strategy is chosen inside `importDoc`),
 * rehydrating imported image placeholders into real image blocks (Assets A4):
 *
 *  1. **Pre-pass** ({@link rehydrateImageUrls}) — pure, before landing: a URL /
 *     `data:` image placeholder becomes a real `image` block (URLs preserved as
 *     links unless {@link RunImportAssetOptions.downloadUrls} opts into storing a
 *     copy). The page lands already carrying real images.
 *  2. **Upload pass** ({@link rehydrateStoredImages}) — after landing, for the
 *     pages that still hold a placeholder (Notion zip images / opt-in URL
 *     downloads): resolve the bytes, `putAsset`, and rewrite to an `assetId`
 *     image block. Skipped when no resolver is given or nothing needs bytes.
 *
 * Degrades safely throughout (an unresolved / over-cap image keeps its ref), so
 * `pickImportedJumpTarget` still sees the same `result.pageIds`.
 */
export async function runImport(
  client: ImportWriteClient,
  doc: ImportedDoc,
  opts: RunImportAssetOptions = {},
): Promise<ImportWriteResult> {
  const prepared = rehydrateImageUrls(doc, {
    preserveHttpUrls: !opts.downloadUrls,
    maxDataBytes: opts.maxAssetBytes,
  });
  const result = await importDoc(client, prepared);
  if (opts.resolveAssetBytes && result.placeholderPageIds.length > 0) {
    await rehydrateStoredImages(
      client as unknown as RehydrateStoredClient,
      result.placeholderPageIds,
      opts.resolveAssetBytes,
      {maxAssetBytes: opts.maxAssetBytes, onProgress: opts.onAssetProgress},
    );
  }
  return result;
}

/**
 * The page to offer a "view imported" jump to — a **genuine top-level page,
 * never a database row**. Resolved against the post-import navigation list
 * (`pages`), not the write result's id order: the store builds that list with
 * `database_id IS NULL` (rows are excluded by construction), so any id present
 * there is already a real page, and `parentId === null` further narrows it to a
 * root. `result.pageIds` (which, for a bundle, includes every re-keyed id —
 * rows too) is used only as the membership filter, so a row id in it can never
 * be picked. Returns `null` when nothing top-level landed.
 */
export function pickImportedJumpTarget(result: Pick<ImportWriteResult, 'pageIds'>, pages: PageMeta[]): string | null {
  const imported = new Set(result.pageIds);
  return pages.find((p) => p.parentId === null && imported.has(p.id))?.id ?? null;
}
