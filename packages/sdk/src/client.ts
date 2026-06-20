import {API, type ApiError} from './routes';
import type {PluginPackage, StoredPlugin} from './plugins';
import type {
  AgentChatEvent,
  AgentChatMessage,
  AgentChatOptions,
  AiConfig,
  AiSearchResponse,
  AiSkill,
  AiStatus,
  AiStreamEvent,
  AiTasksResponse,
} from './ai';
import type {PageInput, PageMeta, StoredPage} from './types';
import type {ImportRequest, ImportResult} from './backup';
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

/** Handlers for a single page's live update stream. */
export interface PageSubscription {
  /** A newer version of the page was saved (by anyone). */
  onPage?: (page: StoredPage) => void;
  /** The page was deleted. */
  onDeleted?: (id: string) => void;
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
   * Run the workspace agent on a conversation. `onEvent` fires once per step
   * (tool call, tool result, reasoning, proposals, final answer, error);
   * resolves when the run ends. `opts` carries effort/thinking/skills overrides.
   */
  agentChat(messages: AgentChatMessage[], onEvent: (event: AgentChatEvent) => void, opts?: AgentChatOptions): Promise<void>;
  /** List the workspace's prompt/recipe skills. */
  aiSkills(): Promise<AiSkill[]>;
  /** Create or replace a prompt/recipe skill (keyed on its slug). */
  aiSaveSkill(skill: AiSkill): Promise<AiSkill>;
  /** Delete a prompt/recipe skill by name. */
  aiDeleteSkill(name: string): Promise<boolean>;

  // ── Extensions (installed plugins, stored server-side per workspace) ───────
  listPlugins(): Promise<StoredPlugin[]>;
  installPlugin(pkg: PluginPackage): Promise<StoredPlugin>;
  setPluginEnabled(id: string, enabled: boolean): Promise<StoredPlugin>;
  removePlugin(id: string): Promise<boolean>;
  /**
   * Move a page (and its nested subtree) to the trash. Soft delete: the page is
   * recoverable via {@link restorePage} until the server's cleanup job purges
   * it. Resolves `true` if a live page was trashed.
   */
  deletePage(id: string): Promise<boolean>;
  /** Export the whole space: every live page (full data) + every database. */
  exportSpace(): Promise<{pages: StoredPage[]; databases: StoredDatabase[]}>;
  /** Restore a (client-selected) set of pages/databases; see {@link ImportRequest}. */
  importSpace(req: ImportRequest): Promise<ImportResult>;
  /** List the trash (most-recently-deleted first). */
  listTrash(): Promise<PageMeta[]>;
  /** Restore a trashed page, or `null` if it isn't in the trash. */
  restorePage(id: string): Promise<StoredPage | null>;
  /** Permanently delete one trashed page (and its subtree). `true` if removed. */
  purgePage(id: string): Promise<boolean>;
  /** Permanently empty the whole trash. Resolves the number of pages purged. */
  emptyTrash(): Promise<number>;
  /** Subscribe to a single page's live updates. Returns an unsubscribe fn. */
  subscribePage(id: string, handlers: PageSubscription): () => void;
  /** Subscribe to live page-list updates. Returns an unsubscribe fn. */
  subscribePages(onList: (pages: PageMeta[]) => void): () => void;

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
 * The slice of `EventSource` {@link LiveStream} uses (named events + open/error
 * via `addEventListener`, plus `close`). Defaults to a real `EventSource`; the
 * desktop injects a source backed by host IPC events, since its server speaks
 * over a socket the webview can't open an `EventSource` to.
 */
export interface LiveSourceLike {
  addEventListener(type: string, handler: (event: {data?: string}) => void): void;
  close(): void;
}

class LiveStream {
  private source: LiveSourceLike | null = null;
  private readonly listListeners = new Set<(pages: PageMeta[]) => void>();
  private readonly pageListeners = new Map<string, Set<PageSubscription>>();
  private readonly rowsListeners = new Map<string, Set<(rows: DatabaseRow[]) => void>>();
  // The source reconnects on its own after a drop (server/app restart). We track
  // a prior disconnect so that, on the *next* successful open, we re-fetch every
  // open subscription — the firehose only replays the page *list* on connect, so
  // open pages/rows would otherwise show stale data until their next edit.
  private sawError = false;

  constructor(
    private readonly liveUrl: string,
    private readonly fetchers: ResyncFetchers,
    private readonly createSource: (url: string) => LiveSourceLike,
  ) {}

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
    }
  }

  private ensureOpen(): void {
    if (this.source) return;
    const source = this.createSource(this.liveUrl);
    const handle = (e: {data?: string}): void => {
      if (e.data != null) this.dispatch(e.data);
    };
    for (const name of ['list', 'page', 'deleted', 'rows']) source.addEventListener(name, handle);
    // A drop sets `sawError`; the source auto-reconnects and fires `open` again,
    // at which point we resync so every client transparently re-attaches after a
    // server or app restart (OB-132).
    source.addEventListener('error', () => {
      this.sawError = true;
    });
    source.addEventListener('open', () => {
      if (this.sawError) {
        this.sawError = false;
        void this.resync();
      }
    });
    this.source = source;
  }

  /** Re-fetch and re-dispatch every open subscription after a reconnect. */
  private async resync(): Promise<void> {
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
      } catch {
        /* keep going */
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
  }

  private maybeClose(): void {
    if (this.listListeners.size === 0 && this.pageListeners.size === 0 && this.rowsListeners.size === 0) {
      this.source?.close();
      this.source = null;
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
}

/** Options for swapping {@link HttpDataClient}'s transport (desktop IPC). */
export interface HttpDataClientOptions {
  /** Replacement for the global `fetch` (e.g. tunnel requests over host IPC). */
  fetchImpl?: FetchLike;
  /** Factory for the live-update source (e.g. an IPC-event-backed source). */
  createLiveSource?: (url: string) => LiveSourceLike;
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
  private live: LiveStream | null = null;

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
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.createLiveSource = opts.createLiveSource ?? ((url) => new EventSource(url) as unknown as LiveSourceLike);
  }

  /** `fetch` (or the injected transport) with the access token attached (when set). */
  private authFetch(input: string, init: RequestInit = {}): Promise<Response> {
    if (!this.token) return this.fetchImpl(input, init);
    return this.fetchImpl(input, {
      ...init,
      headers: {...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${this.token}`},
    });
  }

  /** Lazily create the shared live connection (browser-only). */
  private liveStream(): LiveStream {
    if (!this.live) {
      // EventSource can't send headers, so the token rides the URL.
      const liveUrl = `${this.baseUrl}${API.live}${this.token ? `?token=${encodeURIComponent(this.token)}` : ''}`;
      this.live = new LiveStream(
        liveUrl,
        {
          listPages: () => this.listPages(),
          getPage: (id) => this.getPage(id),
          listRows: (databaseId) => this.listRows(databaseId),
        },
        this.createLiveSource,
      );
    }
    return this.live;
  }

  async listPages(): Promise<PageMeta[]> {
    return this.request<PageMeta[]>('GET', API.pages);
  }

  async getPage(id: string): Promise<StoredPage | null> {
    const res = await this.authFetch(`${this.baseUrl}${API.page(id)}`, {cache: 'no-store'});
    if (res.status === 404) return null;
    await throwIfNotOk(res);
    return (await res.json()) as StoredPage;
  }

  async savePage(input: PageInput): Promise<StoredPage> {
    // Known id → PUT to that resource; otherwise POST to create.
    if (input.id) {
      return this.request<StoredPage>('PUT', API.page(input.id), input);
    }
    return this.request<StoredPage>('POST', API.pages, input);
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

  async movePage(id: string, move: {parentId: string | null; orderedIds: string[]}): Promise<StoredPage> {
    return this.request<StoredPage>('PUT', API.pageMove(id), move);
  }

  async deletePage(id: string): Promise<boolean> {
    const res = await this.authFetch(`${this.baseUrl}${API.page(id)}`, {method: 'DELETE'});
    if (res.status === 404) return false;
    await throwIfNotOk(res);
    return true;
  }

  async exportSpace(): Promise<{pages: StoredPage[]; databases: StoredDatabase[]}> {
    return this.request<{pages: StoredPage[]; databases: StoredDatabase[]}>('GET', API.exportSpace);
  }

  async importSpace(req: ImportRequest): Promise<ImportResult> {
    return this.request<ImportResult>('POST', API.importSpace, req);
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

  subscribePage(id: string, handlers: PageSubscription): () => void {
    return this.liveStream().onPage(id, handlers);
  }

  subscribePages(onList: (pages: PageMeta[]) => void): () => void {
    return this.liveStream().onList(onList);
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

  async installPlugin(pkg: PluginPackage): Promise<StoredPlugin> {
    return this.request<StoredPlugin>('POST', API.plugins, pkg);
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

  /** Run the workspace agent, surfacing each streamed step via `onEvent`. */
  async agentChat(
    messages: AgentChatMessage[],
    onEvent: (event: AgentChatEvent) => void,
    opts: AgentChatOptions = {},
  ): Promise<void> {
    const res = await this.authFetch(`${this.baseUrl}${API.agentChat}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({messages, provider: opts.provider, model: opts.model, effort: opts.effort, thinking: opts.thinking, skills: opts.skills, pageId: opts.pageId, selection: opts.selection, allowDirectEdits: opts.allowDirectEdits}),
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

async function throwIfNotOk(res: Response): Promise<void> {
  if (res.ok) return;
  let detail = '';
  try {
    const data = (await res.json()) as ApiError;
    detail = data?.error ? `: ${data.error}` : '';
  } catch {
    // Non-JSON error body; ignore.
  }
  throw new Error(`OpenBook request failed (${res.status} ${res.statusText})${detail}`);
}
