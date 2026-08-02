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
  /**
   * The whole-library page-link graph — every readable page as a node, plus every
   * mention/relation edge whose both endpoints are readable: `GET`. Edges are
   * derived on the fly (no persisted edge table). Read-gated per principal like
   * the page list; a guest passes the STAB-8 read gate. Returns {@link PageGraph}.
   */
  pageGraph: '/api/page-graph',
  /** Restore a trashed page (and the subtree trashed with it): `POST`. */
  pageRestore: (id: string): string => `/api/pages/${encodeURIComponent(id)}/restore`,
  /** A page's captured version history (PVH-1): `GET` (metadata list, newest first;
   *  optional `?limit=`). Read-gated on the page — a caller who can't read the page
   *  can't list its versions. */
  pageVersions: (id: string): string => `/api/pages/${encodeURIComponent(id)}/versions`,
  /** One captured version WITH its snapshot payload: `GET` (or 404 if it isn't that
   *  page's version). Read-gated on the page. */
  pageVersion: (id: string, versionId: string): string =>
    `/api/pages/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`,
  /** Roll the page back to a captured version: `POST` (writes the version's snapshot
   *  back through the save path, which captures the pre-restore state as a new version
   *  → non-destructive). Write-gated on the page. Returns the restored page. */
  pageVersionRestore: (id: string, versionId: string): string =>
    `/api/pages/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`,
  /** Move/reorder a page in the sidebar tree (re-parent + reorder siblings): `PUT`. */
  pageMove: (id: string): string => `/api/pages/${encodeURIComponent(id)}/move`,
  /** Whole-space backup: `GET` returns every live page + database as one bundle. */
  exportLibrary: '/api/export',
  /** Restore a backup: `POST` `{pages, databases, mode}` → import summary. */
  importLibrary: '/api/import',
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
  /**
   * External tools (MCP client) config (admin only): `GET` returns
   * {@link McpConfigResponse} (redacted config + `stdioAllowed`); `PUT`
   * `{enabled, servers}` merges it (write-only auth tokens preserved/replaced/
   * cleared) and returns the redacted result. Managing external tool servers is
   * host command-execution territory — gated by `requireInstanceAdmin`. */
  aiMcp: '/api/ai/mcp',
  /** Dry-run one MCP server config (admin only): `POST` a {@link McpServerConfig}
   *  → {@link McpTestResult} (connect + list tools; never returns secrets). */
  aiMcpTest: '/api/ai/mcp/test',
  /** User-authored prompt/recipe skills: `GET` (list) / `PUT` `{skill}` (upsert). */
  aiSkills: '/api/ai/skills',
  /** One skill by name: `DELETE`. */
  aiSkill: (name: string) => `/api/ai/skills/${encodeURIComponent(name)}`,
  /** Usage-attribution pricing (admin only): `GET` (default+override merged) /
   *  `PUT` `{[provider]:{[model]:{inputPerMtok,outputPerMtok}}}` (set override). */
  aiPricing: '/api/ai/pricing',
  /** Usage-attribution viewer (admin only): `GET` returns `{exists, databaseId,
   *  hostPageId, retentionDays, rows?, totals?}`. Never seeds the usage DB (a
   *  fresh library reports `exists:false`). */
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
  /**
   * A page's agent-edits policy (AGED-1): `GET` returns `{agentEdits, effective}` —
   * the raw stored policy (`inherit` | `suggest` | `direct`, read-gated) plus the
   * SERVER-RESOLVED `effective` mode (`suggest` | `direct`; AGED-6), so a PAT client
   * can learn the effective mode of an `inherit` page without the privileged instance
   * read. `PUT` `{agentEdits}` sets it. Unlike visibility, the `PUT` is jws-only — an
   * agent PAT must NOT change the policy that governs whether agents edit directly
   * (self-authorization).
   */
  pageAgentEdits: (id: string): string => `/api/pages/${encodeURIComponent(id)}/agent-edits`,

  // ── Managed library: instance ↔ library roster sync — OB-199 / LIB-5 ─────────
  /**
   * On-demand roster sync of a managed instance: `GET` reports the binding +
   * last-sync status; `POST` pulls the bound library roster from the account and
   * reconciles it into the local roster (managed rows only). Instance-writer
   * (owner/admin/loopback) only. The same sync also runs periodically.
   */
  librarySync: '/api/library/sync',
  /**
   * Legacy alias of {@link librarySync} (LIB-5 renamed `/api/workspace/sync` →
   * `/api/library/sync`). Kept live so a not-yet-updated caller still resolves;
   * both paths hit the same handler. Retire only in the last, reversible phase.
   *
   * @deprecated Wire residue — removal target **v3.0.0** (see `docs/wire-sunset.md`).
   * Use {@link librarySync} (`/api/library/sync`). DO NOT delete before v3.0.0: an
   * un-updatable client may still POST this path. Before cutover, confirm no caller
   * hits `/api/workspace/sync` (the server logs a dev-only warning when it does).
   */
  workspaceSync: '/api/workspace/sync',

  // ── Scheduled backups — OB-166 ───────────────────────────────────────────────
  /** Scheduled-backup policy: `GET` returns {@link BackupStatus}; `PUT` updates
   *  the policy and returns the new status. */
  backups: '/api/backups',
  /** Run a backup immediately: `POST` `{cadence?}` → the written file's name. */
  backupRun: '/api/backups/run',

  // ── Agent access: PAT credential management (AGENT-6) ─────────────────────────
  /**
   * Agent Personal-Access-Token management (admin only — `requireInstanceAdmin`;
   * a PAT can never reach this route, both by `requireInstanceAdmin` and the
   * scope-gate). `GET` → `{enabled, tokens}` (redacted list + the `agentApi`
   * on/off state); `PUT` `{enabled}` toggles the dark `agentApi` setting; `POST`
   * `{name, scope?, expiresInDays?}` mints a token (404 while `agentApi` is off) and
   * returns the plaintext exactly ONCE. */
  agentTokens: '/api/agent-tokens',
  /** Revoke one agent token by id: `DELETE`. `true` if one was removed. */
  agentToken: (id: string): string => `/api/agent-tokens/${encodeURIComponent(id)}`,
  /**
   * Remote streamable-HTTP MCP transport (AGENT-5 — handler built separately).
   * Declared here so the AGENT-6 scope-gate can allowlist it; harmless until the
   * handler is mounted. */
  mcp: '/api/mcp',

  // ── Ledger: server-enforced double-entry accounting (LGR-3) ──────────────────
  /**
   * The ledger itself: `GET` reports {@link LedgerInfo} (whether the four managed
   * ledger databases are seeded, and where); `POST` seeds them (idempotent —
   * a re-POST adopts the existing databases). All ledger reads/writes are gated on
   * the restricted host page's access; the seeded databases REJECT every generic
   * page/row mutation (server-managed) — only these ledger routes write them.
   */
  ledger: '/api/ledger',
  /** Accounts: `GET` (list) / `POST` (create — hierarchical colon-delimited name). */
  ledgerAccounts: '/api/ledger/accounts',
  /** One account: `GET` / `PATCH` (rename; close — rejected at nonzero balance). */
  ledgerAccount: (id: string): string => `/api/ledger/accounts/${encodeURIComponent(id)}`,
  /** Transactions: `GET` (list, `?state=&limit=`) / `POST` (create a DRAFT with postings). */
  ledgerTransactions: '/api/ledger/transactions',
  /** One transaction (with postings): `GET` / `PATCH` (draft only) / `DELETE` (draft only). */
  ledgerTransaction: (id: string): string => `/api/ledger/transactions/${encodeURIComponent(id)}`,
  /**
   * Post a draft atomically: `POST`. Validates Σ amount = 0, ≥2 postings, open
   * resolvable accounts, integer amounts, uniform currency; assigns the
   * server-monotonic entry number and stamps posted_at/posted_by — all in ONE
   * store transaction with the audit event.
   */
  ledgerTransactionPost: (id: string): string => `/api/ledger/transactions/${encodeURIComponent(id)}/post`,
  /**
   * Reverse a posted transaction: `POST`. Atomically creates AND posts the
   * reversing entry (negated postings, `reverses` linked) and marks the original
   * `void` — the only sanctioned way to void a posted entry.
   */
  ledgerTransactionReverse: (id: string): string => `/api/ledger/transactions/${encodeURIComponent(id)}/reverse`,
  /** A posting's cleared state: `PUT` `{cleared}` (pending ↔ cleared only;
   *  anything touching `reconciled` is locked until reconciliation flows, LGR-11). */
  ledgerPostingCleared: (id: string): string => `/api/ledger/postings/${encodeURIComponent(id)}/cleared`,
  /**
   * Statement reconciliations (LGR-11): `GET` lists them (`?accountId=&status=`),
   * `POST` STARTS one (`{accountId, statementDate, statementBalanceMinor}`).
   * Starting a second OPEN reconciliation on the same account is rejected —
   * two open matches against one account cannot both be the truth.
   */
  ledgerReconciliations: '/api/ledger/reconciliations',
  /**
   * One reconciliation: `GET` returns the {@link LedgerReconciliationSummary}
   * (cleared balance + difference); `PATCH` AMENDS the statement it is matched
   * against (`{statementDate?, statementBalanceMinor?}` — LGR-22), which is the
   * recovery path for a mistyped closing balance. Allowed only while `open`
   * (409 `invalid-state` otherwise), touches no posting's cleared state, and
   * returns the summary with the difference RECOMPUTED against the new target.
   * There is no `DELETE`: a reconciliation ends by being finished or abandoned,
   * both of which leave a record.
   */
  ledgerReconciliation: (id: string): string => `/api/ledger/reconciliations/${encodeURIComponent(id)}`,
  /**
   * Match/unmatch ONE posting inside an OPEN reconciliation: `PUT` `{cleared}`
   * (`pending` ↔ `cleared`). Unlike {@link API.ledgerPostingCleared} this route
   * additionally enforces that the posting belongs to the reconciliation's
   * account, is on a POSTED entry, and is not frozen under another finished
   * reconciliation.
   */
  ledgerReconciliationPosting: (id: string, postingId: string): string =>
    `/api/ledger/reconciliations/${encodeURIComponent(id)}/postings/${encodeURIComponent(postingId)}`,
  /**
   * FINISH a reconciliation: `POST`. Rejects (`reconciliation-unbalanced`)
   * unless the difference is EXACTLY zero — the whole point of the workflow, and
   * enforced in the store so bypassing the UI changes nothing. On success every
   * matched posting freezes at `reconciled` (invariant 4).
   */
  ledgerReconciliationFinish: (id: string): string => `/api/ledger/reconciliations/${encodeURIComponent(id)}/finish`,
  /** REOPEN a finished reconciliation: `POST`. Explicit and audited; unfreezes
   *  every posting it had frozen (back to `cleared`, `reconciliationId` null). */
  ledgerReconciliationReopen: (id: string): string => `/api/ledger/reconciliations/${encodeURIComponent(id)}/reopen`,
  /**
   * ABANDON an OPEN reconciliation: `POST` (LGR-22). The way out of a match
   * that will never balance — a statement opened on the wrong account, a
   * duplicate started by mistake — WITHOUT posting anything to the books to
   * force the difference to zero. Terminal (`abandoned` is not reopenable),
   * audited, and posting-neutral: every tick keeps the cleared state it had.
   * The account is free for a new reconciliation immediately.
   */
  ledgerReconciliationAbandon: (id: string): string => `/api/ledger/reconciliations/${encodeURIComponent(id)}/abandon`,
  /** The append-only ledger audit log: `GET` (paginated, `?limit=&before=<seq>`,
   *  newest first). Read-only — no mutation route exists. */
  ledgerAudit: '/api/ledger/audit',
  /**
   * Canonical postings CSV export (LGR-7): `GET` returns the whole ledger as
   * `text/csv` — one row per posting, byte-stable (same data ⇒ identical bytes;
   * see sdk `buildLedgerPostingsCsv` for the column contract). Read-gated like
   * every other ledger read (the restricted host page's decision). Built
   * in-memory — a book is small; revisit streaming only if that ever changes.
   */
  ledgerExportCsv: '/api/ledger/export.csv',
  /**
   * Independent invariant verifier (LGR-7): `GET` re-checks the ledger against
   * RAW storage (its own SQL, not the LedgerStore validators) — balance, audit
   * hash chain, referential integrity, audit replay, entry-number density —
   * and returns a typed findings report (empty findings = clean). Gated
   * `requireInstanceAdmin` (owner/admin/loopback): the report names entity ids
   * across the whole book, an administration-level view.
   */
  ledgerVerify: '/api/ledger/verify',
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
