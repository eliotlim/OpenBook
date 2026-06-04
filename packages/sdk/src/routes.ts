/**
 * The HTTP contract shared by the server and clients. Keeping the paths in one
 * place means `HttpDataClient` and the server's router cannot disagree about
 * where a resource lives.
 */
export const API = {
  health: '/health',
  /** Collection: `GET` (list) / `POST` (create). */
  pages: '/api/pages',
  /** Single page: `GET` / `PUT` (upsert) / `PATCH` (rename) / `DELETE`. */
  page: (id: string): string => `/api/pages/${encodeURIComponent(id)}`,
  /** SSE stream of the page list (created / renamed / deleted). */
  stream: '/api/stream',
  /** SSE stream of a single page's live updates + deletion. */
  pageStream: (id: string): string => `/api/pages/${encodeURIComponent(id)}/stream`,

  // ── Databases ──────────────────────────────────────────────────────────────
  /** Collection: `POST` (create a database for a host page). */
  databases: '/api/databases',
  /** Single database: `GET` / `PATCH` (name + schema) / `DELETE`. */
  database: (id: string): string => `/api/databases/${encodeURIComponent(id)}`,
  /** The database hosted by a page: `GET` (or 404 if the page hosts none). */
  pageDatabase: (pageId: string): string => `/api/pages/${encodeURIComponent(pageId)}/database`,
  /** A database's rows: `GET` (list) / `POST` (create a row page). */
  databaseRows: (id: string): string => `/api/databases/${encodeURIComponent(id)}/rows`,
  /** A single row: `PATCH` (title + manual properties). Row content/deletion use the page routes. */
  databaseRow: (id: string, rowId: string): string =>
    `/api/databases/${encodeURIComponent(id)}/rows/${encodeURIComponent(rowId)}`,
  /** SSE stream of a database's row list (any row created / edited / deleted). */
  databaseStream: (id: string): string => `/api/databases/${encodeURIComponent(id)}/stream`,
} as const;

/** Error body shape returned by the API for non-2xx responses. */
export interface ApiError {
  error: string;
}
