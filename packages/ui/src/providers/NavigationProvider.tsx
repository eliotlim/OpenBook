import React, {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {emptyPageSnapshot, type PageMeta} from '@open-book/sdk';
import {useData} from '@/data';

export interface NavigationContextValue {
  /** All pages, most-recently-updated first. */
  pages: PageMeta[];
  /** The page currently open in the editor. */
  currentPageId: string | null;
  loading: boolean;
  error: string | null;
  /** Open a page. */
  selectPage: (id: string) => void;
  /** Step back to the previously visited page. */
  goBack: () => void;
  /** Step forward in the visit history. */
  goForward: () => void;
  /** Whether there is a previous page to step back to. */
  canGoBack: boolean;
  /** Whether there is a next page to step forward to. */
  canGoForward: boolean;
  /** Create a new page (optionally named) and open it. Returns its id. */
  createPage: (name?: string | null) => Promise<string>;
  /** Delete a page; if it was open, opens another (or creates one). */
  deletePage: (id: string) => Promise<void>;
  /** Rename a page (name only). */
  renamePage: (id: string, name: string | null) => Promise<void>;
  /** Re-list pages from the store. */
  reload: () => Promise<PageMeta[]>;
}

const NavigationContext = createContext<NavigationContextValue | null>(null);

/** Page list + current-page state, backed by the data store. */
export const useNavigation = (): NavigationContextValue => {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error('useNavigation must be used within a <NavigationProvider>');
  return ctx;
};

const CURRENT_PAGE_KEY = 'openbook.currentPageId';

const readSavedCurrent = (): string | null =>
  typeof localStorage !== 'undefined' ? localStorage.getItem(CURRENT_PAGE_KEY) : null;

const writeSavedCurrent = (id: string | null): void => {
  if (typeof localStorage === 'undefined') return;
  if (id) localStorage.setItem(CURRENT_PAGE_KEY, id);
  else localStorage.removeItem(CURRENT_PAGE_KEY);
};

export const NavigationProvider: React.FC<PropsWithChildren<unknown>> = ({children}) => {
  const client = useData();
  const [pages, setPages] = useState<PageMeta[]>([]);
  const [currentPageId, setCurrentPageId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Holds the one-time init promise so React 18 StrictMode's double-mount runs
  // it exactly once (and never discards its result).
  const initRef = useRef<Promise<void> | null>(null);

  // In-session visit history (browser-style back/forward). The stack holds
  // visited page ids; `index` is the current position. Forward entries are
  // truncated when navigating somewhere new. Kept in a ref (not state) so the
  // mutating helpers run exactly once per call under StrictMode; the two
  // boolean flags below mirror it for rendering the nav buttons.
  const historyRef = useRef<{stack: string[]; index: number}>({stack: [], index: -1});
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  // Mirror of currentPageId for reading inside the (run-once) live-pages
  // subscription without a stale closure.
  const currentPageIdRef = useRef<string | null>(null);
  currentPageIdRef.current = currentPageId;

  const syncHistoryFlags = useCallback(() => {
    const {stack, index} = historyRef.current;
    setCanGoBack(index > 0);
    setCanGoForward(index >= 0 && index < stack.length - 1);
  }, []);

  // Open a page and record it in history (truncating any forward entries).
  const selectPage = useCallback(
    (id: string) => {
      const hist = historyRef.current;
      if (hist.stack[hist.index] !== id) {
        const stack = hist.stack.slice(0, hist.index + 1);
        stack.push(id);
        historyRef.current = {stack, index: stack.length - 1};
        syncHistoryFlags();
      }
      setCurrentPageId(id);
      writeSavedCurrent(id);
    },
    [syncHistoryFlags],
  );

  const goBack = useCallback(() => {
    const hist = historyRef.current;
    if (hist.index <= 0) return;
    const index = hist.index - 1;
    const id = hist.stack[index];
    historyRef.current = {...hist, index};
    setCurrentPageId(id);
    writeSavedCurrent(id);
    syncHistoryFlags();
  }, [syncHistoryFlags]);

  const goForward = useCallback(() => {
    const hist = historyRef.current;
    if (hist.index >= hist.stack.length - 1) return;
    const index = hist.index + 1;
    const id = hist.stack[index];
    historyRef.current = {...hist, index};
    setCurrentPageId(id);
    writeSavedCurrent(id);
    syncHistoryFlags();
  }, [syncHistoryFlags]);

  const reload = useCallback(async (): Promise<PageMeta[]> => {
    const list = await client.listPages();
    setPages(list);
    return list;
  }, [client]);

  const createPage = useCallback(
    async (name: string | null = null): Promise<string> => {
      const page = await client.savePage({name, data: emptyPageSnapshot()});
      await reload();
      selectPage(page.id);
      return page.id;
    },
    [client, reload, selectPage],
  );

  const deletePage = useCallback(
    async (id: string): Promise<void> => {
      await client.deletePage(id);
      const list = await reload();
      if (currentPageId === id) {
        if (list.length > 0) selectPage(list[0].id);
        else await createPage(null);
      }
    },
    [client, reload, currentPageId, selectPage, createPage],
  );

  const renamePage = useCallback(
    async (id: string, name: string | null): Promise<void> => {
      await client.renamePage(id, name);
      await reload();
    },
    [client, reload],
  );

  // Initial load: list pages, pick the current one, and guarantee a page exists.
  // Runs once (the shared promise survives StrictMode's double-mount), so its
  // result is never discarded and a default page is never created twice.
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = (async () => {
      try {
        let list = await client.listPages();
        if (list.length === 0) {
          await client.savePage({name: null, data: emptyPageSnapshot()});
          list = await client.listPages();
        }
        setPages(list);
        const saved = readSavedCurrent();
        const next = saved && list.some((p) => p.id === saved) ? saved : list[0]?.id ?? null;
        setCurrentPageId(next);
        writeSavedCurrent(next);
        // Seed the history stack with the first page so back/forward has a base.
        if (next) {
          historyRef.current = {stack: [next], index: 0};
          syncHistoryFlags();
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [client, syncHistoryFlags]);

  // Real-time: keep the page list live as pages are created/renamed/deleted
  // by anyone connected to the same server.
  useEffect(() => {
    return client.subscribePages((list) => {
      setPages(list);
      const existing = new Set(list.map((p) => p.id));
      const cur = currentPageIdRef.current;
      if (cur === null) return; // initial selection handled by the load effect
      // Drop any visited pages that no longer exist from the history stack.
      const hist = historyRef.current;
      const filtered = hist.stack.filter((id) => existing.has(id));
      if (existing.has(cur)) {
        const idx = filtered.lastIndexOf(cur);
        historyRef.current = {stack: filtered, index: idx < 0 ? Math.max(0, filtered.length - 1) : idx};
        syncHistoryFlags();
        return;
      }
      // The open page was deleted: fall back to the first available page.
      const next = list[0]?.id ?? null;
      let index = next ? filtered.lastIndexOf(next) : -1;
      if (next && index === -1) {
        filtered.push(next);
        index = filtered.length - 1;
      }
      historyRef.current = {stack: filtered, index};
      syncHistoryFlags();
      currentPageIdRef.current = next;
      setCurrentPageId(next);
      writeSavedCurrent(next);
    });
  }, [client, syncHistoryFlags]);

  return (
    <NavigationContext.Provider
      value={{
        pages,
        currentPageId,
        loading,
        error,
        selectPage,
        goBack,
        goForward,
        canGoBack,
        canGoForward,
        createPage,
        deletePage,
        renamePage,
        reload,
      }}
    >
      {children}
    </NavigationContext.Provider>
  );
};
