/**
 * The viewer bundle's public data contract — the two JSON shapes OpenBook
 * exports already produce, accepted structurally (no runtime dependency on
 * the sdk types so the bundle's surface stays self-describing):
 *
 * - {@link IslandPageJson}: the canonical single-page island a `.book.html`
 *   file embeds (`packages/sdk/src/bookfile.ts` — `{version,id,name,icon,
 *   updatedAt,data}` where `data` is a `PageSnapshot` carrying `blockdoc`).
 * - {@link SpaceBundleJson}: the whole-space `openbook.space.json` bundle
 *   (`packages/sdk/src/bookFolder.ts` — `{pages,databases}`), for site
 *   exports; the viewer adds minimal hash-based page navigation over it.
 */

/** The subset of a `PageSnapshot` the viewer reads. Extra keys pass through. */
export interface ViewerPageData {
  /** `'blocks'` for native block-docs (the only editor since the EditorJS retirement). */
  editor?: string;
  /** The block-doc snapshot: `{v:1, update: base64-Y-update, blocks: JSON projection}`. */
  blockdoc?: unknown;
  [key: string]: unknown;
}

/** One page, normalised from either source shape. */
export interface ViewerPage {
  id: string;
  name: string | null;
  icon: string | null;
  data: ViewerPageData;
}

/** The single-page JSON island a `.book.html` export embeds. */
export interface IslandPageJson {
  version?: number;
  id: string;
  name?: string | null;
  icon?: string | null;
  updatedAt?: string;
  data: ViewerPageData;
}

/** A page inside the space bundle (`StoredPage`, read structurally). */
export interface SpaceBundlePage {
  id: string;
  name?: string | null;
  parentId?: string | null;
  position?: number;
  properties?: Record<string, unknown>;
  updatedAt?: string;
  data: ViewerPageData;
}

/** The whole-space `openbook.space.json` bundle shape. */
export interface SpaceBundleJson {
  pages: SpaceBundlePage[];
  /** Databases are carried for losslessness but not rendered by the viewer (yet). */
  databases?: unknown[];
}

export type ViewerSource = IslandPageJson | SpaceBundleJson;

/**
 * One asset's bytes in the mount payload — the same entry shape as the export
 * assets island (sdk `ExportAssetEntry`): `utf8` carries text (HTML artifact
 * documents), `base64` carries binary (images harvested from the static body's
 * data-URIs). The boot script assembles this record; asset-referencing blocks
 * (images, HTML artifacts) resolve through it instead of the app asset store.
 */
export interface ViewerAssetEntry {
  mime: string;
  encoding: 'utf8' | 'base64';
  data: string;
}

export interface ViewerMountOptions {
  /** Initial page for a space bundle: a page id (preferred) or exact name. */
  page?: string;
  /** Pre-resolved asset bytes by assetId (see {@link ViewerAssetEntry}). */
  assets?: Record<string, ViewerAssetEntry>;
}

export interface ViewerHandle {
  /** Tear the viewer down and release the container. */
  unmount(): void;
}
