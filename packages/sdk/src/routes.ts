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
   * Live collaboration — incremental update ingest (Collab T1). `POST` an opaque
   * base64 Yjs update `{update, clientId}`; the server fans it out to readers as a
   * `yupdate` firehose frame (write-gated in, read-gated out) and folds it into an
   * in-memory relay doc so a late joiner can catch up — but persists NOTHING. The
   * debounced snapshot save (`PUT /api/pages/:id`) remains the sole durable
   * checkpoint, so the relay is a best-effort live nudge, never a system of record.
   */
  pageUpdates: (id: string): string => `/api/pages/${encodeURIComponent(id)}/updates`,
  /**
   * Live collaboration — late-joiner sync handshake (Collab T1). `POST {sv}` (the
   * client's base64 Yjs state vector); the server replies `{update}` with exactly
   * the ops the client is missing, computed from the relay doc (seeded from the
   * durable snapshot + every relayed update since). Read-gated. This is what lets a
   * client that connects mid-session converge to the CURRENT doc, not just future
   * edits.
   */
  pageSync: (id: string): string => `/api/pages/${encodeURIComponent(id)}/sync`,
  /**
   * Live collaboration — ephemeral awareness/presence (Collab T4). `POST` a base64
   * `y-protocols/awareness` update `{update, clientId}` to publish this client's
   * presence (cursor / selection); the server **re-stamps the identity** from the
   * verified principal (so name/colour can't be spoofed via the body) and fans it
   * out to readers as an `awareness` firehose frame. Unlike `/updates` this is
   * **read-gated** — a viewer (read, not write) appears present, the T6 "viewers
   * broadcast presence" behaviour. `GET` returns the current presence snapshot
   * (`{updates: base64[]}`) so a late joiner sees who's here immediately. Persists
   * NOTHING — never in the durable snapshot, never in the edit log.
   */
  pageAwareness: (id: string): string => `/api/pages/${encodeURIComponent(id)}/awareness`,
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
  /** The agent harness: `POST` `{messages, effort?, thinking?, skills?}` → SSE tool/reasoning/proposal/final events. */
  agentChat: '/api/agent/chat',
  /** User-authored prompt/recipe skills: `GET` (list) / `PUT` `{skill}` (upsert). */
  aiSkills: '/api/ai/skills',
  /** One skill by name: `DELETE`. */
  aiSkill: (name: string) => `/api/ai/skills/${encodeURIComponent(name)}`,
  /** Usage-attribution pricing (admin only): `GET` (default+override merged) /
   *  `PUT` `{[provider]:{[model]:{inputPerMtok,outputPerMtok}}}` (set override). */
  aiPricing: '/api/ai/pricing',
  /** Usage-attribution viewer (admin only): `GET` returns `{exists, databaseId,
   *  hostPageId, retentionDays, rows?, totals?}`. Never seeds the usage DB (a
   *  fresh workspace reports `exists:false`). */
  aiUsage: '/api/ai/usage',
  /** Admin retention setter for the AI usage database: `PUT` `{days}` → updates
   *  the usage DB's auto-expiry window. */
  aiUsageRetention: '/api/ai/usage/retention',
  plugins: '/api/plugins',
  plugin: (id: string) => `/api/plugins/${id}`,

  // ── Assets: content-addressed binary store (OB-ASSETS) ───────────────────────
  /**
   * Upload an asset: `POST /api/assets?pageId=<id>`. The body is the raw binary
   * (its `Content-Type` header is the stored mime), or — for the in-webview
   * transports whose bridge corrupts raw binary — a JSON `{data: base64, mime}`.
   * Write-gated to `pageId` (a page the uploader can write); the asset is ref'd to
   * that page so it's immediately reachable. 10 MiB cap (413 past it). Returns
   * `{id}` — the SHA-256 content hash (byte-identical uploads dedup to one id).
   */
  assets: '/api/assets',
  /**
   * Fetch an asset by its content-hash id. `GET /api/assets/:id` serves the raw
   * binary with the stored `Content-Type`; `?encoding=base64` returns a JSON
   * `{id, mime, size, data: base64}` for the in-webview transports. **Read-gated**:
   * served only to a caller who can read at least one page that references the
   * asset — otherwise 404 (no existence oracle).
   */
  asset: (id: string): string => `/api/assets/${encodeURIComponent(id)}`,

  // ── Suggestions + comments (the review layer) ────────────────────────────────
  /** A page's suggestions: `GET` (list, optionally `?status=open`) / `POST` (create). */
  suggestions: (pageId: string): string => `/api/pages/${encodeURIComponent(pageId)}/suggestions`,
  /** A single suggestion: `PATCH` (status: accepted/rejected) / `DELETE`. */
  suggestion: (id: string): string => `/api/suggestions/${encodeURIComponent(id)}`,
  /** A page's comments (standalone block comments + suggestion threads): `GET` / `POST` (create). */
  comments: (pageId: string): string => `/api/pages/${encodeURIComponent(pageId)}/comments`,
  /** A single comment: `DELETE`. */
  comment: (id: string): string => `/api/comments/${encodeURIComponent(id)}`,

  /**
   * On-demand heavy database compaction (`POST`): VACUUM FULL to physically
   * reclaim heap bloat. Embedded (PGlite) only — a server backed by external
   * Postgres answers 409. See OB-164.
   */
  compact: '/api/maintenance/compact',

  // ── Multi-user (identity, policy, provenance) — OB-165 ───────────────────────
  /**
   * Instance multi-user policy: `GET` returns {@link InstanceInfo} (guest
   * policy, trusted issuer URLs, and the principal resolved for *this* request);
   * `PUT` updates the policy (owner only).
   */
  instance: '/api/instance',
  /** A page's change provenance (the edit log), newest first: `GET`. */
  pageEdits: (id: string): string => `/api/pages/${encodeURIComponent(id)}/edits`,

  // ── Sharing: roster invites + per-page ACL — OB-191 ──────────────────────────
  /**
   * The member roster: `GET` (list) / `POST` (invite by email or handle/subject).
   * Instance-writer (owner/admin/loopback) only — managing or even seeing the
   * roster is a privileged action.
   */
  members: '/api/members',
  /** A single roster row: `PATCH` (role/status) / `DELETE` (revoke). */
  member: (id: string): string => `/api/members/${encodeURIComponent(id)}`,
  /**
   * A page's per-page ACL grants: `GET` (list) / `POST` (share to an email or
   * handle/subject) / `DELETE` (`?subject=` | `?email=` to revoke). Gated on
   * write of the page itself (you manage sharing of pages you can write).
   */
  pageAcl: (id: string): string => `/api/pages/${encodeURIComponent(id)}/acl`,
  /**
   * A page's audience-scope visibility (OB-182 §1.1): `GET` returns
   * `{visibility}` (read-gated); `PUT` `{visibility}` sets it (write-gated — same
   * "you manage sharing of pages you can write" rule as the ACL).
   */
  pageVisibility: (id: string): string => `/api/pages/${encodeURIComponent(id)}/visibility`,

  // ── Managed workspace: instance ↔ workspace roster sync — OB-199 ─────────────
  /**
   * On-demand roster sync of a managed instance: `GET` reports the binding +
   * last-sync status; `POST` pulls the bound workspace roster from the account and
   * reconciles it into the local roster (managed rows only). Instance-writer
   * (owner/admin/loopback) only. The same sync also runs periodically.
   */
  workspaceSync: '/api/workspace/sync',

  // ── Scheduled backups — OB-166 ───────────────────────────────────────────────
  /** Scheduled-backup policy: `GET` returns {@link BackupStatus}; `PUT` updates
   *  the policy and returns the new status. */
  backups: '/api/backups',
  /** Run a backup immediately: `POST` `{cadence?}` → the written file's name. */
  backupRun: '/api/backups/run',
} as const;

/** Result of a {@link API.compact} run: the database's on-disk size before/after,
 *  in bytes, and how much was reclaimed. */
export interface CompactResult {
  before: number;
  after: number;
  reclaimed: number;
}

/** Error body shape returned by the API for non-2xx responses. */
export interface ApiError {
  error: string;
}
