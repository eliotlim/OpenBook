/**
 * Pre-resolve block assets for the export pipeline (Assets A3 + artifacts).
 *
 * Every exporter (HTML / Markdown / PDF) is synchronous, but an `image` or
 * `htmlArtifact` block stores an `assetId` whose bytes live in the (async)
 * content-addressed asset store. So the export path resolves ALL referenced
 * assets up front — one `getAsset` per unique id, in parallel — into an
 * {@link ExportAssets} bundle the renderers look up synchronously:
 *
 *  - `images`: `assetId` → base64 `data:` URI (for `<img src>` / the PDF).
 *  - `artifactText`: `assetId` → the artifact's UTF-8 document TEXT. An HTML
 *    artifact is a text document destined for the export's assets island (see
 *    sdk island.ts) and the sandboxed viewer — a data-URI would just bloat it
 *    ~33% and force a decode on every consumer.
 *
 * A missing / failed asset is simply absent from its map, and each renderer
 * degrades to the block's placeholder (alt text / captioned artifact figure).
 *
 * A legacy A0 `data:` URL (or a plain remote URL) sitting in `props.src` needs no
 * resolution — the renderers use it directly; only `assetId`s are fetched here.
 */
import type {DataClient, PageSnapshot} from '@book.dev/sdk';
import {blockSnapshotToEditorJs} from '../blockeditor/exportBlocks';

/** Resolved image assets for one export: `assetId` → a base64 `data:` URI. */
export type AssetMap = Map<string, string>;

/** Everything the exporters need, resolved up front (see module doc). */
export interface ExportAssets {
  /** Image `assetId` → `data:` URI (visible body, document model, PDF). */
  images: AssetMap;
  /** `htmlArtifact` `assetId` → UTF-8 document text (assets island / viewer). */
  artifactText: Map<string, string>;
}

/** An empty resolution — for tests and asset-store-less callers. */
export const emptyExportAssets = (): ExportAssets => ({images: new Map(), artifactText: new Map()});

/**
 * Base64-encode bytes in 32 KiB chunks — `btoa(String.fromCharCode(...bytes))`
 * overflows the call stack past ~100k args; chunking is comfortable for a 10 MiB
 * asset. (Mirrors the SDK client's `bytesToBase64`.)
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Wrap asset bytes + mime as a self-contained `data:` URI for `<img src>`. */
export function bytesToDataUri(bytes: Uint8Array, mime: string): string {
  return `data:${mime || 'application/octet-stream'};base64,${bytesToBase64(bytes)}`;
}

interface EditorJsBlock {
  type?: string;
  data?: Record<string, unknown>;
}

interface CollectedIds {
  images: Set<string>;
  artifacts: Set<string>;
}

/** Walk projected EditorJS blocks (recursing `columns`) collecting asset ids
 *  by KIND — an image's bytes become a data-URI, an artifact's become text. */
function collectFromBlocks(blocks: EditorJsBlock[], out: CollectedIds): void {
  for (const block of blocks) {
    const d = block.data ?? {};
    if (typeof d.assetId === 'string' && d.assetId) {
      if (block.type === 'image') out.images.add(d.assetId);
      else if (block.type === 'htmlArtifact') out.artifacts.add(d.assetId);
    }
    if (block.type === 'columns' && Array.isArray(d.columns)) {
      for (const col of d.columns as EditorJsBlock[][]) collectFromBlocks(Array.isArray(col) ? col : [], out);
    }
  }
}

/** The asset ids referenced by a page snapshot, by kind (block docs projected
 *  first). The content-addressed store can in principle hand the SAME id to an
 *  image and an artifact, so an id may appear in both sets. */
export function collectExportAssetIds(rawSnapshot: PageSnapshot): CollectedIds {
  const snapshot = blockSnapshotToEditorJs(rawSnapshot);
  const blocks = (snapshot.editorjs as {blocks?: EditorJsBlock[]} | undefined)?.blocks ?? [];
  const out: CollectedIds = {images: new Set(), artifacts: new Set()};
  collectFromBlocks(blocks, out);
  return out;
}

/** Every asset id referenced by a page snapshot (both kinds, deduplicated). */
export function collectAssetIds(rawSnapshot: PageSnapshot): string[] {
  const {images, artifacts} = collectExportAssetIds(rawSnapshot);
  return [...new Set([...images, ...artifacts])];
}

/**
 * Resolve every asset referenced across `snapshots`: images to `data:` URIs,
 * artifact documents to UTF-8 text. One `getAsset` per unique id, in parallel;
 * a missing / failed fetch is left out of its map so the renderers degrade to
 * the block's placeholder (never crash). Safe to call with a client whose
 * asset store is unavailable — returns empty maps.
 */
export async function resolveExportAssets(
  client: Pick<DataClient, 'getAsset'> | null | undefined,
  snapshots: PageSnapshot[],
): Promise<ExportAssets> {
  const out = emptyExportAssets();
  if (!client?.getAsset) return out;
  const images = new Set<string>();
  const artifacts = new Set<string>();
  for (const s of snapshots) {
    const ids = collectExportAssetIds(s);
    for (const id of ids.images) images.add(id);
    for (const id of ids.artifacts) artifacts.add(id);
  }
  await Promise.all(
    [...new Set([...images, ...artifacts])].map(async (id) => {
      try {
        const asset = await client.getAsset(id);
        if (!asset) return;
        if (images.has(id)) out.images.set(id, bytesToDataUri(asset.bytes, asset.mime));
        if (artifacts.has(id)) out.artifactText.set(id, new TextDecoder('utf-8').decode(asset.bytes));
      } catch {
        /* unreachable / read-gated asset — degrade to the placeholder */
      }
    }),
  );
  return out;
}
