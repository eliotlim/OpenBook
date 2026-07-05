import type {NewBlock} from './model';
import {assetBridge} from '@/lib/assetBridge';
import {MAX_ASSET_BYTES, isImageFile} from './imageBlock';

/**
 * HTML artifact block — ingest helpers.
 *
 * An `htmlArtifact` block renders an untrusted, self-contained HTML document
 * (an AI-generated widget, an exported chart, a hand-written demo) inside the
 * sandboxed-iframe renderer ({@link components/SandboxedHtml} — opaque origin,
 * never `allow-same-origin`). The document's bytes live in the content-
 * addressed asset store; the block carries only the returned `assetId`, so the
 * CRDT never holds the markup. Mirrors the image block's ingest contract
 * (imageBlock.ts): 10 MiB cap, `{block} | {error, soft?}` result, never throws.
 *
 * Unlike images there is NO inline fallback when the asset store is missing —
 * an HTML document belongs behind the page's read gate, not in the CRDT (which
 * every collaborator's client replicates in full), so ingest without a store is
 * a friendly hard error instead.
 */

/** The block `type` for a sandboxed HTML artifact. */
export const HTML_ARTIFACT_BLOCK_TYPE = 'htmlArtifact';

/** Props carried by an `htmlArtifact` block. */
export interface HtmlArtifactBlockProps {
  /** Asset store id (SHA-256 content hash) of the HTML document. */
  assetId?: string;
  /** Display title shown in the block's title bar (seeded from the file name). */
  title?: string;
  /** Frame height in CSS pixels (the resize handle persists it); unset = default. */
  height?: number;
}

/** Ingest result — same error surface as the image block. */
export type HtmlArtifactIngest = {block: NewBlock} | {error: string; soft?: boolean};

/** The friendly "too large" message for the uploaded-artifact (10 MiB) cap. */
export const HTML_ARTIFACT_TOO_LARGE_MESSAGE =
  'That HTML file is over 10 MB — the maximum size for an uploaded artifact.';

/** The friendly "no asset store" message (standalone editor / no page context). */
export const HTML_ARTIFACT_NO_STORE_MESSAGE =
  'HTML artifacts need this page’s asset storage, which isn’t available here.';

/**
 * Narrow to a usable HTML File. Checks the mime first; falls back to the file
 * extension because OS drag sources sometimes hand over `.html` files with an
 * empty `type`.
 */
export function isHtmlFile(file: File | null | undefined): file is File {
  if (!file) return false;
  if (typeof file.type === 'string' && file.type.split(';')[0] === 'text/html') return true;
  return typeof file.name === 'string' && /\.html?$/i.test(file.name);
}

/** A display title seed from a file name (`sales_dashboard.html` → `sales dashboard`). */
export function titleFromFileName(name: string): string {
  return name.replace(/\.[^./\\]+$/, '').replace(/[_-]+/g, ' ').trim();
}

/**
 * Pull the block-ingestible files (images + HTML documents) out of a drop /
 * paste DataTransfer, in transfer order, de-duplicated. Replaces the removed
 * image-only `imageFilesFromTransfer` as the one mixed-funnel extractor: the
 * caller routes each file by kind (image → image block, HTML → artifact block).
 */
export function editorFilesFromTransfer(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  const out: File[] = [];
  const seen = new Set<string>();
  const add = (f: File | null | undefined): void => {
    if (!isImageFile(f) && !isHtmlFile(f)) return;
    const key = `${f.name}:${f.size}:${f.type}:${f.lastModified}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };
  if (dt.files) for (let i = 0; i < dt.files.length; i += 1) add(dt.files[i]);
  if (out.length === 0 && dt.items) {
    for (let i = 0; i < dt.items.length; i += 1) {
      const item = dt.items[i];
      if (item.kind === 'file') add(item.getAsFile());
    }
  }
  return out;
}

/**
 * Ingest a File into an `htmlArtifact` block, or return a friendly error.
 * Uploads the bytes to the content-addressed store via the asset bridge (which
 * refs them to the hosting `pageId`) and keeps only the `assetId`. The store is
 * content-addressed, so re-ingesting byte-identical HTML dedups to the same id.
 *
 * The mime is pinned to `text/html` for the block's own bookkeeping; the server
 * intentionally coerces stored assets to `application/octet-stream` on read
 * (so a stored document can never be served executable from the app origin) —
 * the view re-types the bytes when it hands them to the sandboxed renderer.
 * Never throws — callers surface `error` to the user and move on.
 */
export async function htmlArtifactBlockFromFile(file: File, pageId?: string): Promise<HtmlArtifactIngest> {
  if (!isHtmlFile(file)) return {error: 'That file isn’t an HTML document.'};
  if (!pageId || !assetBridge.ready()) return {error: HTML_ARTIFACT_NO_STORE_MESSAGE};
  if (file.size > MAX_ASSET_BYTES) return {error: HTML_ARTIFACT_TOO_LARGE_MESSAGE, soft: true};
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return {error: 'Could not read that HTML file.'};
  }
  if (bytes.byteLength === 0) return {error: 'That HTML file is empty.'};
  try {
    const {id} = await assetBridge.putAsset(bytes, 'text/html', pageId);
    const props: HtmlArtifactBlockProps = {assetId: id};
    const title = titleFromFileName(file.name || '');
    if (title) props.title = title;
    return {block: {type: HTML_ARTIFACT_BLOCK_TYPE, props: props as unknown as Record<string, unknown>}};
  } catch (err) {
    // Same 413 mapping as images: base64 transport overhead can push a near-cap
    // file past the server body limit — surface the honest, soft too-large
    // message rather than a misleading "try again".
    if (err instanceof Error && /\b413\b/.test(err.message)) return {error: HTML_ARTIFACT_TOO_LARGE_MESSAGE, soft: true};
    return {error: 'Could not upload that HTML file. Please try again.'};
  }
}
