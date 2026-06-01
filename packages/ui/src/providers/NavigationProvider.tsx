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

  const selectPage = useCallback((id: string) => {
    setCurrentPageId(id);
    writeSavedCurrent(id);
  }, []);

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
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [client]);

  return (
    <NavigationContext.Provider
      value={{pages, currentPageId, loading, error, selectPage, createPage, deletePage, renamePage, reload}}
    >
      {children}
    </NavigationContext.Provider>
  );
};
