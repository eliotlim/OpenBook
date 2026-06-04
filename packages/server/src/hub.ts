import type {DatabaseRow, PageMeta, StoredPage} from '@open-book/sdk';

/** An update to a single page, pushed to subscribers of that page. */
export type PageEvent = {type: 'page'; page: StoredPage} | {type: 'deleted'; id: string};
/** The current page list, pushed to subscribers of the list. */
export type ListEvent = {type: 'list'; pages: PageMeta[]};
/** The current row list of a database, pushed to its subscribers. */
export type RowsEvent = {type: 'rows'; rows: DatabaseRow[]};

type PageListener = (event: PageEvent) => void;
type ListListener = (event: ListEvent) => void;
type RowsListener = (event: RowsEvent) => void;

/**
 * In-memory pub/sub powering live updates. Every write to the store publishes
 * here, and the SSE endpoints relay events to connected clients — this is the
 * server-driven refresh loop that keeps collaborators in sync.
 */
export class PageHub {
  private readonly pageListeners = new Map<string, Set<PageListener>>();
  private readonly listListeners = new Set<ListListener>();
  private readonly rowsListeners = new Map<string, Set<RowsListener>>();

  subscribePage(id: string, fn: PageListener): () => void {
    let set = this.pageListeners.get(id);
    if (!set) {
      set = new Set();
      this.pageListeners.set(id, set);
    }
    set.add(fn);
    return () => {
      const current = this.pageListeners.get(id);
      current?.delete(fn);
      if (current && current.size === 0) this.pageListeners.delete(id);
    };
  }

  subscribeList(fn: ListListener): () => void {
    this.listListeners.add(fn);
    return () => this.listListeners.delete(fn);
  }

  subscribeRows(databaseId: string, fn: RowsListener): () => void {
    let set = this.rowsListeners.get(databaseId);
    if (!set) {
      set = new Set();
      this.rowsListeners.set(databaseId, set);
    }
    set.add(fn);
    return () => {
      const current = this.rowsListeners.get(databaseId);
      current?.delete(fn);
      if (current && current.size === 0) this.rowsListeners.delete(databaseId);
    };
  }

  publishPage(page: StoredPage): void {
    this.pageListeners.get(page.id)?.forEach((fn) => fn({type: 'page', page}));
  }

  publishDeleted(id: string): void {
    this.pageListeners.get(id)?.forEach((fn) => fn({type: 'deleted', id}));
  }

  publishList(pages: PageMeta[]): void {
    this.listListeners.forEach((fn) => fn({type: 'list', pages}));
  }

  publishRows(databaseId: string, rows: DatabaseRow[]): void {
    this.rowsListeners.get(databaseId)?.forEach((fn) => fn({type: 'rows', rows}));
  }

  /** Whether anyone is currently subscribed to a database's row stream. */
  hasRowsListeners(databaseId: string): boolean {
    return (this.rowsListeners.get(databaseId)?.size ?? 0) > 0;
  }
}
