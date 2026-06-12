/**
 * The HTTP contract shared by the server and clients. Keeping the paths in one
 * place means `HttpDataClient` and the server's router cannot disagree about
 * where a resource lives.
 */
export const API = {
  health: '/health',
  /** Collection: `GET` (list) / `POST` (create). */
  pages: '/api/pages',
  /** Single page: `GET` / `PUT` (upsert) / `PATCH` (rename) / `DELETE` (to trash). */
  page: (id: string): string => `/api/pages/${encodeURIComponent(id)}`,
  /** A page's structured properties (owner, verification, …): `PATCH` (shallow merge). */
  pageProperties: (id: string): string => `/api/pages/${encodeURIComponent(id)}/properties`,
  /** Pages that link to this one (the backlink graph): `GET`. */
  pageBacklinks: (id: string): string => `/api/pages/${encodeURIComponent(id)}/backlinks`,
  /** Restore a trashed page (and the subtree trashed with it): `POST`. */
  pageRestore: (id: string): string => `/api/pages/${encodeURIComponent(id)}/restore`,
  /** Move/reorder a page in the sidebar tree (re-parent + reorder siblings): `PUT`. */
  pageMove: (id: string): string => `/api/pages/${encodeURIComponent(id)}/move`,
  /** Whole-space backup: `GET` returns every live page + database as one bundle. */
  exportSpace: '/api/export',
  /** Restore a backup: `POST` `{pages, databases, mode}` → import summary. */
  importSpace: '/api/import',
  /** The trash: `GET` (list trashed pages) / `DELETE` (empty the whole trash). */
  trash: '/api/trash',
  /** A single trashed page: `DELETE` (permanently purge it and its subtree). */
  trashItem: (id: string): string => `/api/trash/${encodeURIComponent(id)}`,
  /** SSE stream of the page list (created / renamed / deleted). */
  stream: '/api/stream',
  /** SSE stream of a single page's live updates + deletion. */
  pageStream: (id: string): string => `/api/pages/${encodeURIComponent(id)}/stream`,
  /**
   * The multiplexed live stream: one SSE connection carrying every event (page
   * list, page updates/deletions, database rows). Clients open exactly one of
   * these per tab and filter by the ids they care about, so an open tab costs a
   * single connection regardless of how many pages/databases it watches.
   */
  live: '/api/live',

  // ── Databases ──────────────────────────────────────────────────────────────
  /** Collection: `POST` (create a database for a host page). */
  databases: '/api/databases',
  /** Single database: `GET` / `PATCH` (name + schema) / `DELETE`. */
  database: (id: string): string => `/api/databases/${encodeURIComponent(id)}`,
  /** The database hosted by a page: `GET` (or 404 if the page hosts none). */
  pageDatabase: (pageId: string): string => `/api/pages/${encodeURIComponent(pageId)}/database`,
  /** A database's rows: `GET` (list) / `POST` (create a row page). */
  databaseRows: (id: string): string => `/api/databases/${encodeURIComponent(id)}/rows`,
  /** Set the manual row order: `PUT` `{orderedIds}`. */
  databaseRowsOrder: (id: string): string => `/api/databases/${encodeURIComponent(id)}/rows/order`,
  /** A single row: `PATCH` (title + manual properties). Row content/deletion use the page routes. */
  databaseRow: (id: string, rowId: string): string =>
    `/api/databases/${encodeURIComponent(id)}/rows/${encodeURIComponent(rowId)}`,
  /** SSE stream of a database's row list (any row created / edited / deleted). */
  databaseStream: (id: string): string => `/api/databases/${encodeURIComponent(id)}/stream`,

  // ── Optional local AI ──────────────────────────────────────────────────────
  /** Engine status (provider, readiness, index state, download progress): `GET`. */
  aiStatus: '/api/ai/status',
  /** Engine configuration: `PUT` `{provider, model?, baseUrl?, autoStart?}`. */
  aiConfig: '/api/ai/config',
  /** (Re)build the note-search index: `POST`. */
  aiIndex: '/api/ai/index',
  /** Search notes: `POST` `{query, limit?}` → ranked results + snippets. */
  aiSearch: '/api/ai/search',
  /** Stream a completion: `POST` `{prompt, system?, maxTokens?}` → SSE. */
  aiGenerate: '/api/ai/generate',
  /** Break a goal into actionable tasks: `POST` `{goal, context?}`. */
  aiTasks: '/api/ai/tasks',
  /** Continue/complete document text: `POST` `{text, instruction?}` → SSE. */
  aiComplete: '/api/ai/complete',
  /** Download a model file for the in-process engine: `POST` `{url?}`. */
  aiModelDownload: '/api/ai/models/download',
  /** The agent harness: `POST` `{messages}` → SSE tool/final events. */
  agentChat: '/api/agent/chat',
  plugins: '/api/plugins',
  plugin: (id: string) => `/api/plugins/${id}`,
} as const;

/** Error body shape returned by the API for non-2xx responses. */
export interface ApiError {
  error: string;
}
