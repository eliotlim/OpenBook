import type {
  AclLevel,
  AgentEditsMode,
  AgentEditsPolicy,
  AgentTokenList,
  CreatedAgentToken,
  AiConfig,
  AiPricingResponse,
  AiPricingTable,
  AiUsageResponse,
  AiSearchResponse,
  AiSkill,
  AiStatus,
  AiTasksResponse,
  CommentInput,
  CompactResult,
  DataClient,
  DatabaseInput,
  DatabaseRow,
  DatabaseUpdate,
  BackupConfig,
  BackupStatus,
  ImportRequest,
  ImportResult,
  InstanceConfig,
  InstanceInfo,
  LedgerAccount,
  LedgerAccountInput,
  LedgerAccountPatch,
  LedgerAuditEvent,
  LedgerClearedState,
  LedgerDraftInput,
  LedgerDraftPatch,
  LedgerInfo,
  LedgerPosting,
  LedgerReconciliation,
  LedgerReconciliationInput,
  LedgerReconciliationPatch,
  LedgerReconciliationStatus,
  LedgerReconciliationSummary,
  LedgerReverseOptions,
  LedgerTransaction,
  LedgerTransactionState,
  McpClientConfig,
  McpConfigResponse,
  McpTestResult,
  Member,
  MemberRole,
  MemberStatus,
  PageAcl,
  PageGraph,
  PageInput,
  PageMeta,
  PageVersionMeta,
  PageSubscription,
  StoredPageVersion,
  PageVisibility,
  PluginPackage,
  RowInput,
  RowUpdate,
  StoredComment,
  StoredDatabase,
  StoredEdit,
  StoredPage,
  StoredPlugin,
  StoredSuggestion,
  SuggestionInput,
  SuggestionStatus,
  SuggestionUpdate,
} from '@book.dev/sdk';
import {BACKUP_CADENCES, BACKUP_CADENCE_MS, localPrincipal, resolveAgentEdits} from '@book.dev/sdk';
import {PageStore} from './store';
import {LocalSearchIndex} from './ai/localSearch';
import {PageHub} from './hub';
import {CollabRelay} from './collab';
import {AwarenessRelay, awarenessUser, stampAwarenessIdentity} from './collabAwareness';
import {resolveInvitee} from './invites';

/**
 * A {@link DataClient} that talks to a {@link PageStore} directly, in the same
 * process — no HTTP, no port. This is what runs the app/web *in the webview*:
 * the store sits on an embedded PGlite (IndexedDB in the browser), and live
 * updates ride an in-memory {@link PageHub} instead of an SSE stream.
 *
 * The mutation methods reproduce, one-for-one, the publish wiring the HTTP app
 * performs after each write (`packages/server/src/app.ts`) so an open editor,
 * the sidebar, and database views stay live exactly as they do against a remote
 * server — a second window on the same store sees every change. The contract is
 * identical to {@link HttpDataClient}; only the transport differs, so the
 * desktop/web can switch between "in-app" and "connect to a server" with no
 * change to the document code.
 *
 * The optional AI subsystem is server-hosted, so in this in-webview mode it is
 * reported as unavailable rather than wired to a (nonexistent) engine.
 */
export class LocalDataClient implements DataClient {
  // Live-collaboration catch-up memory (Collab T1) — mirrors the HTTP app's relay
  // so a second in-process window can sync to the current doc. Persists nothing.
  private readonly relay = new CollabRelay();
  // Ephemeral presence (Collab T4) — mirrors the HTTP app's awareness relay so a
  // second in-process window sees presence + a late joiner gets the snapshot.
  private readonly awarenessRelay = new AwarenessRelay();
  // In-webview lexical content search (no AI engine needed) — the local
  // counterpart to the server's AiService search, kept fresh by write broadcasts.
  private readonly searchIndex: LocalSearchIndex;

  constructor(
    private readonly store: PageStore,
    private readonly hub: PageHub = new PageHub(),
  ) {
    this.searchIndex = new LocalSearchIndex(store);
  }

  /** Release the underlying store (its PGlite connection). Used when swapping
   *  clients — e.g. the desktop moving between in-app and a published server. */
  close(): Promise<void> {
    return this.store.close();
  }

  // ── Live-update broadcasts (mirror app.ts's broadcastList/broadcastRows) ─────

  private async broadcastList(): Promise<void> {
    this.searchIndex.invalidate(); // any list-changing write staleness-marks search (mirrors app.ts)
    this.hub.publishList(await this.store.listPages());
  }

  private async broadcastRows(databaseId: string): Promise<void> {
    this.searchIndex.invalidate(); // rows are pages too; a row write staleness-marks search
    // Skip the row query when nobody is watching — same guard the HTTP app uses.
    if (!this.hub.hasRowsListeners(databaseId)) return;
    this.hub.publishRows(databaseId, await this.store.listRows(databaseId));
  }

  // ── Pages ────────────────────────────────────────────────────────────────────

  listPages(): Promise<PageMeta[]> {
    return this.store.listPages();
  }

  getPage(id: string): Promise<StoredPage | null> {
    return this.store.getPage(id);
  }

  async savePage(input: PageInput): Promise<StoredPage> {
    const page = await this.store.upsertPage(input, localPrincipal());
    this.hub.publishPage(page);
    await this.broadcastList();
    if (page.databaseId) await this.broadcastRows(page.databaseId);
    return page;
  }

  async renamePage(id: string, name: string | null): Promise<StoredPage> {
    const page = await this.store.renamePage(id, name);
    if (!page) throw new Error('page not found');
    this.hub.publishPage(page);
    await this.broadcastList();
    return page;
  }

  async setPageProperties(id: string, properties: Record<string, unknown>): Promise<StoredPage> {
    const page = await this.store.setPageProperties(id, properties);
    if (!page) throw new Error('page not found');
    this.hub.publishPage(page);
    // The icon shows in the sidebar (part of PageMeta), so re-stream the list
    // when it changes; other properties don't affect the list.
    if ('sys_icon' in properties) await this.broadcastList();
    if (page.databaseId) await this.broadcastRows(page.databaseId);
    return page;
  }

  listBacklinks(id: string): Promise<PageMeta[]> {
    return this.store.listBacklinks(id);
  }

  // In-webview = single principal with full read access, so the graph is returned
  // unfiltered (no per-principal canReadPage predicate) — the same posture as
  // listBacklinks/listPages here. The HTTP transport is where per-principal read
  // gating applies on a shared instance.
  pageGraph(): Promise<PageGraph> {
    return this.store.pageGraph();
  }

  // ── Page version history (PVH-3) ─────────────────────────────────────────────

  listVersions(pageId: string, opts?: {limit?: number}): Promise<PageVersionMeta[]> {
    return this.store.listPageVersions(pageId, opts?.limit);
  }

  getVersion(pageId: string, versionId: string): Promise<StoredPageVersion | null> {
    return this.store.getPageVersion(pageId, versionId);
  }

  async restoreVersion(pageId: string, versionId: string): Promise<StoredPage | null> {
    const version = await this.store.getPageVersion(pageId, versionId);
    if (!version) return null;
    // Preserve the page's current name — only the document content rolls back.
    // Writing the old snapshot back captures the current state as a fresh version
    // (PVH-1), so a restore is non-destructive. `captureMode: 'force'` bypasses the
    // 45s coalesce window so restoring right after a save can't lose the pre-restore
    // state (parity with the HTTP restore route). Mirrors savePage's publish wiring.
    const existing = await this.store.getPage(pageId);
    if (!existing) return null;
    const page = await this.store.upsertPage(
      {id: pageId, name: existing.name, data: version.data},
      localPrincipal(),
      {captureMode: 'force'},
    );
    // The restore wrote the old snapshot straight through `upsertPage`, bypassing the
    // /updates collab stream — so a relay doc a second window is syncing against still
    // holds the pre-restore state. Drop it so its next /sync reseeds from the restored
    // snapshot (parity with the HTTP restore route; PVH-8).
    this.relay.forget(pageId);
    this.hub.publishPage(page);
    await this.broadcastList();
    if (page.databaseId) await this.broadcastRows(page.databaseId);
    return page;
  }

  async movePage(id: string, move: {parentId: string | null; orderedIds: string[]}): Promise<StoredPage> {
    const existing = await this.store.getPage(id);
    if (!existing) throw new Error('page not found');
    const page = await this.store.movePage(id, move.parentId, move.orderedIds);
    if (!page) throw new Error('invalid move (would create a cycle)');
    this.hub.publishPage(page);
    await this.broadcastList();
    return page;
  }

  async deletePage(id: string): Promise<boolean> {
    // Learn the page's database membership before it's gone, to refresh that
    // database's row list after the delete.
    const existing = await this.store.getPage(id);
    const deleted = await this.store.deletePage(id);
    if (!deleted) return false;
    this.hub.publishDeleted(id);
    this.relay.forget(id); // free the page's relay doc (Collab T1); reseeds if restored
    this.awarenessRelay.forget(id); // drop any lingering presence (Collab T4)
    await this.broadcastList();
    if (existing?.databaseId) await this.broadcastRows(existing.databaseId);
    return true;
  }

  exportLibrary(): Promise<{pages: StoredPage[]; databases: StoredDatabase[]}> {
    return this.store.exportAll();
  }

  async importLibrary(req: ImportRequest): Promise<ImportResult> {
    const result = await this.store.importBundle(req);
    await this.broadcastList();
    return result;
  }

  listTrash(): Promise<PageMeta[]> {
    return this.store.listTrash();
  }

  async restorePage(id: string): Promise<StoredPage | null> {
    const page = await this.store.restorePage(id);
    if (!page) return null;
    this.hub.publishPage(page);
    await this.broadcastList();
    if (page.databaseId) await this.broadcastRows(page.databaseId);
    return page;
  }

  purgePage(id: string): Promise<boolean> {
    return this.store.purgePage(id);
  }

  emptyTrash(): Promise<number> {
    return this.store.emptyTrash();
  }

  // Always embedded (idb/memory PGlite in the webview, or the desktop in-app
  // store), so compaction is always available here — no mode gate.
  async compact(): Promise<CompactResult> {
    const {before, after} = await this.store.compact();
    return {before, after, reclaimed: Math.max(0, before - after)};
  }

  subscribePage(id: string, handlers: PageSubscription): () => void {
    return this.hub.subscribePage(id, (event) => {
      if (event.type === 'page') handlers.onPage?.(event.page);
      else handlers.onDeleted?.(event.id);
    });
  }

  subscribePages(onList: (pages: PageMeta[]) => void): () => void {
    // The HTTP stream replays the current list on connect; do the same so a
    // fresh subscriber paints immediately rather than waiting for the next write.
    void this.store.listPages().then(onList).catch(() => undefined);
    return this.hub.subscribeList((event) => onList(event.pages));
  }

  // ── Live collaboration: incremental relay + late-joiner sync (Collab T1/T2) ──
  // Mirrors the HTTP relay over the in-process hub + relay doc, so a second window
  // on the same store sees incremental updates and a fresh window can sync to the
  // current doc. Persists nothing (the snapshot save stays the durable checkpoint).

  private loadRelayBase = async (pageId: string): Promise<Uint8Array | null> => {
    const page = await this.store.getPage(pageId);
    const update = (page?.data as {blockdoc?: {update?: string}} | undefined)?.blockdoc?.update;
    return typeof update === 'string' && update.length > 0 ? Buffer.from(update, 'base64') : null;
  };

  postPageUpdate(id: string, update: string, clientId: number): Promise<void> {
    this.hub.publishPageUpdate(id, update, clientId);
    return this.relay.ingest(id, Buffer.from(update, 'base64'), this.loadRelayBase);
  }

  subscribePageUpdates(id: string, onUpdate: (update: string, clientId: number) => void): () => void {
    return this.hub.subscribeLive((event) => {
      if (event.type === 'yupdate' && event.pageId === id) onUpdate(event.update, event.clientId);
    });
  }

  async syncPageUpdates(id: string, stateVector: string): Promise<string | null> {
    const sv = stateVector.length > 0 ? Buffer.from(stateVector, 'base64') : new Uint8Array();
    const diff = await this.relay.sync(id, sv, this.loadRelayBase);
    return diff ? Buffer.from(diff).toString('base64') : null;
  }

  // ── Live collaboration: ephemeral awareness / presence (Collab T4) ───────────
  // Mirrors the HTTP route: re-stamp identity from the in-process owner principal
  // (the body can't spoof who-you-are), fan out over the hub, and keep the snapshot
  // for a late joiner. Persists nothing.

  postPageAwareness(id: string, update: string, clientId: number): Promise<void> {
    const {stamped, present} = stampAwarenessIdentity(Buffer.from(update, 'base64'), awarenessUser(localPrincipal()), clientId);
    if (stamped.length === 0) return Promise.resolve();
    const stampedB64 = Buffer.from(stamped).toString('base64');
    this.hub.publishPageAwareness(id, stampedB64, clientId);
    if (present) this.awarenessRelay.ingest(id, clientId, stamped);
    else this.awarenessRelay.remove(id, clientId);
    return Promise.resolve();
  }

  subscribePageAwareness(id: string, onUpdate: (update: string, clientId: number) => void): () => void {
    return this.hub.subscribeLive((event) => {
      if (event.type === 'awareness' && event.pageId === id) onUpdate(event.update, event.clientId);
    });
  }

  syncPageAwareness(id: string): Promise<string[]> {
    return Promise.resolve(this.awarenessRelay.snapshot(id).map((u) => Buffer.from(u).toString('base64')));
  }

  /** Reopen-after-drop reconnect signal (Collab T7). The in-webview client's live hub is
   *  in-process and never drops, so there is nothing to re-handshake — no-op. */
  subscribeReconnect(): () => void {
    return () => {};
  }

  // ── Assets: content-addressed binary store (OB-ASSETS A2) ────────────────────
  // In-process: talk straight to the store. `putAsset` refs the asset to its page
  // in the same call (mirroring the HTTP route) so it inherits that page's
  // read-gate and is immediately reachable. `getAsset` is ungated — the in-webview
  // store is single-user (the implicit local owner reads their own assets).

  async putAsset(bytes: Uint8Array, mime: string, pageId: string): Promise<{id: string}> {
    const {id} = await this.store.putAsset(bytes, mime);
    await this.store.refAsset(id, pageId);
    return {id};
  }

  async getAsset(id: string): Promise<{bytes: Uint8Array; mime: string} | null> {
    const got = await this.store.getAsset(id);
    return got ? {bytes: got.bytes, mime: got.mime} : null;
  }

  // ── Databases ──────────────────────────────────────────────────────────────

  async createDatabase(input: DatabaseInput): Promise<StoredDatabase> {
    const database = await this.store.createDatabase(input);
    const host = await this.store.getPage(database.pageId);
    if (host) this.hub.publishPage(host);
    await this.broadcastList();
    return database;
  }

  getDatabase(id: string): Promise<StoredDatabase | null> {
    return this.store.getDatabase(id);
  }

  getPageDatabase(pageId: string): Promise<StoredDatabase | null> {
    return this.store.getDatabaseByPage(pageId);
  }

  async updateDatabase(id: string, patch: DatabaseUpdate): Promise<StoredDatabase> {
    const database = await this.store.updateDatabase(id, patch);
    if (!database) throw new Error('database not found');
    await this.broadcastRows(database.id);
    return database;
  }

  async deleteDatabase(id: string): Promise<boolean> {
    const database = await this.store.getDatabase(id);
    const deleted = await this.store.deleteDatabase(id);
    if (!deleted) return false;
    if (database) {
      const host = await this.store.getPage(database.pageId);
      if (host) this.hub.publishPage(host);
    }
    await this.broadcastList();
    return true;
  }

  listRows(databaseId: string): Promise<DatabaseRow[]> {
    return this.store.listRows(databaseId);
  }

  async createRow(databaseId: string, input: RowInput = {}): Promise<StoredPage> {
    const page = await this.store.createRow(databaseId, input, localPrincipal());
    this.hub.publishPage(page);
    await this.broadcastRows(databaseId);
    return page;
  }

  async updateRow(databaseId: string, rowId: string, patch: RowUpdate): Promise<DatabaseRow> {
    const row = await this.store.updateRow(databaseId, rowId, patch);
    if (!row) throw new Error('row not found');
    await this.broadcastRows(databaseId);
    return row;
  }

  async reorderRows(databaseId: string, orderedIds: string[]): Promise<void> {
    await this.store.reorderRows(databaseId, orderedIds);
    await this.broadcastRows(databaseId);
  }

  subscribeRows(databaseId: string, onRows: (rows: DatabaseRow[]) => void): () => void {
    void this.store.listRows(databaseId).then(onRows).catch(() => undefined);
    return this.hub.subscribeRows(databaseId, (event) => onRows(event.rows));
  }

  // ── Ledger: server-enforced double-entry accounting (LGR-3) ──────────────────
  // Same LedgerStore the HTTP routes use — the invariants are enforced in the
  // STORE layer, so this in-process transport can't sidestep them. The publish
  // wiring mirrors the HTTP routes so open ledger views stay live. Typed
  // LedgerErrors propagate as-is (the HTTP client re-materializes the same class
  // from the wire, so both transports throw identically).

  ledgerInfo(): Promise<LedgerInfo> {
    return this.store.ledger.info();
  }

  async ledgerInit(): Promise<LedgerInfo> {
    const before = await this.store.ledgerIds();
    const info = await this.store.ledger.ensureSetup(localPrincipal());
    if (!before) await this.broadcastList();
    return info;
  }

  ledgerListAccounts(): Promise<LedgerAccount[]> {
    return this.store.ledger.listAccounts();
  }

  async ledgerCreateAccount(input: LedgerAccountInput): Promise<LedgerAccount> {
    const account = await this.store.ledger.createAccount(input, localPrincipal());
    await this.broadcastLedgerRows('accounts');
    return account;
  }

  ledgerGetAccount(id: string): Promise<LedgerAccount | null> {
    return this.store.ledger.getAccount(id);
  }

  async ledgerUpdateAccount(id: string, patch: LedgerAccountPatch): Promise<LedgerAccount> {
    const account = await this.store.ledger.updateAccount(id, patch, localPrincipal());
    await this.broadcastLedgerRows('accounts');
    return account;
  }

  ledgerListTransactions(opts?: {state?: LedgerTransactionState; limit?: number}): Promise<LedgerTransaction[]> {
    return this.store.ledger.listTransactions(opts);
  }

  ledgerGetTransaction(id: string): Promise<LedgerTransaction | null> {
    return this.store.ledger.getTransaction(id);
  }

  async ledgerCreateDraft(input: LedgerDraftInput): Promise<LedgerTransaction> {
    const transaction = await this.store.ledger.createDraft(input, localPrincipal());
    await this.broadcastLedgerRows('transactions', 'postings');
    return transaction;
  }

  async ledgerUpdateDraft(id: string, patch: LedgerDraftPatch): Promise<LedgerTransaction> {
    const transaction = await this.store.ledger.updateDraft(id, patch, localPrincipal());
    await this.broadcastLedgerRows('transactions', 'postings');
    return transaction;
  }

  async ledgerDeleteDraft(id: string): Promise<boolean> {
    const deleted = await this.store.ledger.deleteDraft(id, localPrincipal());
    await this.broadcastLedgerRows('transactions', 'postings');
    return deleted;
  }

  async ledgerPostTransaction(id: string): Promise<LedgerTransaction> {
    const transaction = await this.store.ledger.post(id, localPrincipal());
    await this.broadcastLedgerRows('transactions');
    return transaction;
  }

  async ledgerReverseTransaction(id: string, opts?: LedgerReverseOptions): Promise<LedgerTransaction> {
    const transaction = await this.store.ledger.reverse(id, opts ?? {}, localPrincipal());
    await this.broadcastLedgerRows('transactions', 'postings');
    return transaction;
  }

  async ledgerSetPostingCleared(postingId: string, cleared: LedgerClearedState): Promise<LedgerPosting> {
    // `reconciled` is unreachable from here in either direction — it is reached
    // only by finishing a reconciliation and left only by reopening one (LGR-11).
    const posting = await this.store.ledger.setPostingCleared(postingId, cleared, localPrincipal());
    await this.broadcastLedgerRows('postings');
    return posting;
  }

  // ── Statement reconciliation (LGR-11) ────────────────────────────────────────
  // Same `LedgerStore` methods the HTTP routes call, so the zero-difference
  // gate, the freeze and the reopen behave identically in browser-local mode —
  // there is no second implementation for this transport to drift from.

  ledgerListReconciliations(opts?: {accountId?: string; status?: LedgerReconciliationStatus}): Promise<LedgerReconciliation[]> {
    return this.store.ledger.listReconciliations(opts);
  }

  ledgerGetReconciliation(id: string): Promise<LedgerReconciliationSummary | null> {
    return this.store.ledger.getReconciliation(id);
  }

  async ledgerStartReconciliation(input: LedgerReconciliationInput): Promise<LedgerReconciliation> {
    const reconciliation = await this.store.ledger.startReconciliation(input, localPrincipal());
    await this.broadcastLedgerRows('reconciliations');
    return reconciliation;
  }

  async ledgerAmendReconciliation(id: string, patch: LedgerReconciliationPatch): Promise<LedgerReconciliationSummary> {
    const summary = await this.store.ledger.amendReconciliation(id, patch, localPrincipal());
    await this.broadcastLedgerRows('reconciliations');
    return summary;
  }

  async ledgerAbandonReconciliation(id: string): Promise<LedgerReconciliation> {
    const reconciliation = await this.store.ledger.abandonReconciliation(id, localPrincipal());
    // `reconciliations` only: abandoning writes no posting row (LGR-22's
    // posting-neutrality), so broadcasting `postings` would announce a change
    // that never happened.
    await this.broadcastLedgerRows('reconciliations');
    return reconciliation;
  }

  async ledgerToggleReconciliationPosting(id: string, postingId: string, cleared: 'pending' | 'cleared'): Promise<LedgerReconciliationSummary> {
    const summary = await this.store.ledger.setReconciliationPostingCleared(id, postingId, cleared, localPrincipal());
    await this.broadcastLedgerRows('postings');
    return summary;
  }

  async ledgerFinishReconciliation(id: string): Promise<LedgerReconciliationSummary> {
    const summary = await this.store.ledger.finishReconciliation(id, localPrincipal());
    await this.broadcastLedgerRows('reconciliations', 'postings');
    return summary;
  }

  async ledgerReopenReconciliation(id: string): Promise<LedgerReconciliationSummary> {
    const summary = await this.store.ledger.reopenReconciliation(id, localPrincipal());
    await this.broadcastLedgerRows('reconciliations', 'postings');
    return summary;
  }

  ledgerListAudit(opts?: {limit?: number; before?: number}): Promise<LedgerAuditEvent[]> {
    return this.store.ledger.listAudit(opts);
  }

  /** Canonical postings CSV (LGR-7) — same bytes as the HTTP route (parity-pinned). */
  ledgerExportCsv(): Promise<string> {
    return this.store.ledger.exportPostingsCsv();
  }

  /** Refresh the named ledger databases' live row views (mirrors app.ts). */
  private async broadcastLedgerRows(...keys: Array<'accounts' | 'transactions' | 'postings' | 'reconciliations'>): Promise<void> {
    const ids = await this.store.ledgerIds();
    if (!ids) return;
    for (const key of keys) await this.broadcastRows(ids[key]);
  }

  // ── Suggestions + comments (the review layer) ────────────────────────────────

  listSuggestions(pageId: string, status?: SuggestionStatus): Promise<StoredSuggestion[]> {
    return this.store.listSuggestions(pageId, status);
  }

  createSuggestion(input: SuggestionInput): Promise<StoredSuggestion> {
    // In-webview store is single-user: stamp the implicit local owner (OB-165).
    return this.store.createSuggestion(input, localPrincipal());
  }

  async updateSuggestion(id: string, patch: SuggestionUpdate): Promise<StoredSuggestion> {
    const suggestion = await this.store.updateSuggestion(id, patch);
    if (!suggestion) throw new Error('suggestion not found');
    return suggestion;
  }

  deleteSuggestion(id: string): Promise<boolean> {
    return this.store.deleteSuggestion(id);
  }

  listComments(pageId: string): Promise<StoredComment[]> {
    return this.store.listComments(pageId);
  }

  createComment(input: CommentInput): Promise<StoredComment> {
    return this.store.createComment(input, localPrincipal());
  }

  deleteComment(id: string): Promise<boolean> {
    return this.store.deleteComment(id);
  }

  // ── Multi-user: identity, policy, provenance (OB-165) ────────────────────────
  // In-webview mode is single-user: the caller is the implicit local owner.
  // The policy + edit log still persist (so a later move to a shared server, or
  // a second window, sees them), and writes here are attributed to the owner.

  async getInstanceInfo(): Promise<InstanceInfo> {
    const config = await this.store.getInstanceConfig();
    return {
      guestAccess: config.guestAccess,
      // The instance-wide agent-edits mode (AGED-5) — surfaced so the in-webview
      // Settings toggle round-trips and a page's `inherit` policy resolves without
      // a second probe. Mirrors the HTTP `GET /api/instance` field.
      agentEdits: config.agentEdits,
      ownerSubject: config.ownerSubject ?? null,
      trustedIssuers: config.trustedIssuers.map((i) => i.issuer),
      audience: config.audience ?? null,
      requireAudience: config.requireAudience ?? false,
      you: localPrincipal(),
      // The in-webview caller is the implicit loopback owner (`verifiedVia==='local'`),
      // so its effective role is `owner` — it keeps full write chrome and the
      // manage-sharing entry, and is never locked out (P1-8). (This is the ONLY path
      // where a `local` principal surfaces; the durable desktop server sees its owner
      // as a `jws`/guest principal over IPC, never `local`.)
      youRole: 'owner',
    };
  }

  setInstancePolicy(patch: Partial<InstanceConfig>): Promise<InstanceConfig> {
    return this.store.updateInstanceConfig(patch);
  }

  listPageEdits(pageId: string, limit?: number): Promise<StoredEdit[]> {
    return this.store.listEdits(pageId, limit);
  }

  // ── Sharing: per-page visibility scope + ACL (OB-182 §1.1; OB-191/203) ────────
  // The single-process owner manages everything; resolveInvitee normalizes the
  // free email-or-handle string exactly as the HTTP route does.

  async getPageVisibility(pageId: string): Promise<PageVisibility | null> {
    return this.store.getPageVisibility(pageId);
  }

  async setPageVisibility(pageId: string, visibility: PageVisibility): Promise<PageVisibility> {
    await this.store.setPageVisibility(pageId, visibility);
    return visibility;
  }

  // Agent-edits policy (AGED-1) — mirrors the HTTP route: a missing/unset page
  // resolves to `inherit` (the instance mode then decides).
  async getPageAgentEdits(pageId: string): Promise<AgentEditsPolicy> {
    return (await this.store.getPageAgentEdits(pageId)) ?? 'inherit';
  }

  // Server-resolved effective mode (AGED-6) — mirrors the HTTP route: the raw policy
  // resolved against the instance default (never `inherit`). The in-webview caller
  // reads its own instance config freely, so this is a local resolve.
  async getEffectiveAgentEdits(pageId: string): Promise<AgentEditsMode> {
    const page = (await this.store.getPageAgentEdits(pageId)) ?? 'inherit';
    const config = await this.store.getInstanceConfig();
    return resolveAgentEdits(page, config.agentEdits);
  }

  async setPageAgentEdits(pageId: string, agentEdits: AgentEditsPolicy): Promise<AgentEditsPolicy> {
    await this.store.setPageAgentEdits(pageId, agentEdits);
    return agentEdits;
  }

  listPageAcl(pageId: string): Promise<PageAcl[]> {
    return this.store.getPageAcl(pageId);
  }

  async sharePage(pageId: string, invitee: string, level: AclLevel = 'read'): Promise<PageAcl> {
    const resolved = await resolveInvitee(invitee);
    return this.store.setPageAcl(pageId, {
      email: resolved.email ?? null,
      subject: resolved.subject ?? null,
      level,
      invitedBy: localPrincipal().subject,
    });
  }

  unsharePage(pageId: string, key: {subject: string} | {email: string}): Promise<boolean> {
    return this.store.removePageAcl(pageId, key);
  }

  // ── Sharing: the instance member roster (OB-191) ──────────────────────────────
  // The single-process owner manages the roster directly; resolveInvitee
  // normalizes the free email-or-handle string exactly as the HTTP route does.

  listMembers(): Promise<Member[]> {
    return this.store.listMembers();
  }

  async inviteMember(invitee: string, opts: {role?: MemberRole; status?: MemberStatus} = {}): Promise<Member> {
    const resolved = await resolveInvitee(invitee);
    // By-email ⇒ an unclaimed persona (default 'invited'); by-subject ⇒ active.
    const status = opts.status ?? (resolved.email ? 'invited' : 'active');
    return this.store.addMember({
      email: resolved.email ?? null,
      subject: resolved.subject ?? null,
      role: opts.role ?? 'viewer',
      status,
      invitedBy: localPrincipal().subject,
    });
  }

  async updateMember(id: string, patch: {role?: MemberRole; status?: MemberStatus}): Promise<Member> {
    const member = await this.store.updateMember(id, patch);
    if (!member) throw new Error('member not found');
    return member;
  }

  removeMember(id: string): Promise<boolean> {
    return this.store.removeMember(id);
  }

  // ── Agent access: PAT credential management (AGENT-6) ─────────────────────────
  // Agent PATs authenticate an OUTWARD `Bearer obat_…` HTTP request; the in-webview
  // store exposes no such server, so the feature is inert here — the panel renders a
  // "runs on the desktop app or a connected server" notice.

  listAgentTokens(): Promise<AgentTokenList> {
    // Reject (rather than resolve empty) so the settings panel renders its
    // "unavailable in the browser" state instead of a live-looking Enable toggle
    // that would then error on use.
    return Promise.reject(
      new Error('Agent tokens run on the desktop app or a connected server — not in the browser.'),
    );
  }

  setAgentApiEnabled(): Promise<{enabled: boolean; remote: boolean}> {
    return Promise.reject(
      new Error('Agent tokens run on the desktop app or a connected server — not in the browser.'),
    );
  }

  createAgentToken(): Promise<CreatedAgentToken> {
    return Promise.reject(
      new Error('Agent tokens run on the desktop app or a connected server — not in the browser.'),
    );
  }

  revokeAgentToken(): Promise<boolean> {
    return Promise.resolve(false);
  }

  // ── Scheduled backups (OB-166) ───────────────────────────────────────────────
  // The in-webview store has no filesystem, so scheduled backups don't run here
  // (`resolvedDir` is null → the UI shows it as a desktop/server feature). The
  // policy still persists, and the manual `.openbook.json` export covers the
  // browser; `runBackup` is therefore unavailable.

  async getBackupStatus(): Promise<BackupStatus> {
    const config = await this.store.getBackupConfig();
    return {
      config,
      resolvedDir: null,
      cadences: BACKUP_CADENCES.map((cadence) => {
        const last = config.lastRun[cadence] ?? null;
        return {
          cadence,
          enabled: config.cadences[cadence],
          lastRun: last,
          nextDue: last ? new Date(Date.parse(last) + BACKUP_CADENCE_MS[cadence]).toISOString() : null,
          count: 0,
        };
      }),
    };
  }

  async setBackupConfig(patch: Partial<BackupConfig>): Promise<BackupStatus> {
    await this.store.updateBackupConfig(patch);
    return this.getBackupStatus();
  }

  runBackup(): Promise<{file: string; dir: string}> {
    return Promise.reject(
      new Error('Scheduled backups run on the desktop app or a connected server — not in the browser. Use Export instead.'),
    );
  }

  // ── Extensions (installed plugins, stored per library in the DB) ───────────

  listPlugins(): Promise<StoredPlugin[]> {
    return this.store.listPlugins();
  }

  installPlugin(pkg: PluginPackage): Promise<StoredPlugin> {
    return this.store.upsertPlugin(pkg);
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<StoredPlugin> {
    const plugin = await this.store.setPluginEnabled(id, enabled);
    if (!plugin) throw new Error('plugin not found');
    return plugin;
  }

  removePlugin(id: string): Promise<boolean> {
    return this.store.removePlugin(id);
  }

  // ── Optional local AI (server-hosted — unavailable in the in-webview store) ──

  aiStatus(): Promise<AiStatus> {
    return Promise.resolve({
      config: {provider: 'off'},
      ready: false,
      embeddings: false,
      detail: 'AI runs on a connected OpenBook server; it is not available in local in-app mode.',
      index: {pages: 0, builtAt: null},
    });
  }

  // No engine to configure; accept the value as a no-op so the settings panel
  // never throws. It is not persisted (local mode has no AI), so a reload
  // correctly reports AI as off again.
  aiSetConfig(config: AiConfig): Promise<AiConfig> {
    return Promise.resolve(config);
  }

  // Lexical content search works fully in-webview: no engine, just the page
  // text (see LocalSearchIndex). Unlike the other AI methods, this is NOT stubbed.
  aiIndex(): Promise<{pages: number; chunks: number}> {
    return this.searchIndex.reindex();
  }

  aiSearch(query: string, limit?: number): Promise<AiSearchResponse> {
    return this.searchIndex.search(query, Math.min(Math.max(limit ?? 8, 1), 25));
  }

  aiTasks(): Promise<AiTasksResponse> {
    return Promise.resolve({tasks: []});
  }

  aiDownloadModel(): Promise<AiStatus['download']> {
    return Promise.reject(this.aiUnavailable());
  }

  aiComplete(): Promise<string> {
    return Promise.reject(this.aiUnavailable());
  }

  aiGenerate(): Promise<string> {
    return Promise.reject(this.aiUnavailable());
  }

  agentChat(): Promise<void> {
    return Promise.reject(this.aiUnavailable());
  }

  aiSkills(): Promise<AiSkill[]> {
    return Promise.resolve([]);
  }

  aiSaveSkill(): Promise<AiSkill> {
    return Promise.reject(this.aiUnavailable());
  }

  aiDeleteSkill(): Promise<boolean> {
    return Promise.resolve(false);
  }

  // No hosted engine in local in-app mode → no usage attribution to price.
  getAiPricing(): Promise<AiPricingResponse> {
    return Promise.resolve({default: {}, override: {}, effective: {}});
  }

  setAiPricing(override: AiPricingTable): Promise<AiPricingResponse> {
    return Promise.resolve({default: {}, override, effective: override});
  }

  getAiUsage(): Promise<AiUsageResponse> {
    return Promise.resolve({exists: false, databaseId: null, hostPageId: null, retentionDays: null});
  }

  setAiUsageRetention(days: number): Promise<{days: number}> {
    return Promise.resolve({days});
  }

  // No server process in local in-app mode → no external MCP tools. Report an
  // empty, off config (and no stdio) so the settings panel renders its empty
  // state rather than throwing; a save is a no-op, and a test is unavailable.
  getMcpConfig(): Promise<McpConfigResponse> {
    return Promise.resolve({config: {enabled: false, servers: []}, stdioAllowed: false});
  }

  putMcpConfig(config: McpClientConfig): Promise<McpConfigResponse> {
    // No server → nothing persists. Echo back a REDACTED, off config (strip any
    // write-only token the caller sent, flag it as set) so the stub matches the
    // real server's response shape and never round-trips a secret.
    const servers = (config.servers ?? []).map((s) => {
      const {authToken, ...rest} = s;
      return {...rest, ...(typeof authToken === 'string' && authToken.trim() ? {authTokenSet: true} : {})};
    });
    return Promise.resolve({config: {enabled: false, servers}, stdioAllowed: false});
  }

  testMcpServer(): Promise<McpTestResult> {
    return Promise.resolve({ok: false, error: 'External tools run on a connected OpenBook server; not available in local in-app mode.'});
  }

  private aiUnavailable(): Error {
    return new Error('AI is not available in local in-app mode — connect to an OpenBook server to use it.');
  }
}
