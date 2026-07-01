import type {NewBlock} from './model';
import {assetBridge} from '@/lib/assetBridge';

/**
 * Native image block — ingest helpers (Assets A2).
 *
 * The block now stores an **`assetId`** pointing at the content-addressed asset
 * store (A1) rather than an inline `data:` URL: {@link imageBlockFromFile}
 * uploads the file bytes via the asset bridge and keeps only the returned id, so
 * the CRDT never carries the picture. When no asset backend is wired up (the
 * editor rendered standalone, or a test with no data client) it falls back to the
 * A0 inline `data:` URL in `src`, size-capped to protect the CRDT. The view reads
 * `assetId` first (resolving it to an object URL) and still renders a legacy
 * `src` data-URL directly (back-compat); {@link dataUrlToBytes} powers the lazy
 * data-URL → assetId migration those legacy blocks get on load.
 */

/** The block `type` for a native image. */
export const IMAGE_BLOCK_TYPE = 'image';

/**
 * Hard cap on an uploaded asset (10 MiB) — matches the server's asset bodyLimit.
 * A client-side pre-check so an oversize file fails fast with a friendly message
 * rather than reading + POSTing megabytes only for the server to 413.
 */
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;

/**
 * Hard cap on the FALLBACK embedded data-URL string (~1 MiB). Only used when no
 * asset store is available — the primary path uploads (10 MiB) and stores an
 * assetId. Data URLs live inside the CRDT, so we never want it to carry a
 * megabyte of base64 per image; oversize files are rejected in that fallback.
 */
export const MAX_IMAGE_DATA_URL_BYTES = 1024 * 1024;

/** Props carried by an `image` block. */
export interface ImageBlockProps {
  /**
   * The asset store id (SHA-256 content hash) of the picture — the primary form
   * (Assets A2). The view resolves it to an object URL through the asset bridge.
   */
  assetId?: string;
  /**
   * Legacy inline picture: a `data:` URL (Assets A0), or the fallback form when
   * no asset store is wired up. A block that still holds one renders it directly
   * and is lazily migrated to `assetId` on load.
   */
  src?: string;
  /** Accessibility description (also the broken-image fallback text). */
  alt?: string;
  /** Visible caption shown below the image. */
  caption?: string;
  /** Rendered width as a CSS length (e.g. `"60%"`); unset = natural width. */
  width?: string;
}

/**
 * A successful ingest yields a block; a rejected one, a user-facing message.
 * `soft: true` marks a temporary/size limit rather than a hard failure — the UI
 * gives it a muted/info tone instead of destructive red.
 */
export type ImageIngest = {block: NewBlock} | {error: string; soft?: boolean};

/** Narrow to a usable image File. */
export function isImageFile(file: File | null | undefined): file is File {
  return !!file && typeof file.type === 'string' && file.type.startsWith('image/');
}

/**
 * Pull image files out of a paste/drop DataTransfer. Prefers `.files` (drops and
 * most pastes), falling back to `.items[].getAsFile()` (some clipboard pastes
 * only expose the image through items). De-duplicates so a transfer that lists
 * the same file in both places yields one block.
 */
export function imageFilesFromTransfer(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  const out: File[] = [];
  const seen = new Set<string>();
  const add = (f: File | null | undefined): void => {
    if (!isImageFile(f)) return;
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

/** Read a File to a `data:` URL (works without canvas/createImageBitmap). */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

/** Byte length of a string (data URLs are ASCII, but be exact for the cap). */
export function dataUrlByteLength(s: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length;
}

/** Is this a `data:` URL — the legacy A0 inline form (vs an assetId / remote URL)? */
export function isDataUrl(s: string | null | undefined): s is string {
  return typeof s === 'string' && s.startsWith('data:');
}

/** The mime of a `data:<mime>[;base64],…` URL (defaults to octet-stream). */
export function dataUrlMime(dataUrl: string): string {
  const m = /^data:([^;,]+)/.exec(dataUrl);
  return m && m[1] ? m[1] : 'application/octet-stream';
}

/**
 * Decode a base64 `data:` URL to raw bytes, or `null` if it isn't a base64 data
 * URL. Used by the lazy legacy-block migration to recover an image's bytes from
 * the inline `src` so they can be uploaded to the asset store.
 */
export function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const meta = dataUrl.slice(0, comma);
  if (!/;base64/i.test(meta)) return null; // only base64 data URLs carry binary
  try {
    const binary = atob(dataUrl.slice(comma + 1));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** A reasonable default alt/caption seed from a file name (`my_photo.png` → `my photo`). */
export function altFromFileName(name: string): string {
  return name.replace(/\.[^./\\]+$/, '').replace(/[_-]+/g, ' ').trim();
}

/** The friendly "too large" message shown when a file exceeds the fallback cap. */
export const IMAGE_TOO_LARGE_MESSAGE =
  'That image is over 1 MB — inline images are capped for now. A proper asset store is coming soon.';

/** The friendly "too large" message for the uploaded-asset (10 MiB) cap. */
export const ASSET_TOO_LARGE_MESSAGE = 'That image is over 10 MB — the maximum size for an uploaded image.';

/**
 * Ingest a File into an `image` block, or return a friendly error. The primary
 * path uploads the bytes to the asset store (via the asset bridge) and stores the
 * returned `assetId` — this needs the hosting `pageId` (the asset refs to it) and
 * an installed bridge. Without either, it falls back to an inline `data:` URL in
 * `src`, size-capped to protect the CRDT. Rejects non-images; never throws —
 * callers surface `error` to the user and move on.
 */
export async function imageBlockFromFile(file: File, pageId?: string): Promise<ImageIngest> {
  if (!isImageFile(file)) return {error: 'That file isn’t an image.'};

  // Preferred path (Assets A2): upload to the content-addressed store, keep only
  // the assetId in the block — the CRDT never carries the picture.
  if (pageId && assetBridge.ready()) {
    if (file.size > MAX_ASSET_BYTES) return {error: ASSET_TOO_LARGE_MESSAGE, soft: true};
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      return {error: 'Could not read that image.'};
    }
    if (bytes.byteLength === 0) return {error: 'That image is empty.'};
    try {
      const {id} = await assetBridge.putAsset(bytes, file.type || 'application/octet-stream', pageId);
      const props: ImageBlockProps = {assetId: id};
      const alt = altFromFileName(file.name || '');
      if (alt) props.alt = alt;
      return {block: {type: IMAGE_BLOCK_TYPE, props: props as unknown as Record<string, unknown>}};
    } catch (err) {
      // A 413 means the server rejected it as too large (base64 overhead can push
      // a near-cap raw image past the body limit) — surface the honest, soft
      // too-large message rather than a misleading "try again". Anything else is a
      // transient upload failure worth retrying.
      if (err instanceof Error && /\b413\b/.test(err.message)) return {error: ASSET_TOO_LARGE_MESSAGE, soft: true};
      return {error: 'Could not upload that image. Please try again.'};
    }
  }

  // Fallback (no asset backend / no page context): inline data-URL, size-capped
  // to keep the CRDT from carrying a large base64 blob (the A0 phase-1 behaviour).
  // Cheap pre-check: base64 inflates a file by ~4/3, so anything past 3/4 of the
  // cap is guaranteed to bust it — reject BEFORE encoding a huge file.
  if (file.size > MAX_IMAGE_DATA_URL_BYTES * 0.75) return {error: IMAGE_TOO_LARGE_MESSAGE, soft: true};
  let src: string;
  try {
    src = await fileToDataUrl(file);
  } catch {
    return {error: 'Could not read that image.'};
  }
  if (!src.startsWith('data:image/')) return {error: 'That file isn’t an image.'};
  if (dataUrlByteLength(src) > MAX_IMAGE_DATA_URL_BYTES) return {error: IMAGE_TOO_LARGE_MESSAGE, soft: true};
  const props: ImageBlockProps = {src};
  const alt = altFromFileName(file.name || '');
  if (alt) props.alt = alt;
  return {block: {type: IMAGE_BLOCK_TYPE, props: props as unknown as Record<string, unknown>}};
}
