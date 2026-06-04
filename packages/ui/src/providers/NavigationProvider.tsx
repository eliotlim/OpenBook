import React, {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {defaultDatabaseSchema, emptyPageSnapshot, type PageMeta} from '@open-book/sdk';
import {useData} from '@/data';
import * as M from './tabsModel';
import type {PaneState, ViewState} from './tabsModel';

export type {PaneState, TabState, ViewState} from './tabsModel';

export interface NavigationContextValue {
  /** All top-level pages, most-recently-updated first (database rows excluded). */
  pages: PageMeta[];
  /** The page open in the focused pane's active tab. */
  currentPageId: string | null;
  loading: boolean;
  error: string | null;

  // ── Tabs + split panes ─────────────────────────────────────────────────────
  /** The open panes (one, or two when split). */
  panes: PaneState[];
  /** The pane whose tab drives back/forward and the breadcrumb. */
  focusedPaneId: string;
  /** Mark a pane focused (e.g. on click). */
  focusPane: (paneId: string) => void;
  /** Open a page in a brand-new tab (focused pane by default). */
  openInNewTab: (id: string, paneId?: string) => void;
  /** Create a fresh blank page and open it in a new tab in `paneId`. */
  newTab: (paneId?: string) => Promise<void>;
  /** Open a page beside the current one in a split pane. */
  openInSplit: (id: string) => void;
  /** Activate a tab within a pane. */
  selectTab: (paneId: string, tabId: string) => void;
  /** Close a tab (drops its pane if it was the pane's last tab). */
  closeTab: (paneId: string, tabId: string) => void;
  /** Close a whole pane (the split's close button). */
  closePane: (paneId: string) => void;
  /** Remove every tab showing a page (used when a row/subpage is deleted). */
  closePage: (id: string) => void;
  /** A display title for any page id, including open subpages not in `pages`. */
  pageLabel: (id: string) => string;
  /** Seed a known title for a page (e.g. a database row being opened). */
  setPageHint: (id: string, name: string | null) => void;

  // ── Single-page navigation (focused pane's active tab) ──────────────────────
  /** Navigate the focused pane to a page (classic sidebar click). */
  selectPage: (id: string) => void;
  goBack: () => void;
  goForward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;

  /** Create a new page (optionally named) and open it. Returns its id. */
  createPage: (name?: string | null) => Promise<string>;
  /** Create a host page that contains a fresh database, and open it. */
  createDatabasePage: () => Promise<string>;
  /** Delete a page; closes its tabs and falls back if nothing remains open. */
  deletePage: (id: string) => Promise<void>;
  /** Rename a page (name only). */
  renamePage: (id: string, name: string | null) => Promise<void>;
  /** Re-list pages from the store. */
  reload: () => Promise<PageMeta[]>;
}

const NavigationContext = createContext<NavigationContextValue | null>(null);

export const useNavigation = (): NavigationContextValue => {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error('useNavigation must be used within a <NavigationProvider>');
  return ctx;
};

const VIEW_KEY = 'openbook.view';
const CURRENT_PAGE_KEY = 'openbook.currentPageId';

const readSavedView = (): ViewState | null => {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    const parsed = raw ? (JSON.parse(raw) as ViewState) : null;
    if (parsed && Array.isArray(parsed.panes) && parsed.panes.length > 0 && parsed.panes[0].tabs?.length) {
      return parsed;
    }
  } catch {
    // Corrupt storage; fall through to a fresh view.
  }
  return null;
};

const writeSavedView = (view: ViewState | null): void => {
  if (typeof localStorage === 'undefined' || !view) return;
  localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  const current = M.currentPageId(view);
  if (current) localStorage.setItem(CURRENT_PAGE_KEY, current);
};

export const NavigationProvider: React.FC<PropsWithChildren<unknown>> = ({children}) => {
  const client = useData();
  const [pages, setPages] = useState<PageMeta[]>([]);
  const [view, setView] = useState<ViewState | null>(null);
  const [titleHints, setTitleHints] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const initRef = useRef<Promise<void> | null>(null);
  // Top-level page ids from the previous list event, to detect deletions.
  const prevTopLevelIds = useRef<Set<string>>(new Set());

  // Persist the view whenever it changes.
  useEffect(() => {
    if (view) writeSavedView(view);
  }, [view]);

  // Single entry point for evolving the view immutably.
  const update = useCallback((fn: (v: ViewState) => ViewState) => {
    setView((prev) => (prev ? fn(prev) : prev));
  }, []);

  const reload = useCallback(async (): Promise<PageMeta[]> => {
    const list = await client.listPages();
    setPages(list);
    return list;
  }, [client]);

  // ── Navigation ──────────────────────────────────────────────────────────────
  const selectPage = useCallback((id: string) => update((v) => M.navigateTo(v, id)), [update]);
  const goBack = useCallback(() => update(M.goBack), [update]);
  const goForward = useCallback(() => update(M.goForward), [update]);
  const focusPane = useCallback((paneId: string) => update((v) => M.focusPane(v, paneId)), [update]);
  const openInNewTab = useCallback((id: string, paneId?: string) => update((v) => M.openTab(v, id, paneId)), [update]);
  const newTab = useCallback(
    async (paneId?: string): Promise<void> => {
      const page = await client.savePage({name: null, data: emptyPageSnapshot()});
      await reload();
      update((v) => M.openTab(v, page.id, paneId));
    },
    [client, reload, update],
  );
  const openInSplit = useCallback((id: string) => update((v) => M.openInSplit(v, id)), [update]);
  const selectTab = useCallback(
    (paneId: string, tabId: string) => update((v) => M.selectTab(v, paneId, tabId)),
    [update],
  );
  const closeTab = useCallback(
    (paneId: string, tabId: string) => update((v) => M.closeTab(v, paneId, tabId)),
    [update],
  );
  const closePane = useCallback((paneId: string) => update((v) => M.closePane(v, paneId)), [update]);

  const closePage = useCallback(
    (id: string) => setView((v) => (v ? M.reconcile(v, (pid) => pid !== id, pages[0]?.id ?? null) : v)),
    [pages],
  );

  const setPageHint = useCallback((id: string, name: string | null) => {
    setTitleHints((prev) => {
      const label = name && name.trim().length > 0 ? name : 'Untitled';
      if (prev[id] === label) return prev;
      return {...prev, [id]: label};
    });
  }, []);

  const pageLabel = useCallback(
    (id: string): string => {
      const meta = pages.find((p) => p.id === id);
      if (meta) return meta.name && meta.name.trim().length > 0 ? meta.name : 'Untitled';
      return titleHints[id] ?? 'Untitled';
    },
    [pages, titleHints],
  );

  const createPage = useCallback(
    async (name: string | null = null): Promise<string> => {
      const page = await client.savePage({name, data: emptyPageSnapshot()});
      await reload();
      selectPage(page.id);
      return page.id;
    },
    [client, reload, selectPage],
  );

  const createDatabasePage = useCallback(async (): Promise<string> => {
    // A database lives on a regular host page: create the page, attach a
    // database with a starter schema, then open it.
    const page = await client.savePage({name: null, data: emptyPageSnapshot()});
    await client.createDatabase({pageId: page.id, name: null, schema: defaultDatabaseSchema()});
    await reload();
    selectPage(page.id);
    return page.id;
  }, [client, reload, selectPage]);

  const deletePage = useCallback(
    async (id: string): Promise<void> => {
      await client.deletePage(id);
      const list = await reload();
      setView((v) => (v ? M.reconcile(v, (pid) => pid !== id, list[0]?.id ?? null) : v));
    },
    [client, reload],
  );

  const renamePage = useCallback(
    async (id: string, name: string | null): Promise<void> => {
      await client.renamePage(id, name);
      setPageHint(id, name);
      await reload();
    },
    [client, reload, setPageHint],
  );

  // Initial load: list pages, ensure one exists, then restore (and prune) the
  // saved view. Runs exactly once (the shared promise survives StrictMode).
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
        prevTopLevelIds.current = new Set(list.map((p) => p.id));

        const listIds = new Set(list.map((p) => p.id));
        const saved = readSavedView();
        let next: ViewState;
        if (saved) {
          // Validate any open page not in the top-level list (could be a still-
          // alive subpage, or a deleted page) by probing the store once.
          const unknown = M.allOpenPageIds(saved).filter((id) => !listIds.has(id));
          const probes = await Promise.all(
            unknown.map(async (id) => [id, (await client.getPage(id)) !== null] as const),
          );
          const alive = new Set<string>([...listIds, ...probes.filter(([, ok]) => ok).map(([id]) => id)]);
          next = M.reconcile(saved, (id) => alive.has(id), list[0]?.id ?? null);
        } else {
          next = M.initView(list[0]?.id ?? '');
        }
        setView(next);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [client]);

  // Real-time: keep the page list live, and drop tabs whose top-level page was
  // deleted by anyone. Subpage tabs (ids never in the list) are left untouched
  // here — their deletion is handled by closePage from the page stream.
  useEffect(() => {
    return client.subscribePages((list) => {
      setPages(list);
      const newIds = new Set(list.map((p) => p.id));
      const removed = [...prevTopLevelIds.current].filter((id) => !newIds.has(id));
      prevTopLevelIds.current = newIds;
      if (removed.length === 0) return;
      const removedSet = new Set(removed);
      setView((v) => (v ? M.reconcile(v, (id) => !removedSet.has(id), list[0]?.id ?? null) : v));
    });
  }, [client]);

  // Refresh title hints from the live page list.
  useEffect(() => {
    if (pages.length === 0) return;
    setTitleHints((prev) => {
      const next = {...prev};
      for (const p of pages) next[p.id] = p.name && p.name.trim().length > 0 ? p.name : 'Untitled';
      return next;
    });
  }, [pages]);

  const currentPageId = view ? M.currentPageId(view) : null;
  const panes = view?.panes ?? [];
  const focusedPaneId = view?.focusedPaneId ?? '';
  const focused = view ? M.focusedPane(view) : null;
  const focusedTab = focused ? M.activeTab(focused) : null;
  const canGoBack = focusedTab ? M.tabCanGoBack(focusedTab) : false;
  const canGoForward = focusedTab ? M.tabCanGoForward(focusedTab) : false;

  const value = useMemo<NavigationContextValue>(
    () => ({
      pages,
      currentPageId,
      loading,
      error,
      panes,
      focusedPaneId,
      focusPane,
      openInNewTab,
      newTab,
      openInSplit,
      selectTab,
      closeTab,
      closePane,
      closePage,
      pageLabel,
      setPageHint,
      selectPage,
      goBack,
      goForward,
      canGoBack,
      canGoForward,
      createPage,
      createDatabasePage,
      deletePage,
      renamePage,
      reload,
    }),
    [
      pages, currentPageId, loading, error, panes, focusedPaneId, focusPane, openInNewTab, newTab, openInSplit,
      selectTab, closeTab, closePane, closePage, pageLabel, setPageHint, selectPage, goBack, goForward,
      canGoBack, canGoForward, createPage, createDatabasePage, deletePage, renamePage, reload,
    ],
  );

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
};
