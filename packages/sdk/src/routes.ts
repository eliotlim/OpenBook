/**
 * The HTTP contract shared by the server and clients. Keeping the paths in one
 * place means `HttpDataClient` and the server's router cannot disagree about
 * where a resource lives.
 */
export const API = {
  health: '/health',
  /** Collection: `GET` (list) / `POST` (create). */
  pages: '/api/pages',
  /** Single page: `GET` / `PUT` (upsert) / `DELETE`. */
  page: (id: string): string => `/api/pages/${encodeURIComponent(id)}`,
} as const;

/** Error body shape returned by the API for non-2xx responses. */
export interface ApiError {
  error: string;
}
