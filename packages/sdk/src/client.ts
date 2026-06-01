import {API, type ApiError} from './routes';
import type {PageInput, PageMeta, StoredPage} from './types';

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
  /** Delete a page; resolves `true` if a page was removed. */
  deletePage(id: string): Promise<boolean>;
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

  async deletePage(id: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}${API.page(id)}`, {method: 'DELETE'});
    if (res.status === 404) return false;
    await throwIfNotOk(res);
    return true;
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
