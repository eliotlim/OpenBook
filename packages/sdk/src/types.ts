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
  /** Which editor owns this document ('blocks' = the CRDT block editor). */
  editor?: string;
  /** CRDT block-editor document (opaque here; shaped by the ui package). */
  blockdoc?: unknown;
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
  /**
   * If this page *hosts* a database (contains a collection of row pages), the
   * id of that database; otherwise `null`. Lets the sidebar mark database
   * pages and the document area decide whether to render the database view.
   */
  hostedDatabaseId: string | null;
  /** The page this page is nested under, if any (drives the sidebar tree). */
  parentId: string | null;
  /**
   * When the page is in the trash (soft-deleted), the ISO timestamp it was
   * deleted; `null` for live pages. Trash listings carry this so the UI can
   * show how long ago each item was deleted.
   */
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A full page as returned by the store. `data` is the document snapshot. */
export interface StoredPage {
  id: string;
  name: string | null;
  data: PageSnapshot;
  /** The database this page *hosts*, if any (mirrors {@link PageMeta.hostedDatabaseId}). */
  hostedDatabaseId: string | null;
  /** The database this page is a *row* of, if any; `null` for ordinary pages. */
  databaseId: string | null;
  /** The page this page is nested under, if any. */
  parentId: string | null;
  /** Manual database-property values, keyed by property id (empty for non-rows). */
  properties: Record<string, unknown>;
  /** When the page is in the trash, the ISO timestamp it was deleted; else `null`. */
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Payload for creating/updating a page.
 *  - `id` present → upsert that page; absent → create with a fresh server id.
 *  - `name` optional; unique across the store when set.
 *
 * Note: a page's database membership (`databaseId`) and manual `properties` are
 * not set through this payload — they are managed by the database row APIs so a
 * routine content save never clobbers them.
 */
export interface PageInput {
  id?: string;
  name?: string | null;
  data: PageSnapshot;
  /**
   * The page to nest this new page under. Applied only when the page is first
   * created; a later content save with the same id leaves the parent untouched.
   */
  parentId?: string | null;
}

/** Status of a desktop install's local server. */
export interface ServerInfo {
  /** Whether the local server is currently running. */
  running: boolean;
  /** Bound base URL, when running. */
  address: string | null;
  /**
   * Whether the host process manages the local server lifecycle (true in the
   * packaged desktop app). When false (e.g. dev, or the web shell), the server
   * is external and start/stop are unavailable.
   */
  managed: boolean;
}

/**
 * Controls for the host-managed local server, provided by the platform layer
 * (the Tauri desktop app). Absent on the web, where there is no local server.
 */
export interface ServerControls {
  info(): Promise<ServerInfo>;
  start(): Promise<ServerInfo>;
  stop(): Promise<ServerInfo>;
}
