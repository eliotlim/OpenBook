/**
 * **Import asset rehydration (Assets A4).** Turns the image *placeholders* the
 * importers emit (see `import.ts` {@link imagePlaceholderBlock}) into real,
 * rendering `image` blocks — the payoff of OB-ASSETS: an imported picture comes
 * through for real, not as a callout.
 *
 * Two seams, because the bytes arrive two very different ways:
 *
 *  - **URL / `data:` images (Markdown · HTML).** These already carry a loadable
 *    source, so no upload is needed — {@link rehydrateImageUrls} rewrites the
 *    placeholder to an `image` block whose `src` is the original URL (kept as a
 *    link) or the inline `data:` URL (which the editor's A2 on-load migration
 *    then stores). Pure, DOM-free, no client — runnable *before* the doc is
 *    landed, so the page lands already-correct.
 *
 *  - **Embedded bytes (Notion zip · opt-in URL download).** A Notion export holds
 *    every image's bytes inside the zip; there is no URL to render. So — *after*
 *    the page is created (we need its id to ref the asset's read-gate) —
 *    {@link rehydrateStoredImages} resolves each placeholder's `ref` to bytes,
 *    `putAsset`s them, and rewrites the placeholder to an `image` block holding
 *    the returned `assetId`. Content-addressed dedup makes a re-import idempotent.
 *
 * **Never lose the reference.** If the bytes are missing, over the 10 MiB cap, or
 * the upload fails, the block degrades rather than dropping: a loadable URL is
 * preserved as a URL `image` block; anything else keeps its original placeholder
 * (ref + alt intact). A big import's uploads are processed with bounded
 * concurrency so the UI is never blocked, and only pages that actually contain a
 * placeholder are re-read/re-saved (the writers report them in
 * `ImportWriteResult.placeholderPageIds`).
 */

import {unzipSync} from 'fflate';
import {IMAGE_PLACEHOLDER_PROP, type ImportedBlock, type ImportedDoc, type ImportedPage, type ImportedRow} from './import';
import type {PageInput, PageSnapshot, StoredPage} from './types';

/** The `image` block type — the native picture block the editor ships (A0/A2). */
export const IMAGE_BLOCK_TYPE = 'image';

/**
 * Hard cap on an uploaded asset (10 MiB) — matches the server's asset bodyLimit
 * (`app.ts` `ASSET_MAX_BYTES`). An import image over this stays a placeholder
 * rather than failing the whole import.
 */
export const DEFAULT_MAX_ASSET_BYTES = 10 * 1024 * 1024;

/**
 * Mime types an asset may be STORED and SERVED as (everything else is coerced
 * to `application/octet-stream`, which — with `nosniff` + attachment
 * disposition on the served response — can never execute). Single-sourced here
 * (LGR-15) so the upload door (`app.ts` `safeAssetMime`) and the backup-restore
 * door (`store.ts`) can never drift: an allowlist that exists twice is an
 * allowlist that will eventually disagree. Grow this list (never add
 * `svg+xml`, never `text/html`) if v2 serves more types.
 */
export const ASSET_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/apng',
]);

// ── ref classification ───────────────────────────────────────────────────────

const HTTP_RE = /^https?:\/\//i;

/** Is this an `http(s)` URL — a picture the `image` block can render from `src`? */
export const isHttpUrl = (s: string): boolean => HTTP_RE.test(s);

/** Is this a `data:` URL — inline bytes the editor can render (and A2 migrates)? */
export const isDataUrlRef = (s: string): boolean => /^data:/i.test(s);

/** A loadable source (URL or inline data) the `image` block renders directly. */
const isLoadableSrc = (s: string): boolean => isHttpUrl(s) || isDataUrlRef(s);

/** Rough decoded byte size of a `data:` URL (base64 → 3/4; else the char count). */
function dataUrlRawBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  const payload = dataUrl.slice(comma + 1);
  return /;base64/i.test(dataUrl.slice(0, comma)) ? Math.floor((payload.length * 3) / 4) : payload.length;
}

// ── mime from a ref ──────────────────────────────────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
};

/** Guess an image mime from a ref's file extension (defaults to octet-stream). */
export function mimeFromRef(ref: string): string {
  const clean = ref.split('#')[0].split('?')[0];
  const dot = clean.lastIndexOf('.');
  const ext = dot >= 0 ? clean.slice(dot + 1).toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

// ── placeholder → image block ────────────────────────────────────────────────

/** The structured asset preserved on a placeholder block (see `imagePlaceholderBlock`). */
interface PlaceholderMeta {
  ref?: string;
  alt?: string;
  title?: string;
}

/** Read the {@link PlaceholderMeta} off a block, or `undefined` if it isn't a placeholder. */
export function imagePlaceholderMeta(block: ImportedBlock): PlaceholderMeta | undefined {
  return block.props?.[IMAGE_PLACEHOLDER_PROP] as PlaceholderMeta | undefined;
}

/**
 * Rewrite an image *placeholder* into a real `image` block, carrying either the
 * uploaded `assetId` or a renderable `src`. The placeholder's `alt` becomes the
 * image alt, its `title` the caption; the deterministic block id is kept so the
 * rewrite is stable across re-imports.
 */
export function importedImageBlock(placeholder: ImportedBlock, target: {assetId: string} | {src: string}): ImportedBlock {
  const meta = imagePlaceholderMeta(placeholder) ?? {};
  const props: Record<string, unknown> = {...target};
  if (meta.alt) props.alt = meta.alt;
  if (meta.title) props.caption = meta.title;
  const block: ImportedBlock = {type: IMAGE_BLOCK_TYPE, props};
  if (placeholder.id) block.id = placeholder.id;
  return block;
}

// ── Pass 1: URL / data: preserve (pure, pre-import) ──────────────────────────

/** Options for {@link rehydrateImageUrls}. */
export interface RehydrateUrlOptions {
  /**
   * Rewrite an `http(s)` image placeholder into a URL `image` block (default
   * `true`). Set `false` to *keep* it a placeholder so a later
   * {@link rehydrateStoredImages} pass can download the bytes into the store
   * (the opt-in "download into library" flow).
   */
  preserveHttpUrls?: boolean;
  /**
   * Rewrite a `data:` placeholder into an inline `image` block when its decoded
   * size is within this many bytes (default 10 MiB). An over-cap `data:` image
   * stays a placeholder so the CRDT never carries a huge base64 blob.
   */
  maxDataBytes?: number;
}

/** Convert an image placeholder to an `image` block when its ref is directly
 *  loadable; otherwise leave it (recursing container children). */
function preserveBlock(block: ImportedBlock, preserveHttp: boolean, maxData: number): ImportedBlock {
  const meta = imagePlaceholderMeta(block);
  if (meta?.ref) {
    const ref = meta.ref;
    if (isHttpUrl(ref) && preserveHttp) return importedImageBlock(block, {src: ref});
    if (isDataUrlRef(ref) && dataUrlRawBytes(ref) <= maxData) return importedImageBlock(block, {src: ref});
    return block; // relative / zip-path / over-cap data: → leave for the upload pass
  }
  if (block.children && block.children.length > 0) {
    return {...block, children: block.children.map((c) => preserveBlock(c, preserveHttp, maxData))};
  }
  return block;
}

const preserveRow = (row: ImportedRow, preserveHttp: boolean, maxData: number): ImportedRow => ({
  ...row,
  ...(row.blocks ? {blocks: row.blocks.map((b) => preserveBlock(b, preserveHttp, maxData))} : {}),
  ...(row.children ? {children: row.children.map((c) => preserveRow(c, preserveHttp, maxData))} : {}),
});

const preservePage = (page: ImportedPage, preserveHttp: boolean, maxData: number): ImportedPage => ({
  ...page,
  blocks: page.blocks.map((b) => preserveBlock(b, preserveHttp, maxData)),
  ...(page.children ? {children: page.children.map((c) => preservePage(c, preserveHttp, maxData))} : {}),
  ...(page.database
    ? {database: {...page.database, rows: page.database.rows.map((r) => preserveRow(r, preserveHttp, maxData))}}
    : {}),
});

/**
 * **Pass 1 (pure).** Rewrite every image placeholder whose ref is a directly
 * loadable source — an `http(s)` URL (preserved as a link) or an in-cap `data:`
 * URL — into a real `image` block, throughout the doc (pages, children, database
 * rows). No client, no I/O: run this on the IR *before* landing it so the page
 * arrives already carrying real images. Idempotent (an `image` block isn't a
 * placeholder, so a re-run is a no-op).
 */
export function rehydrateImageUrls(doc: ImportedDoc, opts: RehydrateUrlOptions = {}): ImportedDoc {
  const preserveHttp = opts.preserveHttpUrls !== false;
  const maxData = opts.maxDataBytes ?? DEFAULT_MAX_ASSET_BYTES;
  return {pages: doc.pages.map((p) => preservePage(p, preserveHttp, maxData))};
}

// ── Pass 2: byte upload (post-import) ────────────────────────────────────────

/** An asset's raw bytes plus its mime, as resolved for upload. */
export interface AssetBytes {
  bytes: Uint8Array;
  mime: string;
}

/**
 * Resolve a placeholder's `ref` to its bytes for upload, or `null` when the
 * bytes are unavailable (missing / not fetchable). May be async (a network
 * fetch). {@link notionAssetResolver} and {@link urlAssetResolver} build one.
 */
export type ImportAssetResolver = (ref: string) => AssetBytes | null | Promise<AssetBytes | null>;

/** The slice of the data client {@link rehydrateStoredImages} drives. */
export interface RehydrateStoredClient {
  getPage(id: string): Promise<StoredPage | null>;
  savePage(input: PageInput): Promise<StoredPage>;
  putAsset(bytes: Uint8Array, mime: string, pageId: string): Promise<{id: string}>;
}

/** Options for {@link rehydrateStoredImages}. */
export interface RehydrateStoredOptions {
  /** Skip (keep as placeholder) any image whose bytes exceed this (default 10 MiB). */
  maxAssetBytes?: number;
  /**
   * Max total in-flight uploads at once (default 4) — a single shared budget
   * across every page, so an image-dense page can't fan out N uploads and flood
   * the socket. Also caps how many pages are walked concurrently.
   */
  concurrency?: number;
  /** Progress callback: pages processed / total (so the UI can show a live count). */
  onProgress?: (done: number, total: number) => void;
}

/** What a stored-image pass did, for honest reporting. */
export interface RehydrateStoredResult {
  /** Placeholders uploaded to the store and rewritten to an `assetId` image block. */
  uploaded: number;
  /** Placeholders degraded to a URL `image` block (bytes unavailable but ref loadable). */
  preservedUrls: number;
  /** Placeholders left untouched (over-cap / no bytes / not loadable) — ref never lost. */
  keptPlaceholders: number;
}

/** Run `fn` through a shared slot budget (a simple async semaphore). */
type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/** Build a limiter that keeps at most `max` calls in flight at once (FIFO queue). */
function createLimiter(max: number): Limiter {
  let active = 0;
  const queue: Array<() => void> = [];
  const pump = (): void => {
    if (active >= max) return;
    const run = queue.shift();
    if (!run) return;
    active += 1;
    run();
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            pump();
          });
      });
      pump();
    });
}

/** Rehydrate a single page's placeholder blocks in place (recursing children). */
async function rehydratePage(
  client: RehydrateStoredClient,
  pageId: string,
  resolve: ImportAssetResolver,
  maxBytes: number,
  stats: RehydrateStoredResult,
  limit: Limiter,
): Promise<void> {
  let page: StoredPage | null;
  try {
    page = await client.getPage(pageId);
  } catch {
    return; // a page we can't read — skip, never crash the import
  }
  if (!page) return;
  const blockdoc = page.data?.blockdoc as {blocks?: ImportedBlock[]} | undefined;
  const blocks = blockdoc?.blocks;
  if (!blocks || blocks.length === 0) return;

  let changed = false;
  // Resolve + upload one placeholder. Run through the shared `limit` so total
  // in-flight uploads stay bounded regardless of how many images a page holds
  // (an image-dense page must not fan out N uploads at once and flood the socket).
  const rehydrateOne = async (block: ImportedBlock, ref: string): Promise<ImportedBlock> => {
    let resolved: AssetBytes | null = null;
    try {
      resolved = await resolve(ref);
    } catch {
      resolved = null;
    }
    if (resolved && resolved.bytes.byteLength > 0 && resolved.bytes.byteLength <= maxBytes) {
      try {
        const {id} = await client.putAsset(resolved.bytes, resolved.mime, pageId);
        changed = true;
        stats.uploaded += 1;
        return importedImageBlock(block, {assetId: id});
      } catch {
        // Upload failed (transient / 413) — fall through to the degrade paths.
      }
    }
    // Degrade without dropping: a loadable ref survives as a URL/data image
    // block; anything else keeps its placeholder (ref + alt intact). An over-cap
    // `data:` blob is NOT re-inlined — Pass 1 excluded it to protect the CRDT.
    if (isLoadableSrc(ref) && !(isDataUrlRef(ref) && dataUrlRawBytes(ref) > maxBytes)) {
      changed = true;
      stats.preservedUrls += 1;
      return importedImageBlock(block, {src: ref});
    }
    stats.keptPlaceholders += 1;
    return block;
  };
  const mapBlock = async (block: ImportedBlock): Promise<ImportedBlock> => {
    const meta = imagePlaceholderMeta(block);
    if (meta?.ref) {
      const ref = meta.ref;
      return limit(() => rehydrateOne(block, ref));
    }
    if (block.children && block.children.length > 0) {
      const kids = await Promise.all(block.children.map(mapBlock));
      return {...block, children: kids};
    }
    return block;
  };

  const next = await Promise.all(blocks.map(mapBlock));
  if (!changed) return;
  const data: PageSnapshot = {...page.data, blockdoc: {...(blockdoc ?? {}), blocks: next}};
  try {
    await client.savePage({id: page.id, name: page.name, data});
  } catch {
    // A failed re-save leaves the placeholders in place — degraded, not lost.
  }
}

/**
 * **Pass 2 (post-import).** For each page id carrying an image placeholder (the
 * writers report these in `ImportWriteResult.placeholderPageIds`), resolve every
 * placeholder's bytes and — within the size cap — `putAsset` + rewrite it to an
 * `assetId` `image` block, then re-save the page. A single shared limiter caps
 * total in-flight uploads (across all pages and all images) so a large,
 * image-dense import streams rather than flooding the socket. Degrades safely
 * (never loses a ref); idempotent (a re-run finds real images, not placeholders,
 * and content-addressed dedup returns the same `assetId`).
 */
export async function rehydrateStoredImages(
  client: RehydrateStoredClient,
  pageIds: string[],
  resolve: ImportAssetResolver,
  opts: RehydrateStoredOptions = {},
): Promise<RehydrateStoredResult> {
  const maxBytes = opts.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const stats: RehydrateStoredResult = {uploaded: 0, preservedUrls: 0, keptPlaceholders: 0};
  const ids = [...new Set(pageIds)];
  if (ids.length === 0) return stats;

  // ONE limiter shared across every page: it caps total in-flight uploads, so an
  // image-dense page can't fan out N `putAsset`s at once (which would flood the
  // IPC socket / server), independent of how pages/images are distributed.
  const limit = createLimiter(concurrency);
  let cursor = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (cursor < ids.length) {
      const pageId = ids[cursor];
      cursor += 1;
      await rehydratePage(client, pageId, resolve, maxBytes, stats, limit);
      done += 1;
      opts.onProgress?.(done, ids.length);
    }
  };
  await Promise.all(Array.from({length: Math.min(concurrency, ids.length)}, worker));
  return stats;
}

// ── Resolvers ────────────────────────────────────────────────────────────────

/**
 * Build a resolver over a Notion export zip: a placeholder `ref` (rewritten by
 * {@link notionExportToImportedDoc} to the absolute in-zip path) → its bytes +
 * a mime guessed from the extension. Unzips lazily on first use (the import may
 * land no images), and answers `null` for a ref with no matching entry.
 */
export function notionAssetResolver(zipBytes: Uint8Array): ImportAssetResolver {
  let entries: Record<string, Uint8Array> | null = null;
  const ensure = (): Record<string, Uint8Array> => {
    if (!entries) {
      try {
        entries = unzipSync(zipBytes);
      } catch {
        entries = {};
      }
    }
    return entries;
  };
  return (ref: string) => {
    const bytes = ensure()[ref];
    if (!bytes) return null;
    return {bytes, mime: mimeFromRef(ref)};
  };
}

/** The `fetch`-shaped surface {@link urlAssetResolver} needs (so it's testable with a fake). */
export type FetchLike = (
  url: string,
) => Promise<{ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; headers: {get(name: string): string | null}}>;

/**
 * Build a resolver that downloads an `http(s)` image `ref` into bytes — the
 * opt-in "store a copy of each linked image" path. Uses the ambient `fetch` when
 * no impl is passed. Answers `null` (→ the URL is preserved as a link) for a
 * non-http ref, a non-OK response, an empty body, or any fetch error — a slow /
 * failing / cross-origin link degrades rather than breaking the import.
 */
export function urlAssetResolver(fetchImpl?: FetchLike): ImportAssetResolver {
  const doFetch = fetchImpl ?? (typeof fetch !== 'undefined' ? (fetch as unknown as FetchLike) : null);
  return async (ref: string) => {
    if (!isHttpUrl(ref) || !doFetch) return null;
    try {
      const res = await doFetch(ref);
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength === 0) return null;
      const headerMime = res.headers?.get('content-type')?.split(';')[0]?.trim();
      const mime = headerMime && headerMime.startsWith('image/') ? headerMime : mimeFromRef(ref);
      return {bytes, mime};
    } catch {
      return null;
    }
  };
}
