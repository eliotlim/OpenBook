/**
 * Pre-resolve image-block assets for the export pipeline (Assets A3).
 *
 * Every exporter (HTML / Markdown / PDF) is synchronous, but an `image` block
 * stores an `assetId` whose bytes live in the (async) content-addressed asset
 * store. So the export path resolves ALL referenced assets up front — one
 * `getAsset` per unique id, in parallel — into a `Map<assetId, data-URI>` that
 * the renderers look up synchronously. A missing / failed asset is simply absent
 * from the map, and each renderer degrades to the block's alt text.
 *
 * A legacy A0 `data:` URL (or a plain remote URL) sitting in `props.src` needs no
 * resolution — the renderers use it directly; only `assetId`s are fetched here.
 */
import type {DataClient, PageSnapshot} from '@book.dev/sdk';
import {blockSnapshotToEditorJs} from '../blockeditor/exportBlocks';

/** Resolved image assets for one export: `assetId` → a base64 `data:` URI. */
export type AssetMap = Map<string, string>;

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

/** Walk projected EditorJS blocks (recursing `columns`) collecting image assetIds. */
function collectFromBlocks(blocks: EditorJsBlock[], out: Set<string>): void {
  for (const block of blocks) {
    const d = block.data ?? {};
    if (block.type === 'image' && typeof d.assetId === 'string' && d.assetId) out.add(d.assetId);
    if (block.type === 'columns' && Array.isArray(d.columns)) {
      for (const col of d.columns as EditorJsBlock[][]) collectFromBlocks(Array.isArray(col) ? col : [], out);
    }
  }
}

/** The image `assetId`s referenced by a page snapshot (projecting block docs first). */
export function collectAssetIds(rawSnapshot: PageSnapshot): string[] {
  const snapshot = blockSnapshotToEditorJs(rawSnapshot);
  const blocks = (snapshot.editorjs as {blocks?: EditorJsBlock[]} | undefined)?.blocks ?? [];
  const out = new Set<string>();
  collectFromBlocks(blocks, out);
  return [...out];
}

/**
 * Resolve every image asset referenced across `snapshots` to a `data:` URI. One
 * `getAsset` per unique id, in parallel; a missing / failed fetch is left out of
 * the map so the renderers degrade to alt text (never crash). Safe to call with a
 * client whose asset store is unavailable — returns an empty map.
 */
export async function resolveExportAssets(
  client: Pick<DataClient, 'getAsset'> | null | undefined,
  snapshots: PageSnapshot[],
): Promise<AssetMap> {
  const map: AssetMap = new Map();
  if (!client?.getAsset) return map;
  const ids = new Set<string>();
  for (const s of snapshots) for (const id of collectAssetIds(s)) ids.add(id);
  await Promise.all(
    [...ids].map(async (id) => {
      try {
        const asset = await client.getAsset(id);
        if (asset) map.set(id, bytesToDataUri(asset.bytes, asset.mime));
      } catch {
        /* unreachable / read-gated asset — degrade to alt text */
      }
    }),
  );
  return map;
}
