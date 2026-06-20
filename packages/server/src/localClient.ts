import type {
  AiConfig,
  AiSearchResponse,
  AiSkill,
  AiStatus,
  AiTasksResponse,
  CommentInput,
  DataClient,
  DatabaseInput,
  DatabaseRow,
  DatabaseUpdate,
  ImportRequest,
  ImportResult,
  PageInput,
  PageMeta,
  PageSubscription,
  PluginPackage,
  RowInput,
  RowUpdate,
  StoredComment,
  StoredDatabase,
  StoredPage,
  StoredPlugin,
  StoredSuggestion,
  SuggestionInput,
  SuggestionStatus,
  SuggestionUpdate,
} from '@open-book/sdk';
import {PageStore} from './store';
import {PageHub} from './hub';

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
  constructor(
    private readonly store: PageStore,
    private readonly hub: PageHub = new PageHub(),
  ) {}

  /** Release the underlying store (its PGlite connection). Used when swapping
   *  clients — e.g. the desktop moving between in-app and a published server. */
  close(): Promise<void> {
    return this.store.close();
  }

  // ── Live-update broadcasts (mirror app.ts's broadcastList/broadcastRows) ─────

  private async broadcastList(): Promise<void> {
    this.hub.publishList(await this.store.listPages());
  }

  private async broadcastRows(databaseId: string): Promise<void> {
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
    const page = await this.store.upsertPage(input);
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
    await this.broadcastList();
    if (existing?.databaseId) await this.broadcastRows(existing.databaseId);
    return true;
  }

  exportSpace(): Promise<{pages: StoredPage[]; databases: StoredDatabase[]}> {
    return this.store.exportAll();
  }

  async importSpace(req: ImportRequest): Promise<ImportResult> {
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
    const page = await this.store.createRow(databaseId, input);
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

  // ── Suggestions + comments (the review layer) ────────────────────────────────

  listSuggestions(pageId: string, status?: SuggestionStatus): Promise<StoredSuggestion[]> {
    return this.store.listSuggestions(pageId, status);
  }

  createSuggestion(input: SuggestionInput): Promise<StoredSuggestion> {
    return this.store.createSuggestion(input);
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
    return this.store.createComment(input);
  }

  deleteComment(id: string): Promise<boolean> {
    return this.store.deleteComment(id);
  }

  // ── Extensions (installed plugins, stored per workspace in the DB) ───────────

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

  aiIndex(): Promise<{pages: number; chunks: number}> {
    return Promise.resolve({pages: 0, chunks: 0});
  }

  aiSearch(): Promise<AiSearchResponse> {
    return Promise.resolve({results: [], mode: 'lexical'});
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

  private aiUnavailable(): Error {
    return new Error('AI is not available in local in-app mode — connect to an OpenBook server to use it.');
  }
}
