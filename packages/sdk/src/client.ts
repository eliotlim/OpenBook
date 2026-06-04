import {API, type ApiError} from './routes';
import type {PageInput, PageMeta, StoredPage} from './types';
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
  /** Delete a page; resolves `true` if a page was removed. */
  deletePage(id: string): Promise<boolean>;
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

/** {@link DataClient} backed by an OpenBook server's HTTP API. Isomorphic. */
export class HttpDataClient implements DataClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async listPages(): Promise<PageMeta[]> {
    return this.request<PageMeta[]>('GET', API.pages);
  }

  async getPage(id: string): Promise<StoredPage | null> {
    const res = await fetch(`${this.baseUrl}${API.page(id)}`);
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

  async deletePage(id: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}${API.page(id)}`, {method: 'DELETE'});
    if (res.status === 404) return false;
    await throwIfNotOk(res);
    return true;
  }

  subscribePage(id: string, handlers: PageSubscription): () => void {
    const source = new EventSource(`${this.baseUrl}${API.pageStream(id)}`);
    if (handlers.onPage) {
      source.addEventListener('page', (e) => handlers.onPage!(JSON.parse((e as MessageEvent).data) as StoredPage));
    }
    if (handlers.onDeleted) {
      source.addEventListener('deleted', (e) => handlers.onDeleted!((JSON.parse((e as MessageEvent).data) as {id: string}).id));
    }
    return () => source.close();
  }

  subscribePages(onList: (pages: PageMeta[]) => void): () => void {
    const source = new EventSource(`${this.baseUrl}${API.stream}`);
    source.addEventListener('list', (e) => onList(JSON.parse((e as MessageEvent).data) as PageMeta[]));
    return () => source.close();
  }

  // ── Databases ──────────────────────────────────────────────────────────────

  async createDatabase(input: DatabaseInput): Promise<StoredDatabase> {
    return this.request<StoredDatabase>('POST', API.databases, input);
  }

  async getDatabase(id: string): Promise<StoredDatabase | null> {
    const res = await fetch(`${this.baseUrl}${API.database(id)}`);
    if (res.status === 404) return null;
    await throwIfNotOk(res);
    return (await res.json()) as StoredDatabase;
  }

  async getPageDatabase(pageId: string): Promise<StoredDatabase | null> {
    const res = await fetch(`${this.baseUrl}${API.pageDatabase(pageId)}`);
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
    const source = new EventSource(`${this.baseUrl}${API.databaseStream(databaseId)}`);
    source.addEventListener('rows', (e) => onRows(JSON.parse((e as MessageEvent).data) as DatabaseRow[]));
    return () => source.close();
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : {'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
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
