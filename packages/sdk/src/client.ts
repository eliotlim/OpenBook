import {API, type ApiError, type CompactResult} from './routes';
import type {PluginPackage, StoredPlugin} from './plugins';
import type {
  AgentChatEvent,
  AgentChatMessage,
  AgentChatOptions,
  AiConfig,
  AiPricingResponse,
  AiPricingTable,
  AiUsageResponse,
  AiSearchResponse,
  AiSkill,
  AiStatus,
  AiStreamEvent,
  AiTasksResponse,
  McpClientConfig,
  McpConfigResponse,
  McpServerConfig,
  McpTestResult,
} from './ai';
import type {AclLevel, AgentEditsMode, AgentEditsPolicy, Member, MemberRole, MemberStatus, PageAcl, PageGraph, PageInput, PageMeta, PageVersionMeta, PageVisibility, StoredPage, StoredPageVersion} from './types';
import type {InstanceConfig, InstanceInfo, StoredEdit} from './provenance';
import type {AgentTokenMeta, AgentTokenScope} from './identity';
import type {BackupCadence, BackupConfig, BackupStatus, ImportRequest, ImportResult, LedgerBackupSection} from './backup';
import type {LedgerExportSection, LedgerSectionRestoreResult} from './ledgerExportSection';
import type {
  DatabaseInput,
  DatabaseRow,
  DatabaseUpdate,
  RowInput,
  RowUpdate,
  StoredDatabase,
} from './database';
import type {
  CommentInput,
  StoredComment,
  StoredSuggestion,
  SuggestionInput,
  SuggestionStatus,
  SuggestionUpdate,
} from './suggestions';
import {LEDGER_ERROR_CODES, LedgerError, type LedgerErrorCode} from './ledger';
import type {
  LedgerAccount,
  LedgerAccountInput,
  LedgerAccountPatch,
  LedgerAuditEvent,
  LedgerClearedState,
  LedgerDraftInput,
  LedgerDraftPatch,
  LedgerInfo,
  LedgerPeriod,
  LedgerPeriodCloseInput,
  LedgerPeriodCloseResult,
  LedgerPeriodReopenResult,
  LedgerPosting,
  LedgerReconciliation,
  LedgerReconciliationInput,
  LedgerReconciliationPatch,
  LedgerReconciliationStatus,
  LedgerReconciliationSummary,
  LedgerReverseOptions,
  LedgerTransaction,
  LedgerTransactionState,
  LedgerVerifyReport,
} from './ledger';

/** Handlers for a single page's live update stream. */
export interface PageSubscription {
  /** A newer version of the page was saved (by anyone). */
  onPage?: (page: StoredPage) => void;
  /** The page was deleted. */
  onDeleted?: (id: string) => void;
}

/** Input to {@link DataClient.createAgentToken}. `scope` defaults to `read`;
 *  `expiresInDays` defaults to 90 server-side, and `null` mints a no-expiry token. */
export interface CreateAgentTokenInput {
  name: string;
  scope?: AgentTokenScope;
  expiresInDays?: number | null;
  /** Mint a REMOTE-capable token (AGENT-7): usable over a forwarded `/api/mcp`
   *  request via the public edge. Default false. Requires the instance's
   *  `agentApi.remote` setting to already be on (else the mint 409s), and forces a
   *  finite TTL (30 d default, 90 d max; no-expiry rejected). */
  remote?: boolean;
}

/** The one-time create response: the plaintext `token` (shown ONCE) + its meta. */
export interface CreatedAgentToken {
  token: string;
  meta: AgentTokenMeta;
}

/** The agent-token management view: the dark `agentApi` on/off state + the list. */
export interface AgentTokenList {
  enabled: boolean;
  /** Whether REMOTE MCP is effectively enabled (AGENT-7): the `agentApi.remote`
   *  setting AND the local feature on AND neither kill-switch set. */
  remote: boolean;
  tokens: AgentTokenMeta[];
}

/**
 * Storage-agnostic data access used by the document UI.
 *
 * The desktop app and the web shell both talk to a server through the same
 * {@link HttpDataClient} — the desktop just points it at its bundled local
 * server, the web shell at a remote one. Swapping the target URL is how a user
 * moves between "store locally" and "connect to an external server"; the
 * document code never changes.
 */
export interface DataClient {
  /** List all pages' metadata, most-recently-updated first. */
  listPages(): Promise<PageMeta[]>;
  /** Fetch a page by id, or `null` if it does not exist. */
  getPage(id: string): Promise<StoredPage | null>;
  /** Create or update a page (upsert keyed on `input.id`). */
  savePage(input: PageInput): Promise<StoredPage>;
  /** Update only a page's name (leaves its document data untouched). */
  renamePage(id: string, name: string | null): Promise<StoredPage>;
  /**
   * Shallow-merge structured property values into a page (owner, verification,
   * …), leaving its document content and other properties untouched. Used by
   * the page properties panel for non-row pages (database rows use {@link updateRow}).
   */
  setPageProperties(id: string, properties: Record<string, unknown>): Promise<StoredPage>;
  /** List the live pages that link to `id` (via `@`-mentions), newest first. */
  listBacklinks(id: string): Promise<PageMeta[]>;
  /**
   * The whole-library page-link graph: readable pages as nodes + their
   * mention/relation edges (both endpoints readable). Edges are derived on the
   * fly. Read-filtered per principal like {@link listPages}.
   */
  pageGraph(): Promise<PageGraph>;

  // ── Page version history (PVH-3) ─────────────────────────────────────────────
  /**
   * List a page's captured versions (metadata only — no snapshot payload, so a
   * history list stays cheap), newest first. `opts.limit` caps the page (server
   * clamps 1..1000; default 100). Version access inherits the page's READ
   * capability — a caller who can't read the page can't list its versions.
   *
   * Asymmetry (intentional): unlike {@link getVersion}/{@link restoreVersion}, which
   * return `null` on a 404, this THROWS on a non-OK response. A missing/unreadable
   * page surfaces as a 403/404 error rather than an empty list, so a caller can't
   * mistake "you can't see this page" for "this page has no history".
   */
  listVersions(pageId: string, opts?: {limit?: number}): Promise<PageVersionMeta[]>;
  /**
   * Read one captured version WITH its snapshot payload (the state to roll back
   * to), or `null` when it doesn't exist / isn't that page's version (no
   * cross-page leak). Read-gated on the page.
   */
  getVersion(pageId: string, versionId: string): Promise<StoredPageVersion | null>;
  /**
   * Roll a page back to a captured version, returning the restored page (or `null`
   * when the page/version is gone). Write-gated on the page. Non-destructive: the
   * server writes the old snapshot back through the normal save path, which captures
   * the CURRENT (pre-restore) state as a fresh version first — so a restore is itself
   * undoable via another restore. The page's name is left untouched.
   */
  restoreVersion(pageId: string, versionId: string): Promise<StoredPage | null>;
  /**
   * Move a page within the sidebar tree: set its parent (`null` = top level) and
   * the full ordered list of sibling ids under that parent (including this page).
   * Used by drag-to-reorder / drag-to-nest. Rejects a move that would create a
   * cycle (nesting a page under itself or a descendant).
   */
  movePage(id: string, move: {parentId: string | null; orderedIds: string[]}): Promise<StoredPage>;

  // ── Optional local AI ──────────────────────────────────────────────────────
  aiStatus(): Promise<AiStatus>;
  aiSetConfig(config: AiConfig): Promise<AiConfig>;
  aiIndex(): Promise<{pages: number; chunks: number}>;
  aiSearch(query: string, limit?: number): Promise<AiSearchResponse>;
  aiTasks(goal: string, context?: string): Promise<AiTasksResponse>;
  aiDownloadModel(url?: string): Promise<AiStatus['download']>;
  aiComplete(text: string, onToken: (token: string) => void, opts?: {instruction?: string; signal?: AbortSignal}): Promise<string>;
  aiGenerate(prompt: string, onToken: (token: string) => void, opts?: {system?: string; maxTokens?: number; signal?: AbortSignal}): Promise<string>;
  /**
   * Run the library agent on a conversation. `onEvent` fires once per step
   * (tool call, tool result, reasoning, proposals, final answer, error);
   * resolves when the run ends. `opts` carries effort/thinking/skills overrides.
   */
  agentChat(messages: AgentChatMessage[], onEvent: (event: AgentChatEvent) => void, opts?: AgentChatOptions): Promise<void>;
  /** List the library's prompt/recipe skills. */
  aiSkills(): Promise<AiSkill[]>;
  /** Create or replace a prompt/recipe skill (keyed on its slug). */
  aiSaveSkill(skill: AiSkill): Promise<AiSkill>;
  /** Delete a prompt/recipe skill by name. */
  aiDeleteSkill(name: string): Promise<boolean>;
  /** Read the usage-attribution pricing (admin only): default + override merged. */
  getAiPricing(): Promise<AiPricingResponse>;
  /** Set the admin pricing override (admin only); returns the merged view. */
  setAiPricing(override: AiPricingTable): Promise<AiPricingResponse>;
  /** Read the admin-only AI usage view (recent rows + totals; admin only). Never
   *  seeds the usage DB — a fresh library reports `exists:false`. */
  getAiUsage(): Promise<AiUsageResponse>;
  /** Set the AI usage database's retention window in days (admin only). */
  setAiUsageRetention(days: number): Promise<{days: number}>;
  /** Read the external-tools (MCP client) config (admin only): redacted config +
   *  whether the stdio transport is permitted on this instance. */
  getMcpConfig(): Promise<McpConfigResponse>;
  /** Save the external-tools (MCP client) config (admin only). Auth tokens are
   *  write-only (omit/blank preserves, a value sets, `null` clears). Returns the
   *  redacted result. */
  putMcpConfig(config: McpClientConfig): Promise<McpConfigResponse>;
  /** Dry-run one MCP server config (admin only): connect + list tools; never
   *  returns secrets. */
  testMcpServer(server: McpServerConfig): Promise<McpTestResult>;

  // ── Extensions (installed plugins, stored server-side per library) ───────
  listPlugins(): Promise<StoredPlugin[]>;
  /**
   * Install or upgrade a plugin. The server preserves the enabled state and
   * install time of an existing plugin, and REJECTS a downgrade (an older
   * semver than what's installed) unless `opts.allowDowngrade` is explicit.
   */
  installPlugin(pkg: PluginPackage, opts?: {allowDowngrade?: boolean}): Promise<StoredPlugin>;
  setPluginEnabled(id: string, enabled: boolean): Promise<StoredPlugin>;
  removePlugin(id: string): Promise<boolean>;
  /**
   * Move a page (and its nested subtree) to the trash. Soft delete: the page is
   * recoverable via {@link restorePage} until the server's cleanup job purges
   * it. Resolves `true` if a live page was trashed.
   */
  deletePage(id: string): Promise<boolean>;
  /** Export the whole space: every live page (full data) + every database —
   *  plus the ledger durability section when a ledger is seeded (LGR-15). */
  exportLibrary(): Promise<{pages: StoredPage[]; databases: StoredDatabase[]; ledger?: LedgerBackupSection}>;
  /** Restore a (client-selected) set of pages/databases; see {@link ImportRequest}. */
  importLibrary(req: ImportRequest): Promise<ImportResult>;
  /** List the trash (most-recently-deleted first). */
  listTrash(): Promise<PageMeta[]>;
  /** Restore a trashed page, or `null` if it isn't in the trash. */
  restorePage(id: string): Promise<StoredPage | null>;
  /** Permanently delete one trashed page (and its subtree). `true` if removed. */
  purgePage(id: string): Promise<boolean>;
  /** Permanently empty the whole trash. Resolves the number of pages purged. */
  emptyTrash(): Promise<number>;
  /**
   * Heavy on-demand compaction (VACUUM FULL) to physically reclaim database
   * bloat — embedded (PGlite) stores only; a remote external-Postgres server
   * rejects it. Briefly pauses other reads/writes while it runs. Resolves the
   * before/after on-disk size in bytes. See OB-164.
   */
  compact(): Promise<CompactResult>;
  /** Subscribe to a single page's live updates. Returns an unsubscribe fn. */
  subscribePage(id: string, handlers: PageSubscription): () => void;
  /** Subscribe to live page-list updates. Returns an unsubscribe fn. */
  subscribePages(onList: (pages: PageMeta[]) => void): () => void;
  /**
   * Subscribe to the live stream's *reconnect* signal (Collab T7): fires after the SSE
   * stream drops and successfully **reopens** (the OB-132/OB-283 resync signal), so a
   * caller can run a tight catch-up — the relay re-does its state-vector `/sync`
   * handshake, the awareness provider re-announces presence — instead of waiting out the
   * coarser page-*snapshot* resync (≤ snapshot-rate). Trailing-debounced against a
   * flapping connection. It does NOT fire on the FIRST connect (the one-shot handshakes
   * cover that) nor in poll-mode (no live SSE ⇒ convergence stays at snapshot-rate, the
   * existing graceful degrade). Returns an unsubscribe fn; a transport with no live
   * stream (the in-webview client) never fires it.
   */
  subscribeReconnect(onReconnect: () => void): () => void;

  // ── Live collaboration: incremental relay + late-joiner sync (Collab T1/T2) ──
  /**
   * Relay one incremental Yjs update for a page to other open editors. `update` is
   * the base64 CRDT bytes; `clientId` is the author's `Y.Doc` id so the author's
   * own echo can be dropped. Ephemeral — never persisted (durability stays with
   * {@link savePage}'s debounced snapshot).
   */
  postPageUpdate(id: string, update: string, clientId: number): Promise<void>;
  /**
   * Subscribe to a page's incremental Yjs updates. `onUpdate` fires with the base64
   * CRDT bytes + the author's `clientId`. Returns an unsubscribe fn.
   */
  subscribePageUpdates(id: string, onUpdate: (update: string, clientId: number) => void): () => void;
  /**
   * Late-joiner handshake: send the local doc's base64 state vector, receive the
   * base64 update carrying exactly the ops this client is missing (or `null` when
   * the server has nothing newer than the snapshot the client already loaded). This
   * is how a client joining mid-session converges to the CURRENT doc.
   */
  syncPageUpdates(id: string, stateVector: string): Promise<string | null>;

  // ── Live collaboration: ephemeral awareness / presence (Collab T4) ───────────
  /**
   * Publish this client's presence (cursor / selection) as a base64
   * `y-protocols/awareness` update. **Read-gated** (a viewer appears present), and
   * the server **re-stamps the identity** (name/colour) from the verified principal
   * — what's in the body is never trusted for who-you-are. Ephemeral: never
   * persisted, never in the edit log.
   */
  postPageAwareness(id: string, update: string, clientId: number): Promise<void>;
  /**
   * Subscribe to a page's awareness updates (other clients' presence). `onUpdate`
   * fires with the base64 awareness bytes + the author's `clientId` (so the author
   * drops its own echo). Returns an unsubscribe fn. Ephemeral — not resynced on
   * reconnect; the periodic awareness refresh + the on-connect snapshot recover it.
   */
  subscribePageAwareness(id: string, onUpdate: (update: string, clientId: number) => void): () => void;
  /**
   * Current presence snapshot for a late joiner (Collab T4): the base64 awareness
   * updates of everyone currently present (already identity-stamped), so a client
   * connecting mid-session sees who's here at once rather than waiting out the next
   * awareness refresh. Read-gated. Empty when nobody else is present.
   */
  syncPageAwareness(id: string): Promise<string[]>;

  // ── Assets: content-addressed binary store (OB-ASSETS A2) ────────────────────
  /**
   * Upload binary `bytes` (e.g. an image's file bytes) to the content-addressed
   * asset store, ref'd to `pageId` — a page the caller can write, whose read-gate
   * the asset inherits so it's immediately reachable. Resolves `{id}`, the
   * SHA-256 content hash; a byte-identical re-upload dedups to the same id. The
   * image block persists only this `id`, never the bytes, so the CRDT stays small.
   */
  putAsset(bytes: Uint8Array, mime: string, pageId: string): Promise<{id: string}>;
  /**
   * Fetch an asset's bytes + mime by content-hash `id`, or `null` when it's
   * missing or the caller can read no page that references it (read-gated — an
   * absent and an unreadable asset answer alike, so there's no existence oracle).
   * The image block resolves this to an object URL for `<img src>`.
   */
  getAsset(id: string): Promise<{bytes: Uint8Array; mime: string} | null>;

  // ── Databases ──────────────────────────────────────────────────────────────
  /** Create a database for a host page. */
  createDatabase(input: DatabaseInput): Promise<StoredDatabase>;
  /** Fetch a database by id, or `null` if it does not exist. */
  getDatabase(id: string): Promise<StoredDatabase | null>;
  /** Fetch the database hosted by a page, or `null` if the page hosts none. */
  getPageDatabase(pageId: string): Promise<StoredDatabase | null>;
  /** Update a database's name and/or schema. */
  updateDatabase(id: string, patch: DatabaseUpdate): Promise<StoredDatabase>;
  /** Delete a database and all its row pages. Resolves `true` if removed. */
  deleteDatabase(id: string): Promise<boolean>;
  /** List a database's rows (projected: properties + exported cell values). */
  listRows(databaseId: string): Promise<DatabaseRow[]>;
  /** Create a row (a new page) inside a database. Returns the row page. */
  createRow(databaseId: string, input?: RowInput): Promise<StoredPage>;
  /** Update a row's title and/or manual property values. */
  updateRow(databaseId: string, rowId: string, patch: RowUpdate): Promise<DatabaseRow>;
  /** Set the manual order of a database's rows (full ordered id list). */
  reorderRows(databaseId: string, orderedIds: string[]): Promise<void>;
  /** Subscribe to a database's live row-list updates. Returns an unsubscribe fn. */
  subscribeRows(databaseId: string, onRows: (rows: DatabaseRow[]) => void): () => void;

  // ── Ledger: server-enforced double-entry accounting (LGR-3) ──────────────────
  // Invariant violations reject with a typed {@link LedgerError} over BOTH
  // transports (the HTTP client re-materializes the server's `{error, code}`).
  /** Whether the ledger is initialized, and the seeded database/host ids. */
  ledgerInfo(): Promise<LedgerInfo>;
  /** Seed the four managed ledger databases + restricted host page (idempotent). */
  ledgerInit(): Promise<LedgerInfo>;
  /**
   * LX-4: restore an export's embedded ledger-records section into an EMPTY
   * ledger — the section is deep-validated, then REPLAYED through the server's
   * ledger writer (fresh audit entries carrying import provenance; no direct
   * row writes). Refuses with `LedgerError('invalid-state')` when the target
   * already keeps any ledger data (merge is out of scope). Instance-admin gated
   * over HTTP, like `importLibrary`.
   */
  ledgerRestoreSection(section: LedgerExportSection): Promise<LedgerSectionRestoreResult>;
  /** List accounts (hierarchy is encoded in the colon-delimited names). */
  ledgerListAccounts(): Promise<LedgerAccount[]>;
  /** Create an account. `currency` defaults to `USD`. */
  ledgerCreateAccount(input: LedgerAccountInput): Promise<LedgerAccount>;
  /** Fetch one account, or `null` when it does not exist. */
  ledgerGetAccount(id: string): Promise<LedgerAccount | null>;
  /** Rename / close / reopen an account. Closing rejects at nonzero posted balance. */
  ledgerUpdateAccount(id: string, patch: LedgerAccountPatch): Promise<LedgerAccount>;
  /** List transactions with their postings (`state` filters; `limit` caps). */
  ledgerListTransactions(opts?: {state?: LedgerTransactionState; limit?: number}): Promise<LedgerTransaction[]>;
  /** Fetch one transaction (with postings), or `null` when it does not exist. */
  ledgerGetTransaction(id: string): Promise<LedgerTransaction | null>;
  /** Create a DRAFT transaction (with postings). Drafts are freely mutable. */
  ledgerCreateDraft(input: LedgerDraftInput): Promise<LedgerTransaction>;
  /** Update a DRAFT (posted/void transactions are immutable — typed rejection). */
  ledgerUpdateDraft(id: string, patch: LedgerDraftPatch): Promise<LedgerTransaction>;
  /** Delete a DRAFT and its postings (permanent, audited). Posted/void reject. */
  ledgerDeleteDraft(id: string): Promise<boolean>;
  /** Post a draft atomically (validates all invariants; assigns the entry number). */
  ledgerPostTransaction(id: string): Promise<LedgerTransaction>;
  /** Atomically create + post the reversing entry and void the original. */
  ledgerReverseTransaction(id: string, opts?: LedgerReverseOptions): Promise<LedgerTransaction>;
  /** Flip a posting between `pending`/`cleared` (`reconciled` is locked, LGR-11). */
  ledgerSetPostingCleared(postingId: string, cleared: LedgerClearedState): Promise<LedgerPosting>;

  // ── Statement reconciliation (LGR-11) ───────────────────────────────────────
  // The workflow that catches the entries an import missed, doubled, or got
  // wrong. Every step is one atomic, audited store mutation; `finish` is the
  // gate — it is impossible at a nonzero difference over BOTH transports,
  // because the check lives in the store, not in the caller.
  /** List reconciliations, newest statement first. Filters are ANDed. */
  ledgerListReconciliations(opts?: {accountId?: string; status?: LedgerReconciliationStatus}): Promise<LedgerReconciliation[]>;
  /** One reconciliation with its live cleared balance + difference, or `null`. */
  ledgerGetReconciliation(id: string): Promise<LedgerReconciliationSummary | null>;
  /** START a reconciliation. Rejects `reconciliation-exists` if one is open. */
  ledgerStartReconciliation(input: LedgerReconciliationInput): Promise<LedgerReconciliation>;
  /** AMEND an OPEN reconciliation's statement date/balance (LGR-22) — the fix
   *  for a mistyped target, which no amount of ticking can reach zero. Touches
   *  no posting; returns the summary with the difference recomputed. */
  ledgerAmendReconciliation(id: string, patch: LedgerReconciliationPatch): Promise<LedgerReconciliationSummary>;
  /** ABANDON an OPEN reconciliation (LGR-22): end it without balancing it and
   *  without posting anything. Terminal, audited, posting-neutral — every tick
   *  keeps its cleared state, and the account is free to start a new one. */
  ledgerAbandonReconciliation(id: string): Promise<LedgerReconciliation>;
  /** Match (`cleared`) or unmatch (`pending`) one posting inside an OPEN one. */
  ledgerToggleReconciliationPosting(id: string, postingId: string, cleared: 'pending' | 'cleared'): Promise<LedgerReconciliationSummary>;
  /** FINISH — only at a difference of exactly 0; freezes the matched postings. */
  ledgerFinishReconciliation(id: string): Promise<LedgerReconciliationSummary>;
  /** REOPEN a finished reconciliation (explicit, audited); unfreezes its postings. */
  ledgerReopenReconciliation(id: string): Promise<LedgerReconciliationSummary>;

  /** Every period record — closed AND reopened history (LGR-12). */
  ledgerListPeriods(): Promise<LedgerPeriod[]>;
  /** CLOSE a period: closing entry + date-range lock; warns (never blocks) on
   *  open reconciliations. Store-enforced — `period-closed` rejections for any
   *  posting/reversal dated inside the range hold over both transports. */
  ledgerClosePeriod(input: LedgerPeriodCloseInput): Promise<LedgerPeriodCloseResult>;
  /** REOPEN a closed period (explicit, audited): voids the closing entry via a
   *  reversal and restores postability for the range. */
  ledgerReopenPeriod(id: string): Promise<LedgerPeriodReopenResult>;

  /** Read the append-only audit log, newest first (`before` = seq cursor). */
  ledgerListAudit(opts?: {limit?: number; before?: number}): Promise<LedgerAuditEvent[]>;
  /** The whole ledger as the canonical postings CSV (LGR-7) — byte-stable:
   *  same data ⇒ identical bytes over BOTH transports. */
  ledgerExportCsv(): Promise<string>;
  /** The whole ledger as a Beancount journal (LGR-13) — byte-stable like the
   *  CSV, built from the same read model; `bean-check`/Fava re-verify it with
   *  an independent implementation. */
  ledgerExportBeancount(): Promise<string>;
  /** The independent invariant verifier's report (LGR-7). Admin-gated over
   *  HTTP (the report names entity ids across the whole book); the local
   *  single-user store answers directly. */
  ledgerVerify(): Promise<LedgerVerifyReport>;

  // ── Suggestions + comments (the review layer) ────────────────────────────────
  /** List a page's suggestions, newest first. `status` filters (e.g. only open). */
  listSuggestions(pageId: string, status?: SuggestionStatus): Promise<StoredSuggestion[]>;
  /** Persist a new suggestion (status defaults to `open`). */
  createSuggestion(input: SuggestionInput): Promise<StoredSuggestion>;
  /** Update a suggestion (today: its status). Returns the updated suggestion. */
  updateSuggestion(id: string, patch: SuggestionUpdate): Promise<StoredSuggestion>;
  /** Delete a suggestion (and its thread). Resolves `true` if removed. */
  deleteSuggestion(id: string): Promise<boolean>;
  /** List a page's comments, oldest first (so a thread reads top-to-bottom). */
  listComments(pageId: string): Promise<StoredComment[]>;
  /** Persist a new comment (on a suggestion or a block). */
  createComment(input: CommentInput): Promise<StoredComment>;
  /** Delete a comment. Resolves `true` if removed. */
  deleteComment(id: string): Promise<boolean>;

  // ── Multi-user: identity, policy, provenance (OB-165) ────────────────────────
  /** The instance's multi-user policy + who the server resolved *you* to be. */
  getInstanceInfo(): Promise<InstanceInfo>;
  /** Update the multi-user policy (guest gate, trusted issuers, owner). Owner-only
   *  once an owner is claimed. */
  setInstancePolicy(patch: Partial<InstanceConfig>): Promise<InstanceConfig>;
  /** A page's change provenance (the edit log), newest first. */
  listPageEdits(pageId: string, limit?: number): Promise<StoredEdit[]>;

  // ── Sharing: per-page visibility scope + ACL (OB-182 §1.1; OB-191/203) ────────
  /** A page's stored visibility scope (raw — `inherit` not yet resolved), or
   *  `null` if the page does not exist. */
  getPageVisibility(pageId: string): Promise<PageVisibility | null>;
  /** Set a page's visibility scope (manager-only — gated on page write). */
  setPageVisibility(pageId: string, visibility: PageVisibility): Promise<PageVisibility>;
  /** A page's agent-edits policy (AGED-1; raw — `inherit` not yet resolved against
   *  the instance mode). Gated on read of the page. Use this for the UI tri-state
   *  (which must show `inherit` as its own state); use {@link getEffectiveAgentEdits}
   *  when you need the resolved decision. Resolve manually with {@link resolveAgentEdits}. */
  getPageAgentEdits(pageId: string): Promise<AgentEditsPolicy>;
  /** A page's SERVER-RESOLVED effective agent-edits mode (AGED-6): the raw policy
   *  resolved against the instance default, computed server-side (never `inherit`).
   *  Lets a PAT-scoped client learn the effective mode of an `inherit` page WITHOUT
   *  the privileged instance read. Gated on read of the page. */
  getEffectiveAgentEdits(pageId: string): Promise<AgentEditsMode>;
  /** Set a page's agent-edits policy (AGED-1; jws-only — a PAT cannot change the
   *  policy that governs whether agents edit directly). */
  setPageAgentEdits(pageId: string, agentEdits: AgentEditsPolicy): Promise<AgentEditsPolicy>;
  /** A page's per-page ACL grants (manager-only — gated on page write). */
  listPageAcl(pageId: string): Promise<PageAcl[]>;
  /** Share a page with `invitee` (email or handle/subject) at `level`. */
  sharePage(pageId: string, invitee: string, level?: AclLevel): Promise<PageAcl>;
  /** Revoke a page ACL grant by subject XOR email. `true` if one was removed. */
  unsharePage(pageId: string, key: {subject: string} | {email: string}): Promise<boolean>;
  // ── Sharing: the instance member roster (OB-191; manager-only) ────────────────
  /** The instance member roster. Manager-only (write at the instance default). */
  listMembers(): Promise<Member[]>;
  /** Invite by `invitee` — an email persona, or a handle/subject. */
  inviteMember(invitee: string, opts?: {role?: MemberRole; status?: MemberStatus}): Promise<Member>;
  /** Patch a roster row's role/status (change role, activate, suspend). */
  updateMember(id: string, patch: {role?: MemberRole; status?: MemberStatus}): Promise<Member>;
  /** Revoke a roster row by id. `true` if one was removed. */
  removeMember(id: string): Promise<boolean>;

  // ── Agent access: PAT credential management (AGENT-6; admin-only) ─────────────
  /** List minted agent tokens (redacted) plus the dark `agentApi` on/off state. */
  listAgentTokens(): Promise<AgentTokenList>;
  /** Toggle the dark `agentApi` setting on/off (+ the `agentApi.remote` remote-MCP
   *  opt-in, AGENT-7). `remote` is forced off when `enabled` is off. Returns the new
   *  effective state. */
  setAgentApiEnabled(enabled: boolean, remote?: boolean): Promise<{enabled: boolean; remote: boolean}>;
  /** Mint a token (requires `agentApi` enabled). The plaintext `token` comes back
   *  exactly ONCE — store it now; only its hash is kept server-side. */
  createAgentToken(input: CreateAgentTokenInput): Promise<CreatedAgentToken>;
  /** Revoke a token by id. `true` if one was removed. */
  revokeAgentToken(id: string): Promise<boolean>;

  // ── Scheduled backups (OB-166) ───────────────────────────────────────────────
  /** Scheduled-backup policy + per-cadence status. */
  getBackupStatus(): Promise<BackupStatus>;
  /** Update the backup policy (enable, cadences, retention, folder). Owner-only. */
  setBackupConfig(patch: Partial<BackupConfig>): Promise<BackupStatus>;
  /** Run a snapshot now ("Back up now"). Resolves the written file + its folder. */
  runBackup(cadence?: BackupCadence): Promise<{file: string; dir: string}>;

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  /** Release the client's resources (close the live `EventSource`, drop
   *  identity subscriptions). Optional — an in-webview client with no long-lived
   *  connection has nothing to release. Called when the app swaps to a different
   *  client (a no-reload library switch) or tears down. */
  dispose?(): void;
}

/**
 * The identity a client presents to a data server (OB-165). `jws` is a verified
 * identity assertion (when signed in); `guestName` labels otherwise-anonymous
 * edits. Both are optional — a fully anonymous guest sends neither.
 */
export interface IdentityCredential {
  jws?: string;
  guestName?: string;
}

/**
 * One multiplexed live connection for a client. Every subscription (page list,
 * a page, a database's rows) registers here and is served by a single
 * `EventSource` to `/api/live`, which the client opens lazily and closes once
 * nothing is listening. This keeps each tab to one long-lived connection so
 * several tabs don't exhaust the browser's per-origin connection limit.
 */
/** Re-fetchers the live stream calls to resync open subscriptions after a reconnect. */
interface ResyncFetchers {
  listPages(): Promise<PageMeta[]>;
  getPage(id: string): Promise<StoredPage | null>;
  listRows(databaseId: string): Promise<DatabaseRow[]>;
}

/**
 * The `fetch` surface {@link HttpDataClient} needs. Defaults to the global
 * `fetch`; the desktop injects an implementation that tunnels requests over its
 * host IPC bridge (a Unix-socket server with no TCP port) instead.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The global `fetch`, wrapped so it's safe to store on an object and call as a
 * property/method. WebKit (the desktop WKWebView) throws "Can only call
 * Window.fetch on instances of Window" when `fetch` runs with a `this` that
 * isn't the window — which is exactly what `obj.fetchImpl(...)` does once the
 * bare global is assigned to a property. Calling the unqualified global here
 * sidesteps that, so it's the right default wherever a {@link FetchLike} is
 * stored and later invoked as a method.
 */
export const globalFetch: FetchLike = (input, init) => fetch(input, init);

/**
 * The slice of `EventSource` {@link LiveStream} uses (named events + open/error
 * via `addEventListener`, plus `close`). Defaults to a real `EventSource`; the
 * desktop injects a source backed by host IPC events, since its server speaks
 * over a socket the webview can't open an `EventSource` to.
 */
export interface LiveSourceLike {
  addEventListener(type: string, handler: (event: {data?: string}) => void): void;
  close(): void;
}

/**
 * How long to wait for the `EventSource`'s first `open` before deciding the
 * stream is structurally dead and falling back to polling. The *.book.pub
 * forwarding tunnel buffers the never-ending SSE body in release builds and
 * forwards nothing, so a tunneled browser sees neither `open` nor any event;
 * this bound caps how long it stays dark before polling takes over. Loopback
 * (dev) and any future-fixed transport open well inside this window and so
 * never poll. Exported for tests; not re-exported from the package index.
 */
export const LIVE_OPEN_GRACE_MS = 8000;

/**
 * How often poll-mode re-fetches every open subscription once the SSE stream is
 * deemed dead — the interval within which a tunneled client sees writes.
 */
export const LIVE_POLL_INTERVAL_MS = 4000;

/**
 * Number of `error`s (with no intervening `open`) that trip poll-mode early,
 * before {@link LIVE_OPEN_GRACE_MS} elapses — e.g. a connection that is refused
 * or fails immediately rather than hanging.
 */
export const LIVE_POLL_AFTER_ERRORS = 3;

/**
 * Trailing-debounce window for the {@link LiveStream} reconnect signal (Collab T7). A
 * flapping connection can `error`/`open` repeatedly; coalescing the reopens into a single
 * notification — fired once the stream has stayed open this long — keeps a caller's
 * re-handshake from storming the relay. Short relative to a snapshot save, so the
 * post-reconnect catch-up is still far tighter than the snapshot-rate fallback. Exported
 * for tests; not re-exported from the package index.
 */
export const LIVE_RECONNECT_DEBOUNCE_MS = 300;

class LiveStream {
  private source: LiveSourceLike | null = null;
  private readonly listListeners = new Set<(pages: PageMeta[]) => void>();
  private readonly pageListeners = new Map<string, Set<PageSubscription>>();
  private readonly rowsListeners = new Map<string, Set<(rows: DatabaseRow[]) => void>>();
  // Live collaboration — per-page incremental Yjs-update listeners (Collab T1).
  // Unlike the others these carry no durable state, so they are NOT resynced on
  // reconnect: a frame missed while the stream was down (or while a tunnel buffers
  // the SSE body, see the poll fallback below) is recovered from the next snapshot
  // `page` event and the on-connect sync handshake — never lost.
  private readonly pageUpdateListeners = new Map<string, Set<(update: string, clientId: number) => void>>();
  // Live collaboration — per-page awareness/presence listeners (Collab T4). Like
  // the update listeners these carry no durable state, so they are NOT resynced on
  // reconnect: presence is ephemeral, recovered by the periodic awareness refresh
  // and the on-connect snapshot — a missed frame just means a cursor lags briefly.
  private readonly pageAwarenessListeners = new Map<string, Set<(update: string, clientId: number) => void>>();
  // The source reconnects on its own after a drop (server/app restart). We track
  // a prior disconnect so that, on the *next* successful open, we re-fetch every
  // open subscription — the firehose only replays the page *list* on connect, so
  // open pages/rows would otherwise show stale data until their next edit.
  private sawError = false;
  // SSE-first poll fallback (OB-283): some transports (the *.book.pub forwarding
  // tunnel in release) can never stream an infinite `EventSource` body, so `open`
  // and events never arrive. We detect that — no `open` within a grace window, or
  // repeated pre-open errors — and resync on an interval instead, while the source
  // keeps retrying underneath. If `open` ever lands we drop polling and resume
  // pure SSE, so dev and any future-fixed client never poll.
  private hasOpened = false;
  private preOpenErrors = 0;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  // Guards against overlapping resyncs (a slow poll vs. the next tick / a reconnect).
  private resyncing = false;
  // Reconnect-signal fan-out (Collab T7): callers (the relay + awareness providers) run a
  // tight catch-up when the SSE stream reopens after a drop. Trailing-debounced so a
  // flapping connection fires it once, after the stream has re-stabilised.
  private readonly reconnectListeners = new Set<() => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    // NOT readonly: the URL bakes the identity/token credential (an EventSource
    // can't send headers), and {@link updateUrl} re-points it when that credential
    // changes so the stream can't keep asserting a stale identity — see below.
    private liveUrl: string,
    private readonly fetchers: ResyncFetchers,
    private readonly createSource: (url: string) => LiveSourceLike,
  ) {}

  /**
   * Re-point the stream at a new URL (a changed identity/token credential) and,
   * when a source is already open, tear it down and reopen against the new URL —
   * so the streamed nav list re-asserts the CURRENT identity instead of the one
   * frozen into the EventSource URL when it first opened (the cross-server
   * "titles show, content blank" divergence). A no-op when the URL is unchanged,
   * so an unrelated re-subscribe never churns the connection. Listeners survive
   * (they live in the Sets, not the source); an identity-scoped resync then
   * re-fetches every open subscription under the NEW credential and, unlike a
   * transient reconnect resync, CLEARS any open page that is no longer readable
   * (a 404/null or a 401) by firing its `onDeleted` — so a weaker identity or an
   * account switch drops the now-unreadable body (never leaving account-A's
   * content rendered under account-B) instead of leaving it stale until
   * navigation, while a still-readable page repopulates.
   */
  updateUrl(url: string): void {
    if (url === this.liveUrl) return;
    this.liveUrl = url;
    if (!this.source) return; // not open yet — the next ensureOpen() uses the new URL
    this.source.close();
    this.source = null;
    // Reset the transport state machine so the reopen is evaluated from scratch
    // (a fresh grace window, no inherited poll/error state).
    this.clearGraceTimer();
    this.stopPolling();
    this.clearReconnectTimer();
    this.hasOpened = false;
    this.preOpenErrors = 0;
    this.sawError = false;
    this.ensureOpen();
    void this.resync(true); // credential changed → clear pages unreadable under it
  }

  private dispatch(raw: string): void {
    let ev: {type: string; [k: string]: unknown};
    try {
      ev = JSON.parse(raw) as {type: string};
    } catch {
      return;
    }
    if (ev.type === 'list') {
      this.listListeners.forEach((fn) => fn(ev.pages as PageMeta[]));
    } else if (ev.type === 'page') {
      const page = ev.page as StoredPage;
      this.pageListeners.get(page.id)?.forEach((s) => s.onPage?.(page));
    } else if (ev.type === 'deleted') {
      const id = ev.id as string;
      this.pageListeners.get(id)?.forEach((s) => s.onDeleted?.(id));
    } else if (ev.type === 'rows') {
      this.rowsListeners.get(ev.databaseId as string)?.forEach((fn) => fn(ev.rows as DatabaseRow[]));
    } else if (ev.type === 'yupdate') {
      this.pageUpdateListeners
        .get(ev.pageId as string)
        ?.forEach((fn) => fn(ev.update as string, ev.clientId as number));
    } else if (ev.type === 'awareness') {
      this.pageAwarenessListeners
        .get(ev.pageId as string)
        ?.forEach((fn) => fn(ev.update as string, ev.clientId as number));
    }
  }

  /**
   * Whether the live stream has fallen back to poll-mode (Collab T1, tunnel
   * degrade): the SSE body can't stream (the *.book.pub release tunnel buffers it),
   * so `yupdate` frames never arrive. A caller can surface this to explain why live
   * collaboration is running at snapshot-rate rather than keystroke-rate — POST-up
   * (ingest + sync) still works, so this is a receive-side degrade, never data loss.
   */
  isPolling(): boolean {
    return this.pollTimer != null;
  }

  private ensureOpen(): void {
    if (this.source) return;
    const source = this.createSource(this.liveUrl);
    const handle = (e: {data?: string}): void => {
      if (e.data != null) this.dispatch(e.data);
    };
    for (const name of ['list', 'page', 'deleted', 'rows', 'yupdate', 'awareness']) source.addEventListener(name, handle);
    // A drop sets `sawError`; the source auto-reconnects and fires `open` again,
    // at which point we resync so every client transparently re-attaches after a
    // server or app restart (OB-132).
    source.addEventListener('error', () => {
      this.sawError = true;
      // The stream can't even establish (a tunnel that buffers the SSE body and
      // never forwards `open`): after a few pre-open errors, fall back to polling
      // without waiting out the whole grace window.
      if (!this.hasOpened && ++this.preOpenErrors >= LIVE_POLL_AFTER_ERRORS) this.startPolling();
    });
    source.addEventListener('open', () => {
      // SSE is alive: leave (or never enter) poll-mode and resume pure streaming.
      this.hasOpened = true;
      this.preOpenErrors = 0;
      this.clearGraceTimer();
      this.stopPolling();
      if (this.sawError) {
        this.sawError = false;
        void this.resync();
        // Collab T7: the coarse `resync()` above re-fetches page/row *snapshots*; the
        // reconnect signal additionally lets the collab providers re-run their tight
        // Yjs state-vector / awareness re-handshake so a client that missed `yupdate`
        // frames during the drop converges immediately, not at the next snapshot.
        this.notifyReconnect();
      }
    });
    this.source = source;
    // If the first `open` never lands within the grace window, the stream is
    // structurally dead (a transport that can't stream): fall back to polling.
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (!this.hasOpened) this.startPolling();
    }, LIVE_OPEN_GRACE_MS);
  }

  /**
   * Enter poll-mode: resync every open subscription now and then on an interval,
   * because the SSE stream can't deliver events. Idempotent and a no-op once SSE
   * has opened; the underlying `EventSource` keeps retrying, and its eventual
   * `open` calls {@link stopPolling} to exit.
   */
  private startPolling(): void {
    if (this.pollTimer || this.hasOpened) return;
    void this.resync();
    this.pollTimer = setInterval(() => void this.resync(), LIVE_POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private clearGraceTimer(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  /**
   * Signal a reconnect to listeners, trailing-debounced (Collab T7). Each reopen
   * (re)starts the timer, so a flapping connection that reopens several times fires the
   * listeners exactly once — after the stream has stayed open for the debounce window.
   */
  private notifyReconnect(): void {
    if (this.reconnectListeners.size === 0) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Copy first: a listener that (un)subscribes during its own re-handshake must not
      // perturb the fan-out, and one throwing must not starve the others.
      for (const fn of [...this.reconnectListeners]) {
        try {
          fn();
        } catch {
          /* a listener's own failure is its own problem */
        }
      }
    }, LIVE_RECONNECT_DEBOUNCE_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Re-fetch and re-dispatch every open subscription after a reconnect or poll.
   *
   * `clearUnreadable` distinguishes the two callers. A transient reconnect/poll
   * resync (`false`) treats a null/failed page as "server still catching up" and
   * leaves the current content in place — the next event heals it. An
   * identity-change resync (`true`, from {@link updateUrl}) instead treats a page
   * that is now a 404/null or a 401 as no-longer-readable UNDER THE NEW CREDENTIAL
   * and CLEARS it (fires `onDeleted`), so an identity lapse or account switch drops
   * the stale body rather than leaving account-A's content rendered under account-B.
   */
  private async resync(clearUnreadable = false): Promise<void> {
    // One resync at a time: a slow refetch must not overlap the next poll tick
    // (or a reconnect resync) and double-dispatch.
    if (this.resyncing) return;
    this.resyncing = true;
    try {
      try {
        const pages = await this.fetchers.listPages();
        this.listListeners.forEach((fn) => fn(pages));
      } catch {
        // Server still coming back up — the next event or resync will catch up.
      }
      for (const id of [...this.pageListeners.keys()]) {
        try {
          const page = await this.fetchers.getPage(id);
          if (page) this.pageListeners.get(id)?.forEach((s) => s.onPage?.(page));
          // Gone/hidden under the new credential (404 → null): drop the stale body.
          else if (clearUnreadable) this.pageListeners.get(id)?.forEach((s) => s.onDeleted?.(id));
        } catch {
          // A rejected identity (401) or other read failure: on a credential change
          // this page is no longer ours to show — clear it; on a transient resync
          // keep the current content and let the next event heal it.
          if (clearUnreadable) this.pageListeners.get(id)?.forEach((s) => s.onDeleted?.(id));
        }
      }
      for (const dbId of [...this.rowsListeners.keys()]) {
        try {
          const rows = await this.fetchers.listRows(dbId);
          this.rowsListeners.get(dbId)?.forEach((fn) => fn(rows));
        } catch {
          /* keep going */
        }
      }
    } finally {
      this.resyncing = false;
    }
  }

  private maybeClose(): void {
    if (
      this.listListeners.size === 0 &&
      this.pageListeners.size === 0 &&
      this.rowsListeners.size === 0 &&
      this.pageUpdateListeners.size === 0 &&
      this.pageAwarenessListeners.size === 0
    ) {
      this.source?.close();
      this.source = null;
      // Tear down both fallbacks and reset, so a later re-subscribe re-evaluates
      // the stream from scratch instead of inheriting a stale poll/grace timer.
      this.clearGraceTimer();
      this.stopPolling();
      this.clearReconnectTimer(); // drop a pending reconnect fan-out (no listeners to serve)
      this.hasOpened = false;
      this.sawError = false;
      this.preOpenErrors = 0;
      // Belt-and-suspenders: if a resync was mid-flight when the last listener left,
      // clear the guard so a fresh subscribe isn't wedged out of resyncing (OB-283).
      this.resyncing = false;
    }
  }

  private removeFromMap<T>(map: Map<string, Set<T>>, key: string, value: T): void {
    const set = map.get(key);
    set?.delete(value);
    if (set && set.size === 0) map.delete(key);
  }

  onList(fn: (pages: PageMeta[]) => void): () => void {
    this.ensureOpen();
    this.listListeners.add(fn);
    return () => {
      this.listListeners.delete(fn);
      this.maybeClose();
    };
  }

  onPage(id: string, sub: PageSubscription): () => void {
    this.ensureOpen();
    let set = this.pageListeners.get(id);
    if (!set) {
      set = new Set();
      this.pageListeners.set(id, set);
    }
    set.add(sub);
    return () => {
      this.removeFromMap(this.pageListeners, id, sub);
      this.maybeClose();
    };
  }

  onRows(databaseId: string, fn: (rows: DatabaseRow[]) => void): () => void {
    this.ensureOpen();
    let set = this.rowsListeners.get(databaseId);
    if (!set) {
      set = new Set();
      this.rowsListeners.set(databaseId, set);
    }
    set.add(fn);
    return () => {
      this.removeFromMap(this.rowsListeners, databaseId, fn);
      this.maybeClose();
    };
  }

  /** Subscribe to a page's incremental Yjs updates (Collab T1). */
  onPageUpdate(id: string, fn: (update: string, clientId: number) => void): () => void {
    this.ensureOpen();
    let set = this.pageUpdateListeners.get(id);
    if (!set) {
      set = new Set();
      this.pageUpdateListeners.set(id, set);
    }
    set.add(fn);
    return () => {
      this.removeFromMap(this.pageUpdateListeners, id, fn);
      this.maybeClose();
    };
  }

  /** Subscribe to a page's awareness/presence updates (Collab T4). */
  onPageAwareness(id: string, fn: (update: string, clientId: number) => void): () => void {
    this.ensureOpen();
    let set = this.pageAwarenessListeners.get(id);
    if (!set) {
      set = new Set();
      this.pageAwarenessListeners.set(id, set);
    }
    set.add(fn);
    return () => {
      this.removeFromMap(this.pageAwarenessListeners, id, fn);
      this.maybeClose();
    };
  }

  /**
   * Subscribe to the reopen-after-drop reconnect signal (Collab T7). Deliberately
   * auxiliary: it does NOT `ensureOpen()` (a content subscription opens the stream) and
   * is excluded from {@link maybeClose}'s emptiness check (a lone reconnect listener has
   * nothing to catch up), so it can neither open nor wedge the connection by itself.
   */
  onReconnect(fn: () => void): () => void {
    this.reconnectListeners.add(fn);
    return () => {
      this.reconnectListeners.delete(fn);
      this.maybeClose();
    };
  }
}

/** Options for swapping {@link HttpDataClient}'s transport (desktop IPC). */
export interface HttpDataClientOptions {
  /** Replacement for the global `fetch` (e.g. tunnel requests over host IPC). */
  fetchImpl?: FetchLike;
  /** Factory for the live-update source (e.g. an IPC-event-backed source). */
  createLiveSource?: (url: string) => LiveSourceLike;
  /**
   * The caller's current identity (OB-165), read fresh on every request so a
   * sign-in / sign-out / token refresh takes effect without rebuilding the
   * client. Sent as the `X-OpenBook-Identity` (JWS) and `X-OpenBook-Guest-Name`
   * headers — orthogonal to {@link HttpDataClient}'s access `token`, which is the
   * instance reachability secret. Omit for a legacy anonymous client.
   */
  getIdentity?: () => IdentityCredential | null | undefined;
  /**
   * Subscribe to identity-credential changes (returns an unsubscribe). Wired to
   * `onIdentityChange` from `connection.ts`, this lets the client rebuild its live
   * stream when the identity actually changes — an EventSource bakes the identity
   * into its URL when it opens and can't refresh it, so without this the streamed
   * nav list keeps asserting a stale identity while one-shot content fetches use
   * the current one (the cross-server "titles show, content blank" bug). Omit and
   * the stream still reconciles on the next re-subscribe, just not proactively.
   */
  subscribeIdentity?: (onChange: () => void) => () => void;
}

/** Identity header names (kept in sync with the server's `principal.ts`). */
const IDENTITY_HEADER = 'X-OpenBook-Identity';
const GUEST_NAME_HEADER = 'X-OpenBook-Guest-Name';
/**
 * First-party-client marker (STAB-8, kept in sync with the sdk's `CLIENT_HEADER`
 * and the server's guest-write gate). Sent on EVERY request so an unauthenticated
 * guest write is a non-simple cross-origin request the browser can't forge as a
 * plain form/`fetch` POST. Reads carry it too — harmless, and it means the desktop
 * IPC / web / forwarded transports are uniform.
 */
const CLIENT_HEADER = 'X-OpenBook-Client';

/**
 * The data server REJECTED the caller's identity assertion (HTTP 401): the JWS is
 * expired, scoped to a different audience, revoked, or from an untrusted issuer.
 * Deliberately DISTINCT from a 404 (the page is genuinely gone or hidden from this
 * principal, which reads as an empty document) so a caller can offer a re-auth
 * affordance instead of silently rendering a blank page — the cross-server
 * lapsed-identity bug. Thrown by {@link HttpDataClient.getPage}.
 */
export class IdentityRejectedError extends Error {
  readonly status = 401 as const;
  constructor(detail?: string) {
    super(`identity rejected by the data server (401)${detail ? `: ${detail}` : ''}`);
    this.name = 'IdentityRejectedError';
  }
}

/**
 * {@link DataClient} backed by an OpenBook server's HTTP API. Isomorphic, and
 * transport-pluggable: by default it uses the global `fetch` + `EventSource`
 * (web, remote), but the desktop injects a `fetchImpl`/`createLiveSource` that
 * tunnel over its host IPC bridge to a portless Unix-socket server.
 */
export class HttpDataClient implements DataClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: FetchLike;
  private readonly createLiveSource: (url: string) => LiveSourceLike;
  private readonly getIdentity?: () => IdentityCredential | null | undefined;
  private live: LiveStream | null = null;
  /** Unsubscribe from identity-change notifications (see {@link dispose}). */
  private readonly identityUnsub?: () => void;

  /**
   * @param baseUrl  Server base URL. May be empty when a `fetchImpl` resolves
   *                 paths itself (the desktop IPC transport).
   * @param token    Optional access token required by a published (LAN) server;
   *                 sent as `Authorization: Bearer` on requests and `?token=` on
   *                 the SSE stream (EventSource can't set headers). Omit for a
   *                 loopback/local server, which needs none.
   * @param opts     Optional transport overrides (desktop IPC).
   */
  constructor(baseUrl: string, token?: string, opts: HttpDataClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token && token.length > 0 ? token : undefined;
    this.fetchImpl = opts.fetchImpl ?? globalFetch;
    this.createLiveSource = opts.createLiveSource ?? ((url) => new EventSource(url) as unknown as LiveSourceLike);
    this.getIdentity = opts.getIdentity;
    // Rebuild the live stream the moment the identity credential changes, so the
    // baked-in EventSource URL can't keep asserting a stale identity while one-shot
    // content fetches use the current one. Guarded to a real change by the setters
    // in connection.ts, so this never churns the connection on a no-op set.
    this.identityUnsub = opts.subscribeIdentity?.(() => this.live?.updateUrl(this.buildLiveUrl()));
  }

  /**
   * Release the identity-change subscription. Call when discarding a client (e.g.
   * the web shell swapping to a different server), so a stale client doesn't keep
   * reacting to identity changes for a connection nothing is watching. The live
   * stream itself is torn down when its last listener unsubscribes (React unmount).
   * Safe to call more than once.
   */
  dispose(): void {
    this.identityUnsub?.();
  }

  /**
   * `fetch` (or the injected transport) with the access token (instance gate)
   * and the caller's identity (who-you-are) attached. The two are distinct axes:
   * `Authorization: Bearer` is the reachability secret; `X-OpenBook-Identity` is
   * the verifiable user assertion. Identity is read fresh per request.
   */
  private authFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {...(init.headers as Record<string, string> | undefined)};
    // Mark the request as a first-party client call (STAB-8). Cheap and unconditional
    // so the server's guest-write gate admits it over every transport (desktop IPC,
    // web same-origin, forwarded tunnel — the tunnel forwards it verbatim).
    headers[CLIENT_HEADER] = '1';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const id = this.getIdentity?.();
    if (id?.jws) headers[IDENTITY_HEADER] = id.jws;
    if (id?.guestName) headers[GUEST_NAME_HEADER] = id.guestName;
    return this.fetchImpl(input, {...init, headers});
  }

  /**
   * The `/api/live` URL for the CURRENT credential. An EventSource can't send
   * headers, so the access token and the identity assertion both ride the query
   * string (the server reads `?token=` / `?identity=`). Read fresh each call so a
   * rebuilt stream picks up a refreshed / dropped identity.
   */
  private buildLiveUrl(): string {
    const params = new URLSearchParams();
    if (this.token) params.set('token', this.token);
    const id = this.getIdentity?.();
    if (id?.jws) params.set('identity', id.jws);
    const query = params.toString();
    return `${this.baseUrl}${API.live}${query ? `?${query}` : ''}`;
  }

  /** Lazily create — or re-point — the shared live connection (browser-only). */
  private liveStream(): LiveStream {
    const url = this.buildLiveUrl();
    if (!this.live) {
      this.live = new LiveStream(
        url,
        {
          listPages: () => this.listPages(),
          getPage: (id) => this.getPage(id),
          listRows: (databaseId) => this.listRows(databaseId),
        },
        this.createLiveSource,
      );
    } else {
      // A credential change since the stream opened (identity refresh / account
      // switch / sign-out) re-points it, so the streamed nav list can't keep
      // asserting a stale identity a new subscription would then out-rank. A no-op
      // when the URL is unchanged.
      this.live.updateUrl(url);
    }
    return this.live;
  }

  async listPages(): Promise<PageMeta[]> {
    return this.request<PageMeta[]>('GET', API.pages);
  }

  async getPage(id: string): Promise<StoredPage | null> {
    const res = await this.authFetch(`${this.baseUrl}${API.page(id)}`, {cache: 'no-store'});
    // 404 = genuinely gone / hidden from this principal → an empty document, not
    // an error. 401 = the identity was REJECTED (expired / wrong audience /
    // revoked) → an auth problem the caller must surface (re-auth), never
    // collapsed into "no content" (the blank-content-on-a-lapsed-identity bug).
    if (res.status === 404) return null;
    if (res.status === 401) throw new IdentityRejectedError(await readErrorDetail(res));
    await throwIfNotOk(res);
    return (await res.json()) as StoredPage;
  }

  async savePage(input: PageInput): Promise<StoredPage> {
    // Known id → PUT to that resource; otherwise POST to create.
    if (input.id) {
      return this.request<StoredPage>('PUT', API.page(input.id), input);
    }
    // ER-7: pre-mint the id for a keyless create so a retried/replayed POST (flaky
    // net, transport-level retry) re-sends the SAME id and the server's `ON CONFLICT`
    // makes the replay a no-op instead of minting a duplicate page. If the caller
    // already supplied an `idempotencyKey`, leave the create keyless — the server
    // dedupes the replay per-principal on that key instead.
    const body: PageInput = input.idempotencyKey ? input : {...input, id: globalThis.crypto.randomUUID()};
    return this.request<StoredPage>('POST', API.pages, body);
  }

  async renamePage(id: string, name: string | null): Promise<StoredPage> {
    return this.request<StoredPage>('PATCH', API.page(id), {name});
  }

  async setPageProperties(id: string, properties: Record<string, unknown>): Promise<StoredPage> {
    return this.request<StoredPage>('PATCH', API.pageProperties(id), {properties});
  }

  async listBacklinks(id: string): Promise<PageMeta[]> {
    return this.request<PageMeta[]>('GET', API.pageBacklinks(id));
  }

  async pageGraph(): Promise<PageGraph> {
    return this.request<PageGraph>('GET', API.pageGraph);
  }

  async listVersions(pageId: string, opts?: {limit?: number}): Promise<PageVersionMeta[]> {
    const query = opts?.limit != null ? `?limit=${encodeURIComponent(opts.limit)}` : '';
    return this.request<PageVersionMeta[]>('GET', `${API.pageVersions(pageId)}${query}`);
  }

  async getVersion(pageId: string, versionId: string): Promise<StoredPageVersion | null> {
    const res = await this.authFetch(`${this.baseUrl}${API.pageVersion(pageId, versionId)}`, {cache: 'no-store'});
    if (res.status === 404) return null;
    await throwIfNotOk(res);
    return (await res.json()) as StoredPageVersion;
  }

  async restoreVersion(pageId: string, versionId: string): Promise<StoredPage | null> {
    const res = await this.authFetch(`${this.baseUrl}${API.pageVersionRestore(pageId, versionId)}`, {method: 'POST'});
    if (res.status === 404) return null;
    await throwIfNotOk(res);
    return (await res.json()) as StoredPage;
  }

  async movePage(id: string, move: {parentId: string | null; orderedIds: string[]}): Promise<StoredPage> {
    return this.request<StoredPage>('PUT', API.pageMove(id), move);
  }

  async deletePage(id: string): Promise<boolean> {
    const res = await this.authFetch(`${this.baseUrl}${API.page(id)}`, {method: 'DELETE'});
    if (res.status === 404) return false;
    await throwIfNotOk(res);
    return true;
  }

  async exportLibrary(): Promise<{pages: StoredPage[]; databases: StoredDatabase[]; ledger?: LedgerBackupSection}> {
    return this.request<{pages: StoredPage[]; databases: StoredDatabase[]; ledger?: LedgerBackupSection}>('GET', API.exportLibrary);
  }

  async importLibrary(req: ImportRequest): Promise<ImportResult> {
    return this.request<ImportResult>('POST', API.importLibrary, req);
  }

  async listTrash(): Promise<PageMeta[]> {
    return this.request<PageMeta[]>('GET', API.trash);
  }

  async restorePage(id: string): Promise<StoredPage | null> {
    const res = await this.authFetch(`${this.baseUrl}${API.pageRestore(id)}`, {method: 'POST'});
    if (res.status === 404) return null;
    await throwIfNotOk(res);
    return (await res.json()) as StoredPage;
  }

  async purgePage(id: string): Promise<boolean> {
    const res = await this.authFetch(`${this.baseUrl}${API.trashItem(id)}`, {method: 'DELETE'});
    if (res.status === 404) return false;
    await throwIfNotOk(res);
    return true;
  }

  async emptyTrash(): Promise<number> {
    const {purged} = await this.request<{purged: number}>('DELETE', API.trash);
    return purged;
  }

  async compact(): Promise<CompactResult> {
    return this.request<CompactResult>('POST', API.compact);
  }

  subscribePage(id: string, handlers: PageSubscription): () => void {
    return this.liveStream().onPage(id, handlers);
  }

  subscribePages(onList: (pages: PageMeta[]) => void): () => void {
    return this.liveStream().onList(onList);
  }

  /** Reopen-after-drop reconnect signal (Collab T7) — tight post-reconnect catch-up. */
  subscribeReconnect(onReconnect: () => void): () => void {
    return this.liveStream().onReconnect(onReconnect);
  }

  /** Relay one incremental Yjs update (Collab T1); ephemeral, no store write. */
  async postPageUpdate(id: string, update: string, clientId: number): Promise<void> {
    const res = await this.authFetch(`${this.baseUrl}${API.pageUpdates(id)}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({update, clientId}),
      cache: 'no-store',
    });
    await throwIfNotOk(res);
  }

  subscribePageUpdates(id: string, onUpdate: (update: string, clientId: number) => void): () => void {
    return this.liveStream().onPageUpdate(id, onUpdate);
  }

  /** Late-joiner sync handshake (Collab T1): state vector in, missing ops out. */
  async syncPageUpdates(id: string, stateVector: string): Promise<string | null> {
    const {update} = await this.request<{update: string | null}>('POST', API.pageSync(id), {sv: stateVector});
    return update ?? null;
  }

  /** Publish ephemeral presence (Collab T4); read-gated, identity server-stamped. */
  async postPageAwareness(id: string, update: string, clientId: number): Promise<void> {
    const res = await this.authFetch(`${this.baseUrl}${API.pageAwareness(id)}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({update, clientId}),
      cache: 'no-store',
    });
    await throwIfNotOk(res);
  }

  subscribePageAwareness(id: string, onUpdate: (update: string, clientId: number) => void): () => void {
    return this.liveStream().onPageAwareness(id, onUpdate);
  }

  /** Current presence snapshot for a late joiner (Collab T4). */
  async syncPageAwareness(id: string): Promise<string[]> {
    const res = await this.authFetch(`${this.baseUrl}${API.pageAwareness(id)}`, {cache: 'no-store'});
    await throwIfNotOk(res);
    const {updates} = (await res.json()) as {updates?: string[]};
    return updates ?? [];
  }

  // ── Assets: content-addressed binary store (OB-ASSETS A2) ────────────────────

  /**
   * Upload asset bytes and ref them to `pageId`. The body is base64-JSON
   * (`{data, mime}`) rather than raw binary DELIBERATELY: the desktop IPC bridge
   * (`tauriFetch`) corrupts raw binary / stream request bodies, so base64 keeps
   * the upload byte-exact on BOTH the web-http and desktop-IPC transports.
   */
  async putAsset(bytes: Uint8Array, mime: string, pageId: string): Promise<{id: string}> {
    const res = await this.authFetch(`${this.baseUrl}${API.assets}?pageId=${encodeURIComponent(pageId)}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({data: bytesToBase64(bytes), mime}),
      cache: 'no-store',
    });
    await throwIfNotOk(res);
    return (await res.json()) as {id: string};
  }

  /**
   * Fetch an asset by content-hash id, decoding the base64-JSON variant
   * (`?encoding=base64`) — again to stay byte-safe over the desktop IPC bridge,
   * which corrupts raw binary responses. `null` on 404 (missing or read-gated).
   *
   * A5 decision — base64 single-shot over the desktop's `tauriFetch`, NOT the
   * streaming `tauriStreamFetch` (which stays tunnel-only): assets are capped at
   * 10 MiB, and `getAsset` must materialize the FULL bytes anyway (its consumer
   * wraps them in a `Blob`/object-URL), so streaming buys no client-side memory
   * win — it would only spare the server a whole-asset base64 pass. Wiring it would
   * mean threading a second transport through this one `fetchImpl` abstraction for a
   * bounded (~13 MiB transient) payload — cost > benefit. Buffered base64-JSON is
   * the right call at this cap; revisit only if the cap is ever raised materially.
   *
   * `cache: 'no-store'` keeps this byte-exact across all three transports (IPC
   * base64, web, tunnel) — it never relies on the browser HTTP cache, so it holds
   * the object-URL in-app instead. The server's content-addressed `ETag`/304 (A5)
   * still shortcuts a browser's OWN cache-revalidation for any DIRECT `<img src>`
   * fetch of the asset URL (notably through a *.book.pub tunnel, where the browser
   * caches the first response), which is a separate, non-`no-store` code path.
   */
  async getAsset(id: string): Promise<{bytes: Uint8Array; mime: string} | null> {
    const res = await this.authFetch(`${this.baseUrl}${API.asset(id)}?encoding=base64`, {cache: 'no-store'});
    if (res.status === 404) return null;
    await throwIfNotOk(res);
    const body = (await res.json()) as {mime: string; data: string};
    return {bytes: base64ToBytes(body.data), mime: body.mime};
  }

  // ── Databases ──────────────────────────────────────────────────────────────

  async createDatabase(input: DatabaseInput): Promise<StoredDatabase> {
    return this.request<StoredDatabase>('POST', API.databases, input);
  }

  async getDatabase(id: string): Promise<StoredDatabase | null> {
    const res = await this.authFetch(`${this.baseUrl}${API.database(id)}`, {cache: 'no-store'});
    if (res.status === 404) return null;
    await throwIfNotOk(res);
    return (await res.json()) as StoredDatabase;
  }

  async getPageDatabase(pageId: string): Promise<StoredDatabase | null> {
    const res = await this.authFetch(`${this.baseUrl}${API.pageDatabase(pageId)}`, {cache: 'no-store'});
    if (res.status === 404) return null;
    await throwIfNotOk(res);
    return (await res.json()) as StoredDatabase;
  }

  async updateDatabase(id: string, patch: DatabaseUpdate): Promise<StoredDatabase> {
    return this.request<StoredDatabase>('PATCH', API.database(id), patch);
  }

  async deleteDatabase(id: string): Promise<boolean> {
    const res = await this.authFetch(`${this.baseUrl}${API.database(id)}`, {method: 'DELETE'});
    if (res.status === 404) return false;
    await throwIfNotOk(res);
    return true;
  }

  async listRows(databaseId: string): Promise<DatabaseRow[]> {
    return this.request<DatabaseRow[]>('GET', API.databaseRows(databaseId));
  }

  async createRow(databaseId: string, input: RowInput = {}): Promise<StoredPage> {
    return this.request<StoredPage>('POST', API.databaseRows(databaseId), input);
  }

  async updateRow(databaseId: string, rowId: string, patch: RowUpdate): Promise<DatabaseRow> {
    return this.request<DatabaseRow>('PATCH', API.databaseRow(databaseId, rowId), patch);
  }

  async reorderRows(databaseId: string, orderedIds: string[]): Promise<void> {
    await this.request<{ok: boolean}>('PUT', API.databaseRowsOrder(databaseId), {orderedIds});
  }

  subscribeRows(databaseId: string, onRows: (rows: DatabaseRow[]) => void): () => void {
    return this.liveStream().onRows(databaseId, onRows);
  }

  // ── Ledger: server-enforced double-entry accounting (LGR-3) ──────────────────

  /**
   * Like {@link request}, but re-materializes the server's `{error, code}` body
   * into a typed {@link LedgerError} — so a caller catches the SAME error class
   * over HTTP as it does against the in-process {@link PageStore} (local mode).
   */
  private async ledgerRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.authFetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : {'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    if (!res.ok) return this.throwLedgerError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Re-materialize a non-2xx ledger response into a typed {@link LedgerError}. */
  private async throwLedgerError(res: Response): Promise<never> {
    let data: {error?: string; code?: string} | null = null;
    try {
      data = (await res.json()) as {error?: string; code?: string};
    } catch {
      data = null;
    }
    if (data?.code && (LEDGER_ERROR_CODES as readonly string[]).includes(data.code)) {
      throw new LedgerError(data.code as LedgerErrorCode, data.error ?? `ledger request failed (${res.status})`);
    }
    throw new Error(`OpenBook request failed (${res.status} ${res.statusText})${data?.error ? `: ${data.error}` : ''}`);
  }

  ledgerRestoreSection(section: LedgerExportSection): Promise<LedgerSectionRestoreResult> {
    return this.ledgerRequest<LedgerSectionRestoreResult>('POST', API.ledgerRestoreSection, section);
  }

  ledgerInfo(): Promise<LedgerInfo> {
    return this.ledgerRequest<LedgerInfo>('GET', API.ledger);
  }

  ledgerInit(): Promise<LedgerInfo> {
    return this.ledgerRequest<LedgerInfo>('POST', API.ledger);
  }

  ledgerListAccounts(): Promise<LedgerAccount[]> {
    return this.ledgerRequest<LedgerAccount[]>('GET', API.ledgerAccounts);
  }

  ledgerCreateAccount(input: LedgerAccountInput): Promise<LedgerAccount> {
    return this.ledgerRequest<LedgerAccount>('POST', API.ledgerAccounts, input);
  }

  async ledgerGetAccount(id: string): Promise<LedgerAccount | null> {
    try {
      return await this.ledgerRequest<LedgerAccount>('GET', API.ledgerAccount(id));
    } catch (err) {
      if (err instanceof LedgerError && err.code === 'not-found') return null;
      throw err;
    }
  }

  ledgerUpdateAccount(id: string, patch: LedgerAccountPatch): Promise<LedgerAccount> {
    return this.ledgerRequest<LedgerAccount>('PATCH', API.ledgerAccount(id), patch);
  }

  ledgerListTransactions(opts?: {state?: LedgerTransactionState; limit?: number}): Promise<LedgerTransaction[]> {
    const params = new URLSearchParams();
    if (opts?.state) params.set('state', opts.state);
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    const query = params.toString();
    return this.ledgerRequest<LedgerTransaction[]>('GET', `${API.ledgerTransactions}${query ? `?${query}` : ''}`);
  }

  async ledgerGetTransaction(id: string): Promise<LedgerTransaction | null> {
    try {
      return await this.ledgerRequest<LedgerTransaction>('GET', API.ledgerTransaction(id));
    } catch (err) {
      if (err instanceof LedgerError && err.code === 'not-found') return null;
      throw err;
    }
  }

  ledgerCreateDraft(input: LedgerDraftInput): Promise<LedgerTransaction> {
    return this.ledgerRequest<LedgerTransaction>('POST', API.ledgerTransactions, input);
  }

  ledgerUpdateDraft(id: string, patch: LedgerDraftPatch): Promise<LedgerTransaction> {
    return this.ledgerRequest<LedgerTransaction>('PATCH', API.ledgerTransaction(id), patch);
  }

  async ledgerDeleteDraft(id: string): Promise<boolean> {
    await this.ledgerRequest<void>('DELETE', API.ledgerTransaction(id));
    return true;
  }

  ledgerPostTransaction(id: string): Promise<LedgerTransaction> {
    return this.ledgerRequest<LedgerTransaction>('POST', API.ledgerTransactionPost(id));
  }

  ledgerReverseTransaction(id: string, opts?: LedgerReverseOptions): Promise<LedgerTransaction> {
    return this.ledgerRequest<LedgerTransaction>('POST', API.ledgerTransactionReverse(id), opts ?? {});
  }

  ledgerSetPostingCleared(postingId: string, cleared: LedgerClearedState): Promise<LedgerPosting> {
    return this.ledgerRequest<LedgerPosting>('PUT', API.ledgerPostingCleared(postingId), {cleared});
  }

  // ── Statement reconciliation (LGR-11) ───────────────────────────────────────

  ledgerListReconciliations(opts?: {accountId?: string; status?: LedgerReconciliationStatus}): Promise<LedgerReconciliation[]> {
    const params = new URLSearchParams();
    if (opts?.accountId != null) params.set('accountId', opts.accountId);
    if (opts?.status != null) params.set('status', opts.status);
    const query = params.toString();
    return this.ledgerRequest<LedgerReconciliation[]>('GET', `${API.ledgerReconciliations}${query ? `?${query}` : ''}`);
  }

  async ledgerGetReconciliation(id: string): Promise<LedgerReconciliationSummary | null> {
    try {
      return await this.ledgerRequest<LedgerReconciliationSummary>('GET', API.ledgerReconciliation(id));
    } catch (err) {
      if (err instanceof LedgerError && err.code === 'not-found') return null;
      throw err;
    }
  }

  ledgerStartReconciliation(input: LedgerReconciliationInput): Promise<LedgerReconciliation> {
    return this.ledgerRequest<LedgerReconciliation>('POST', API.ledgerReconciliations, input);
  }

  ledgerAmendReconciliation(id: string, patch: LedgerReconciliationPatch): Promise<LedgerReconciliationSummary> {
    return this.ledgerRequest<LedgerReconciliationSummary>('PATCH', API.ledgerReconciliation(id), patch);
  }

  ledgerAbandonReconciliation(id: string): Promise<LedgerReconciliation> {
    return this.ledgerRequest<LedgerReconciliation>('POST', API.ledgerReconciliationAbandon(id));
  }

  ledgerToggleReconciliationPosting(id: string, postingId: string, cleared: 'pending' | 'cleared'): Promise<LedgerReconciliationSummary> {
    return this.ledgerRequest<LedgerReconciliationSummary>('PUT', API.ledgerReconciliationPosting(id, postingId), {cleared});
  }

  ledgerFinishReconciliation(id: string): Promise<LedgerReconciliationSummary> {
    return this.ledgerRequest<LedgerReconciliationSummary>('POST', API.ledgerReconciliationFinish(id));
  }

  ledgerReopenReconciliation(id: string): Promise<LedgerReconciliationSummary> {
    return this.ledgerRequest<LedgerReconciliationSummary>('POST', API.ledgerReconciliationReopen(id));
  }

  ledgerListPeriods(): Promise<LedgerPeriod[]> {
    return this.ledgerRequest<LedgerPeriod[]>('GET', API.ledgerPeriods);
  }

  ledgerClosePeriod(input: LedgerPeriodCloseInput): Promise<LedgerPeriodCloseResult> {
    return this.ledgerRequest<LedgerPeriodCloseResult>('POST', API.ledgerPeriods, input);
  }

  ledgerReopenPeriod(id: string): Promise<LedgerPeriodReopenResult> {
    return this.ledgerRequest<LedgerPeriodReopenResult>('POST', API.ledgerPeriodReopen(id));
  }

  ledgerListAudit(opts?: {limit?: number; before?: number}): Promise<LedgerAuditEvent[]> {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.before != null) params.set('before', String(opts.before));
    const query = params.toString();
    return this.ledgerRequest<LedgerAuditEvent[]>('GET', `${API.ledgerAudit}${query ? `?${query}` : ''}`);
  }

  /** Canonical postings CSV (LGR-7) — a ledger read that is text, not JSON. */
  async ledgerExportCsv(): Promise<string> {
    const res = await this.authFetch(`${this.baseUrl}${API.ledgerExportCsv}`, {cache: 'no-store'});
    if (!res.ok) return this.throwLedgerError(res);
    return res.text();
  }

  /** Beancount journal (LGR-13) — text like the CSV, same error mapping. */
  async ledgerExportBeancount(): Promise<string> {
    const res = await this.authFetch(`${this.baseUrl}${API.ledgerExportBeancount}`, {cache: 'no-store'});
    if (!res.ok) return this.throwLedgerError(res);
    return res.text();
  }

  /** The independent verifier's report (admin-gated server-side). */
  async ledgerVerify(): Promise<LedgerVerifyReport> {
    return this.ledgerRequest<LedgerVerifyReport>('GET', API.ledgerVerify);
  }

  // ── Suggestions + comments (the review layer) ────────────────────────────────

  async listSuggestions(pageId: string, status?: SuggestionStatus): Promise<StoredSuggestion[]> {
    const path = status ? `${API.suggestions(pageId)}?status=${encodeURIComponent(status)}` : API.suggestions(pageId);
    return this.request<StoredSuggestion[]>('GET', path);
  }

  async createSuggestion(input: SuggestionInput): Promise<StoredSuggestion> {
    return this.request<StoredSuggestion>('POST', API.suggestions(input.pageId), input);
  }

  async updateSuggestion(id: string, patch: SuggestionUpdate): Promise<StoredSuggestion> {
    return this.request<StoredSuggestion>('PATCH', API.suggestion(id), patch);
  }

  async deleteSuggestion(id: string): Promise<boolean> {
    const res = await this.authFetch(`${this.baseUrl}${API.suggestion(id)}`, {method: 'DELETE'});
    if (res.status === 404) return false;
    await throwIfNotOk(res);
    return true;
  }

  async listComments(pageId: string): Promise<StoredComment[]> {
    return this.request<StoredComment[]>('GET', API.comments(pageId));
  }

  async createComment(input: CommentInput): Promise<StoredComment> {
    return this.request<StoredComment>('POST', API.comments(input.pageId), input);
  }

  async deleteComment(id: string): Promise<boolean> {
    const res = await this.authFetch(`${this.baseUrl}${API.comment(id)}`, {method: 'DELETE'});
    if (res.status === 404) return false;
    await throwIfNotOk(res);
    return true;
  }

  // ── Multi-user: identity, policy, provenance (OB-165) ────────────────────────

  async getInstanceInfo(): Promise<InstanceInfo> {
    return this.request<InstanceInfo>('GET', API.instance);
  }

  async setInstancePolicy(patch: Partial<InstanceConfig>): Promise<InstanceConfig> {
    return this.request<InstanceConfig>('PUT', API.instance, patch);
  }

  async listPageEdits(pageId: string, limit?: number): Promise<StoredEdit[]> {
    const path = limit ? `${API.pageEdits(pageId)}?limit=${limit}` : API.pageEdits(pageId);
    return this.request<StoredEdit[]>('GET', path);
  }

  // ── Sharing: roster invites + per-page ACL (OB-191) ──────────────────────────

  /** The member roster (instance-writer only). */
  async listMembers(): Promise<Member[]> {
    return this.request<Member[]>('GET', API.members);
  }

  /**
   * Invite someone to the roster by `invitee` — an email (an unclaimed persona,
   * bound to their subject on first sign-in), or a handle/subject (`iss#sub`,
   * granted immediately). `status` defaults server-side (email → `invited`,
   * subject → `active`).
   */
  async inviteMember(invitee: string, opts: {role?: MemberRole; status?: MemberStatus} = {}): Promise<Member> {
    return this.request<Member>('POST', API.members, {invitee, role: opts.role, status: opts.status});
  }

  /** Patch a roster row's role/status (activate, suspend, change role). */
  async updateMember(id: string, patch: {role?: MemberRole; status?: MemberStatus}): Promise<Member> {
    return this.request<Member>('PATCH', API.member(id), patch);
  }

  /** Revoke a roster row by id. `true` if one was removed. */
  async removeMember(id: string): Promise<boolean> {
    const res = await this.authFetch(`${this.baseUrl}${API.member(id)}`, {method: 'DELETE'});
    if (res.status === 404) return false;
    await throwIfNotOk(res);
    return true;
  }

  // ── Agent access: PAT credential management (AGENT-6; admin-only) ─────────────

  async listAgentTokens(): Promise<AgentTokenList> {
    return this.request<AgentTokenList>('GET', API.agentTokens);
  }

  async setAgentApiEnabled(enabled: boolean, remote = false): Promise<{enabled: boolean; remote: boolean}> {
    return this.request<{enabled: boolean; remote: boolean}>('PUT', API.agentTokens, {enabled, remote});
  }

  async createAgentToken(input: CreateAgentTokenInput): Promise<CreatedAgentToken> {
    return this.request<CreatedAgentToken>('POST', API.agentTokens, {
      name: input.name,
      scope: input.scope,
      expiresInDays: input.expiresInDays,
      remote: input.remote,
    });
  }

  async revokeAgentToken(id: string): Promise<boolean> {
    const res = await this.authFetch(`${this.baseUrl}${API.agentToken(id)}`, {method: 'DELETE'});
    if (res.status === 404) return false;
    await throwIfNotOk(res);
    return true;
  }

  /** A page's stored visibility scope (raw — `inherit` not yet resolved), or
   *  `null` if the page does not exist. Gated on read of the page. */
  async getPageVisibility(pageId: string): Promise<PageVisibility | null> {
    const {visibility} = await this.request<{visibility: PageVisibility}>('GET', API.pageVisibility(pageId));
    return visibility;
  }

  /** Set a page's visibility scope. Gated on write of the page (manage = write). */
  async setPageVisibility(pageId: string, visibility: PageVisibility): Promise<PageVisibility> {
    const res = await this.request<{visibility: PageVisibility}>('PUT', API.pageVisibility(pageId), {visibility});
    return res.visibility;
  }

  /** A page's agent-edits policy (AGED-1; raw — `inherit` not yet resolved against
   *  the instance mode). Gated on read of the page. */
  async getPageAgentEdits(pageId: string): Promise<AgentEditsPolicy> {
    const {agentEdits} = await this.request<{agentEdits: AgentEditsPolicy}>('GET', API.pageAgentEdits(pageId));
    return agentEdits;
  }

  /** A page's server-resolved effective agent-edits mode (AGED-6). Reads the same
   *  PAT-readable route as {@link getPageAgentEdits} and returns its `effective`
   *  field — so an `inherit` page's mode resolves without the privileged instance read. */
  async getEffectiveAgentEdits(pageId: string): Promise<AgentEditsMode> {
    const {effective} = await this.request<{effective: AgentEditsMode}>('GET', API.pageAgentEdits(pageId));
    return effective;
  }

  /** Set a page's agent-edits policy (AGED-1). jws-only: an agent PAT cannot change
   *  the policy that governs whether agents edit directly. */
  async setPageAgentEdits(pageId: string, agentEdits: AgentEditsPolicy): Promise<AgentEditsPolicy> {
    const res = await this.request<{agentEdits: AgentEditsPolicy}>('PUT', API.pageAgentEdits(pageId), {agentEdits});
    return res.agentEdits;
  }

  /** A page's per-page ACL grants (requires write on the page). */
  async listPageAcl(pageId: string): Promise<PageAcl[]> {
    return this.request<PageAcl[]>('GET', API.pageAcl(pageId));
  }

  /** Share a page with `invitee` (email or handle/subject) at `level`. */
  async sharePage(pageId: string, invitee: string, level: AclLevel = 'read'): Promise<PageAcl> {
    return this.request<PageAcl>('POST', API.pageAcl(pageId), {invitee, level});
  }

  /** Revoke a page ACL grant by subject XOR email. `true` if one was removed. */
  async unsharePage(pageId: string, key: {subject: string} | {email: string}): Promise<boolean> {
    const query = 'subject' in key ? `subject=${encodeURIComponent(key.subject)}` : `email=${encodeURIComponent(key.email)}`;
    const res = await this.authFetch(`${this.baseUrl}${API.pageAcl(pageId)}?${query}`, {method: 'DELETE'});
    if (res.status === 404) return false;
    await throwIfNotOk(res);
    return true;
  }

  async getBackupStatus(): Promise<BackupStatus> {
    return this.request<BackupStatus>('GET', API.backups);
  }

  async setBackupConfig(patch: Partial<BackupConfig>): Promise<BackupStatus> {
    return this.request<BackupStatus>('PUT', API.backups, patch);
  }

  async runBackup(cadence?: BackupCadence): Promise<{file: string; dir: string}> {
    return this.request<{file: string; dir: string}>('POST', API.backupRun, {cadence});
  }

  // ── Optional local AI ───────────────────────────────────────────────────────

  async aiStatus(): Promise<AiStatus> {
    return this.request<AiStatus>('GET', API.aiStatus);
  }

  async aiSetConfig(config: AiConfig): Promise<AiConfig> {
    return this.request<AiConfig>('PUT', API.aiConfig, config);
  }

  async aiIndex(): Promise<{pages: number; chunks: number}> {
    return this.request<{pages: number; chunks: number}>('POST', API.aiIndex);
  }

  async aiSearch(query: string, limit?: number): Promise<AiSearchResponse> {
    return this.request<AiSearchResponse>('POST', API.aiSearch, {query, limit});
  }

  async aiTasks(goal: string, context?: string): Promise<AiTasksResponse> {
    return this.request<AiTasksResponse>('POST', API.aiTasks, {goal, context});
  }

  async aiDownloadModel(url?: string): Promise<AiStatus['download']> {
    return this.request<AiStatus['download']>('POST', API.aiModelDownload, {url});
  }

  /**
   * Stream a document completion. `onToken` fires per token; resolves with
   * the full text. Abort via the optional signal.
   */
  async aiComplete(
    text: string,
    onToken: (token: string) => void,
    opts: {instruction?: string; signal?: AbortSignal} = {},
  ): Promise<string> {
    return this.aiStream(API.aiComplete, {text, instruction: opts.instruction}, onToken, opts.signal);
  }

  /** Stream a raw generation (prompt + optional system). */
  async aiGenerate(
    prompt: string,
    onToken: (token: string) => void,
    opts: {system?: string; maxTokens?: number; signal?: AbortSignal} = {},
  ): Promise<string> {
    return this.aiStream(API.aiGenerate, {prompt, system: opts.system, maxTokens: opts.maxTokens}, onToken, opts.signal);
  }

  async listPlugins(): Promise<StoredPlugin[]> {
    return this.request<StoredPlugin[]>('GET', API.plugins);
  }

  async installPlugin(pkg: PluginPackage, opts: {allowDowngrade?: boolean} = {}): Promise<StoredPlugin> {
    const path = opts.allowDowngrade ? `${API.plugins}?allowDowngrade=1` : API.plugins;
    return this.request<StoredPlugin>('POST', path, pkg);
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<StoredPlugin> {
    return this.request<StoredPlugin>('PATCH', API.plugin(id), {enabled});
  }

  async removePlugin(id: string): Promise<boolean> {
    const res = await this.authFetch(`${this.baseUrl}${API.plugin(id)}`, {method: 'DELETE'});
    if (res.status === 404) return false;
    await throwIfNotOk(res);
    return true;
  }

  async aiSkills(): Promise<AiSkill[]> {
    return this.request<AiSkill[]>('GET', API.aiSkills);
  }

  async aiSaveSkill(skill: AiSkill): Promise<AiSkill> {
    return this.request<AiSkill>('PUT', API.aiSkills, {skill});
  }

  async aiDeleteSkill(name: string): Promise<boolean> {
    const {removed} = await this.request<{removed: boolean}>('DELETE', API.aiSkill(name));
    return removed;
  }

  async getAiPricing(): Promise<AiPricingResponse> {
    return this.request<AiPricingResponse>('GET', API.aiPricing);
  }

  async setAiPricing(override: AiPricingTable): Promise<AiPricingResponse> {
    return this.request<AiPricingResponse>('PUT', API.aiPricing, override);
  }

  async getMcpConfig(): Promise<McpConfigResponse> {
    return this.request<McpConfigResponse>('GET', API.aiMcp);
  }

  async putMcpConfig(config: McpClientConfig): Promise<McpConfigResponse> {
    return this.request<McpConfigResponse>('PUT', API.aiMcp, config);
  }

  async testMcpServer(server: McpServerConfig): Promise<McpTestResult> {
    return this.request<McpTestResult>('POST', API.aiMcpTest, server);
  }

  async getAiUsage(): Promise<AiUsageResponse> {
    return this.request<AiUsageResponse>('GET', API.aiUsage);
  }

  async setAiUsageRetention(days: number): Promise<{days: number}> {
    return this.request<{days: number}>('PUT', API.aiUsageRetention, {days});
  }

  /** Run the library agent, surfacing each streamed step via `onEvent`. */
  async agentChat(
    messages: AgentChatMessage[],
    onEvent: (event: AgentChatEvent) => void,
    opts: AgentChatOptions = {},
  ): Promise<void> {
    const res = await this.authFetch(`${this.baseUrl}${API.agentChat}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({messages, provider: opts.provider, model: opts.model, effort: opts.effort, thinking: opts.thinking, skills: opts.skills, pageId: opts.pageId, selection: opts.selection, allowDirectEdits: opts.allowDirectEdits, allowExternalTools: opts.allowExternalTools, externalToolsUsed: opts.externalToolsUsed}),
      cache: 'no-store',
      signal: opts.signal,
    });
    await throwIfNotOk(res);
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        let event: AgentChatEvent & {done?: boolean};
        try {
          event = JSON.parse(line.slice(5)) as AgentChatEvent & {done?: boolean};
        } catch {
          continue; // partial frame
        }
        if (event.done) return;
        onEvent(event);
      }
    }
  }

  /** POST a body and consume the SSE token stream the AI endpoints emit. */
  private async aiStream(
    path: string,
    body: unknown,
    onToken: (token: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const res = await this.authFetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
      cache: 'no-store',
      signal,
    });
    await throwIfNotOk(res);
    if (!res.body) return '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const event = JSON.parse(line.slice(5)) as AiStreamEvent;
          if (event.error) throw new Error(event.error);
          if (event.token) {
            full += event.token;
            onToken(event.token);
          }
        } catch (err) {
          if (err instanceof SyntaxError) continue; // partial frame
          throw err;
        }
      }
    }
    return full;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.authFetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : {'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
      // Always hit the server: the desktop WKWebView otherwise serves cached
      // GETs (e.g. a stale empty `GET /api/trash`). See the server's no-store header.
      cache: 'no-store',
    });
    await throwIfNotOk(res);
    return (await res.json()) as T;
  }
}

/**
 * Isomorphic base64 for asset bytes (browser + Node + the Bun sidecar), used by
 * {@link HttpDataClient.putAsset}/{@link HttpDataClient.getAsset}. `btoa` chokes
 * on a huge `String.fromCharCode(...bytes)` spread (call-stack overflow at ~100k
 * args), so encode in 32 KiB chunks — comfortable for a 10 MiB asset.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Inverse of {@link bytesToBase64}: decode a base64 string to raw bytes. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function throwIfNotOk(res: Response): Promise<void> {
  if (res.ok) return;
  const detail = await readErrorDetail(res);
  throw new Error(`OpenBook request failed (${res.status} ${res.statusText})${detail ? `: ${detail}` : ''}`);
}

/** The server's `{error}` message from a non-ok response body, or `''`. */
async function readErrorDetail(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as ApiError;
    return data?.error ? String(data.error) : '';
  } catch {
    return ''; // non-JSON error body
  }
}
