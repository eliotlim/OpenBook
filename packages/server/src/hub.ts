import type {PageMeta, StoredPage} from '@open-book/sdk';

/** An update to a single page, pushed to subscribers of that page. */
export type PageEvent = {type: 'page'; page: StoredPage} | {type: 'deleted'; id: string};
/** The current page list, pushed to subscribers of the list. */
export type ListEvent = {type: 'list'; pages: PageMeta[]};

type PageListener = (event: PageEvent) => void;
type ListListener = (event: ListEvent) => void;

/**
 * In-memory pub/sub powering live updates. Every write to the store publishes
 * here, and the SSE endpoints relay events to connected clients — this is the
 * server-driven refresh loop that keeps collaborators in sync.
 */
export class PageHub {
  private readonly pageListeners = new Map<string, Set<PageListener>>();
  private readonly listListeners = new Set<ListListener>();

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

  publishPage(page: StoredPage): void {
    this.pageListeners.get(page.id)?.forEach((fn) => fn({type: 'page', page}));
  }

  publishDeleted(id: string): void {
    this.pageListeners.get(id)?.forEach((fn) => fn({type: 'deleted', id}));
  }

  publishList(pages: PageMeta[]): void {
    this.listListeners.forEach((fn) => fn({type: 'list', pages}));
  }
}
