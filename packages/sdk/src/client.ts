import {API, type ApiError} from './routes';
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
   * Move a page within the sidebar tree: set its parent (`null` = top level) and
   * the full ordered list of sibling ids under that parent (including this page).
   * Used by drag-to-reorder / drag-to-nest. Rejects a move that would create a
   * cycle (nesting a page under itself or a descendant).
   */
  movePage(id: string, move: {parentId: string | null; orderedIds: string[]}): Promise<StoredPage>;
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
  /** Subscribe to a database's live row-list updates. Returns an unsubscribe fn. */
  subscribeRows(databaseId: string, onRows: (rows: DatabaseRow[]) => void): () => void;
}

/**
 * One multiplexed live connection for a client. Every subscription (page list,
 * a page, a database's rows) registers here and is served by a single
 * `EventSource` to `/api/live`, which the client opens lazily and closes once
 * nothing is listening. This keeps each tab to one long-lived connection so
 * several tabs don't exhaust the browser's per-origin connection limit.
 */
class LiveStream {
  private source: EventSource | null = null;
  private readonly listListeners = new Set<(pages: PageMeta[]) => void>();
  private readonly pageListeners = new Map<string, Set<PageSubscription>>();
  private readonly rowsListeners = new Map<string, Set<(rows: DatabaseRow[]) => void>>();

  constructor(private readonly liveUrl: string) {}

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
    const source = new EventSource(this.liveUrl);
    const handle = (e: Event) => this.dispatch((e as MessageEvent).data);
    for (const name of ['list', 'page', 'deleted', 'rows']) source.addEventListener(name, handle);
    this.source = source;
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

/** {@link DataClient} backed by an OpenBook server's HTTP API. Isomorphic. */
export class HttpDataClient implements DataClient {
  private readonly baseUrl: string;
  private live: LiveStream | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** Lazily create the shared live connection (browser-only). */
  private liveStream(): LiveStream {
    if (!this.live) this.live = new LiveStream(`${this.baseUrl}${API.live}`);
    return this.live;
  }

  async listPages(): Promise<PageMeta[]> {
    return this.request<PageMeta[]>('GET', API.pages);
  }

  async getPage(id: string): Promise<StoredPage | null> {
    const res = await fetch(`${this.baseUrl}${API.page(id)}`, {cache: 'no-store'});
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

  async movePage(id: string, move: {parentId: string | null; orderedIds: string[]}): Promise<StoredPage> {
    return this.request<StoredPage>('PUT', API.pageMove(id), move);
  }

  async deletePage(id: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}${API.page(id)}`, {method: 'DELETE'});
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
    const res = await fetch(`${this.baseUrl}${API.pageRestore(id)}`, {method: 'POST'});
    if (res.status === 404) return null;
    await throwIfNotOk(res);
    return (await res.json()) as StoredPage;
  }

  async purgePage(id: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}${API.trashItem(id)}`, {method: 'DELETE'});
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
    const res = await fetch(`${this.baseUrl}${API.database(id)}`, {cache: 'no-store'});
    if (res.status === 404) return null;
    await throwIfNotOk(res);
    return (await res.json()) as StoredDatabase;
  }

  async getPageDatabase(pageId: string): Promise<StoredDatabase | null> {
    const res = await fetch(`${this.baseUrl}${API.pageDatabase(pageId)}`, {cache: 'no-store'});
    if (res.status === 404) return null;
    await throwIfNotOk(res);
    return (await res.json()) as StoredDatabase;
  }

  async updateDatabase(id: string, patch: DatabaseUpdate): Promise<StoredDatabase> {
    return this.request<StoredDatabase>('PATCH', API.database(id), patch);
  }

  async deleteDatabase(id: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}${API.database(id)}`, {method: 'DELETE'});
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

  subscribeRows(databaseId: string, onRows: (rows: DatabaseRow[]) => void): () => void {
    return this.liveStream().onRows(databaseId, onRows);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
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
