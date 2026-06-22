import React, {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import type {DataClient, PageSnapshot} from '@book.dev/sdk';

const DataContext = createContext<DataClient | null>(null);

/**
 * Provides the active {@link DataClient} to the document UI. The host (desktop
 * app or web shell) decides which client to inject — local Tauri store or a
 * remote HTTP server.
 */
export const DataProvider: React.FC<PropsWithChildren<{client: DataClient}>> = ({
  client,
  children,
}) => <DataContext.Provider value={client}>{children}</DataContext.Provider>;

/** Access the active data client. Throws if used outside a {@link DataProvider}. */
export const useData = (): DataClient => {
  const client = useContext(DataContext);
  if (!client) {
    throw new Error('useData must be used within a <DataProvider>');
  }
  return client;
};

/**
 * Wire a page's persistence to the active client, producing the `onLoad`/
 * `onSave` callbacks the document editor expects. Saving stores the snapshot as
 * the page's `data`; loading returns the stored snapshot (or `null`).
 */
export const usePagePersistence = (pageId: string, name?: string | null) => {
  const client = useData();

  const onLoad = useCallback(async (): Promise<PageSnapshot | null> => {
    const page = await client.getPage(pageId);
    return page ? page.data : null;
  }, [client, pageId]);

  const onSave = useCallback(
    async (snapshot: PageSnapshot): Promise<void> => {
      await client.savePage({id: pageId, name: name ?? null, data: snapshot});
    },
    [client, pageId, name],
  );

  return {onLoad, onSave};
};

const CURRENT_PAGE_KEY = 'openbook.currentPageId';

/**
 * Read (or lazily mint + persist) the id of the page this install is currently
 * editing. Until multi-page navigation lands, this keeps a single document
 * stable across restarts. Returns `null` during SSR / first paint, then the id
 * after mount — render the document only once it is non-null.
 */
export const useCurrentPageId = (): string | null => {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    setId(getOrCreateCurrentPageId());
  }, []);
  return id;
};

/** Imperative variant of {@link useCurrentPageId}. Browser-only. */
export const getOrCreateCurrentPageId = (): string => {
  if (typeof localStorage === 'undefined') {
    throw new Error('getOrCreateCurrentPageId requires a browser environment');
  }
  let id = localStorage.getItem(CURRENT_PAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(CURRENT_PAGE_KEY, id);
  }
  return id;
};
