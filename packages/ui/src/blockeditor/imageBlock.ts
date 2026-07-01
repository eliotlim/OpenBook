import type {NewBlock} from './model';

/**
 * Native image block — ingest helpers (Assets A0, data-URL phase-1).
 *
 * Phase-1 stores the picture inline as a `data:` URL in the block's `src` prop.
 * That keeps the block self-contained and independently shippable, but a data
 * URL lives inside the CRDT, so we CAP it hard (see {@link MAX_IMAGE_DATA_URL_BYTES})
 * and refuse anything larger with a friendly message. A later phase (Assets A2)
 * swaps `src` for an `assetId` pointing at a real store; keeping all the src
 * plumbing behind `ImageBlockProps.src` is the seam that makes that swap local.
 */

/** The block `type` for a native image. */
export const IMAGE_BLOCK_TYPE = 'image';

/**
 * Hard cap on the embedded data-URL string (~1 MiB, matching the relay's body
 * cap). Data URLs are transitional — we never want the CRDT to carry a megabyte
 * of base64 per image, so oversize files are rejected until the asset store
 * (Assets A1/A2) lands.
 */
export const MAX_IMAGE_DATA_URL_BYTES = 1024 * 1024;

/** Props carried by an `image` block. Phase-1: `src` is a `data:` URL. */
export interface ImageBlockProps {
  /**
   * The picture. A `data:` URL in phase-1; Assets A2 migrates this to an
   * `assetId` that resolves through the asset store. Everything reads `src`, so
   * that migration only has to change how `src` is produced/resolved.
   */
  src: string;
  /** Accessibility description (also the broken-image fallback text). */
  alt?: string;
  /** Visible caption shown below the image. */
  caption?: string;
  /** Rendered width as a CSS length (e.g. `"60%"`); unset = natural width. */
  width?: string;
}

/**
 * A successful ingest yields a block; a rejected one, a user-facing message.
 * `soft: true` marks a temporary phase-1 limit (the size cap) rather than a hard
 * failure — the UI gives it a muted/info tone instead of destructive red.
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

/** A reasonable default alt/caption seed from a file name (`my_photo.png` → `my photo`). */
export function altFromFileName(name: string): string {
  return name.replace(/\.[^./\\]+$/, '').replace(/[_-]+/g, ' ').trim();
}

/** The friendly "too large" message shown when a file exceeds the phase-1 cap. */
export const IMAGE_TOO_LARGE_MESSAGE =
  'That image is over 1 MB — inline images are capped for now. A proper asset store is coming soon.';

/**
 * Ingest a File into an `image` block, or return a friendly error. Rejects
 * non-images and anything whose data URL would blow the phase-1 CRDT cap. Never
 * throws — callers surface `error` to the user and move on.
 */
export async function imageBlockFromFile(file: File): Promise<ImageIngest> {
  if (!isImageFile(file)) return {error: 'That file isn’t an image.'};
  // Cheap pre-check: base64 inflates a file by ~4/3, so anything past 3/4 of the
  // data-URL cap is guaranteed to bust it — reject BEFORE encoding a huge file.
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
