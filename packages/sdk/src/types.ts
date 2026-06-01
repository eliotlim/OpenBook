/**
 * OpenBook domain types — the single source of truth shared by the server, the
 * desktop app, and the web shell. Because every layer imports these same
 * definitions, page data cannot drift between client and server.
 *
 * A **page** is the unit of storage: a stable UUID, an optional unique name, and
 * an opaque document payload ({@link PageSnapshot}). The storage layer treats
 * `data` as opaque JSON; its internal shape is owned by the document editor.
 */

/**
 * The serialized form of a reactive document. Three sibling keys:
 *  - `editorjs` — EditorJS `OutputData` (kept opaque here so the SDK has no
 *    dependency on the editor; cast at the edit site).
 *  - `values`   — `[cellId, value]` pairs from the reactive store.
 *  - `names`    — `[name, cellId]` pairs (the name index).
 */
export interface PageSnapshot {
  editorjs: unknown;
  values: Array<[string, unknown]>;
  names: Array<[string, string]>;
}

/** An empty snapshot, for initializing a brand-new page. */
export const emptyPageSnapshot = (): PageSnapshot => ({
  editorjs: {blocks: []},
  values: [],
  names: [],
});

/** Lightweight page record for listings (no `data` payload). */
export interface PageMeta {
  id: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A full page as returned by the store. `data` is the document snapshot. */
export interface StoredPage {
  id: string;
  name: string | null;
  data: PageSnapshot;
  createdAt: string;
  updatedAt: string;
}

/**
 * Payload for creating/updating a page.
 *  - `id` present → upsert that page; absent → create with a fresh server id.
 *  - `name` optional; unique across the store when set.
 */
export interface PageInput {
  id?: string;
  name?: string | null;
  data: PageSnapshot;
}

/** Status of a desktop install's local server. */
export interface ServerInfo {
  running: boolean;
  address: string | null;
}
