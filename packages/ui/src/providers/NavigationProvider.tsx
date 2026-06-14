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
import {setPageLinkBridge, type PageLinkResult} from '@/lib/pageLinks';
import {readPageIcon, readStoredPageIcon, writePageIcon} from '@/lib/pageIcon';
import {recordRecent} from '@/lib/recents';
import {CONFIG_PANE_ID, CUSTOMISE_PANE_ID, FLOW_PANE_ID, HOME_PAGE_ID, REVIEW_PANE_ID} from '@/lib/homePage';
import {registerKitPanelNav} from '@/blockeditor/kit/kitPanel';
import {t as bareT} from '@/i18n';
import {removeFavorite} from '@/lib/favorites';
import {usePlatformLibrary, type NewViewTarget} from './PlatformLibraryProvider';
import * as W from './windowModel';
import type {Pane, PaneId, WindowState} from './windowModel';

export type {Pane, PaneId, WindowState} from './windowModel';

export interface NavigationContextValue {
  /** All top-level pages, most-recently-updated first (database rows excluded). */
  pages: PageMeta[];
  /** The page in the focused pane of this window. */
  currentPageId: string | null;
  loading: boolean;
  error: string | null;

  // ── In-window tabs (desktop) ────────────────────────────────────────────────
  /** Whether tabs live inside the window (a custom titlebar tab bar). */
  inWindowTabs: boolean;
  /** The window's tabs, each with the page it shows. */
  tabs: {id: string; pageId: string}[];
  /** The active tab's id. */
  activeTabId: string;
  /** Activate a tab. */
  selectTab: (tabId: string) => void;
  /** Close a tab (the window keeps at least one). */
  closeTab: (tabId: string) => void;

  // ── Panes (the active tab) ───────────────────────────────────────────────────
  /** The panes shown by the active tab (the primary, plus the secondary when split). */
  panes: Pane[];
  /** The focused pane id. */
  focusedPaneId: PaneId;
  /** Whether the active tab is currently split. */
  splitOpen: boolean;
  /** Mark a pane focused (e.g. on click). */
  focusPane: (pane: PaneId) => void;
  /** Open a page beside the current one in the split pane. */
  openInSplit: (id: string) => void;
  /** Close the split pane. */
  closeSplit: () => void;
  /** Close a pane (secondary collapses the split; primary promotes the secondary). */
  closePane: (pane: PaneId) => void;
  /** Open a page in a new tab or window (in-window tab + OS window on desktop, browser tab/window on web). */
  openInNew: (id: string, target: NewViewTarget) => void;
  /** Create a fresh blank page and open it in a new tab or window. */
  newPageIn: (target: NewViewTarget) => Promise<void>;
  /** Remove this window's view of a page (used when a row/subpage is deleted). */
  closePage: (id: string) => void;
  /** A display title for any page id, including open subpages not in `pages`. */
  pageLabel: (id: string) => string;
  /** Seed a known title for a page (e.g. a database row being opened). */
  setPageHint: (id: string, name: string | null) => void;

  // ── Single-page navigation ──────────────────────────────────────────────────
  /** Navigate the focused pane to a page. */
  selectPage: (id: string) => void;
  /** Navigate (and focus) a SPECIFIC pane, regardless of which is focused. All
   *  link / sidebar / breadcrumb navigation targets the primary pane; the side
   *  pane stays put as a reference and changes only via "open in split". */
  selectPageInPane: (id: string, pane: PaneId) => void;
  goBack: () => void;
  goForward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;

  /** Create a new page (optionally named, optionally nested) and open it. Returns its id. */
  createPage: (name?: string | null, parentId?: string | null) => Promise<string>;
  /** Create a host page that contains a fresh database (optionally nested), and open it. */
  createDatabasePage: (parentId?: string | null) => Promise<string>;
  /**
   * Create a child page nested under `parentId` without navigating to it (used
   * by the inline subpage blocks). `kind: 'database'` also attaches a database.
   * Returns the new page's id.
   */
  createSubpage: (parentId: string, kind?: 'page' | 'database') => Promise<string>;
  /** Duplicate a page (its content, name, and icon) as a sibling, then open it. */
  duplicatePage: (id: string) => Promise<void>;
  /** Delete a page; closes its panes and falls back if nothing remains open. */
  deletePage: (id: string) => Promise<void>;
  /** Rename a page (name only). */
  renamePage: (id: string, name: string | null) => Promise<void>;
  /**
   * Reorder / re-nest a page in the sidebar tree: set its parent (`null` = top
   * level) and the new ordered list of sibling ids under that parent (including
   * this page). Drives drag-to-reorder and drag-to-nest.
   */
  movePage: (id: string, parentId: string | null, orderedIds: string[]) => Promise<void>;
  /** Re-list pages from the store. */
  reload: () => Promise<PageMeta[]>;
}

const NavigationContext = createContext<NavigationContextValue | null>(null);

export const useNavigation = (): NavigationContextValue => {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error('useNavigation must be used within a <NavigationProvider>');
  return ctx;
};

const LAST_PAGE_KEY = 'openbook.currentPageId';

// ── URL <-> window state ──────────────────────────────────────────────────────
// A window's pages live in the query string so it restores on refresh and new
// native tabs open by URL: `?page=<primary>&split=<secondary>`.

const readUrl = (): {page: string | null; split: string | null} => {
  if (typeof window === 'undefined') return {page: null, split: null};
  const params = new URLSearchParams(window.location.search);
  return {page: params.get('page'), split: params.get('split')};
};

const writeUrl = (primary: string, split: string | null): void => {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('page', primary);
  if (split) url.searchParams.set('split', split);
  else url.searchParams.delete('split');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  try {
    localStorage.setItem(LAST_PAGE_KEY, primary);
  } catch {
    // ignore storage failures
  }
};

/** Absolute URL for opening a page in a new tab (the default web behavior). */
const pageUrl = (id: string): string => {
  const url = new URL(window.location.href);
  url.searchParams.set('page', id);
  url.searchParams.delete('split');
  return url.toString();
};

const readLastPage = (): string | null => {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(LAST_PAGE_KEY) : null;
  } catch {
    return null;
  }
};

export const NavigationProvider: React.FC<PropsWithChildren<unknown>> = ({children}) => {
  const client = useData();
  const platform = usePlatformLibrary();
  const [pages, setPages] = useState<PageMeta[]>([]);
  const [win, setWin] = useState<WindowState | null>(null);
  const [titleHints, setTitleHints] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const initRef = useRef<Promise<void> | null>(null);
  const prevTopLevelIds = useRef<Set<string>>(new Set());

  // Mirror the window into the URL whenever it changes. The block-settings pane
  // is ephemeral (its config lives in an in-memory bridge), so it never goes in
  // the URL — a reload would otherwise reopen an empty pane.
  useEffect(() => {
    if (!win) return;
    const split = W.activeTab(win).split;
    const ephemeral = split === CONFIG_PANE_ID || split === CUSTOMISE_PANE_ID || split === REVIEW_PANE_ID;
    writeUrl(W.primaryPage(win), ephemeral ? null : split);
  }, [win]);

  const update = useCallback((fn: (w: WindowState) => WindowState) => {
    setWin((prev) => (prev ? fn(prev) : prev));
  }, []);

  const reload = useCallback(async (): Promise<PageMeta[]> => {
    const list = await client.listPages();
    setPages(list);
    return list;
  }, [client]);

  // ── Navigation ──────────────────────────────────────────────────────────────
  const selectPage = useCallback((id: string) => update((w) => W.navigateFocused(w, id)), [update]);
  const selectPageInPane = useCallback(
    (id: string, pane: PaneId) => update((w) => W.navigatePane(w, pane, id)),
    [update],
  );
  const goBack = useCallback(() => update(W.goBack), [update]);
  const goForward = useCallback(() => update(W.goForward), [update]);
  const focusPane = useCallback((pane: PaneId) => update((w) => W.focusPane(w, pane)), [update]);
  const openInSplit = useCallback((id: string) => update((w) => W.openSplit(w, id)), [update]);
  const closeSplit = useCallback(() => update(W.closeSplit), [update]);
  const closePane = useCallback((pane: PaneId) => update((w) => W.closePane(w, pane)), [update]);
  const selectTab = useCallback((tabId: string) => update((w) => W.selectTab(w, tabId)), [update]);
  const closeTab = useCallback((tabId: string) => update((w) => W.closeTab(w, tabId)), [update]);

  const closePage = useCallback(
    (id: string) => setWin((w) => (w ? W.reconcile(w, (pid) => pid !== id, pages[0]?.id ?? null) : w)),
    [pages],
  );

  const openInNew = useCallback(
    (id: string, target: NewViewTarget) => {
      if (target === 'tab') {
        // Desktop: an in-window tab. Web: a real browser tab.
        if (platform.tabs?.inWindow) update((w) => W.addTab(w, id));
        else if (typeof window !== 'undefined') window.open(pageUrl(id), '_blank', 'noopener');
        return;
      }
      // A separate window: an OS window on desktop, a popup window on the web.
      if (platform.tabs) platform.tabs.openWindow(id);
      else if (typeof window !== 'undefined') {
        window.open(pageUrl(id), '_blank', 'noopener,popup,width=1280,height=860');
      }
    },
    [platform, update],
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
      if (id === HOME_PAGE_ID) return bareT('nav.home');
      if (id === FLOW_PANE_ID) return bareT('flow.title');
      if (id === CONFIG_PANE_ID) return 'Settings';
      if (id === CUSTOMISE_PANE_ID) return 'Customise';
      if (id === REVIEW_PANE_ID) return 'Review';
      const meta = pages.find((p) => p.id === id);
      if (meta) return meta.name && meta.name.trim().length > 0 ? meta.name : 'Untitled';
      return titleHints[id] ?? 'Untitled';
    },
    [pages, titleHints],
  );

  const createPage = useCallback(
    async (name: string | null = null, parentId: string | null = null): Promise<string> => {
      const page = await client.savePage({name, data: emptyPageSnapshot(), parentId});
      await reload();
      selectPage(page.id);
      return page.id;
    },
    [client, reload, selectPage],
  );

  const createDatabasePage = useCallback(
    async (parentId: string | null = null): Promise<string> => {
      const page = await client.savePage({name: null, data: emptyPageSnapshot(), parentId});
      await client.createDatabase({pageId: page.id, name: null, schema: defaultDatabaseSchema()});
      await reload();
      selectPage(page.id);
      return page.id;
    },
    [client, reload, selectPage],
  );

  const createSubpage = useCallback(
    async (parentId: string, kind: 'page' | 'database' = 'page'): Promise<string> => {
      const page = await client.savePage({name: null, data: emptyPageSnapshot(), parentId});
      if (kind === 'database') {
        await client.createDatabase({pageId: page.id, name: null, schema: defaultDatabaseSchema()});
      }
      await reload();
      return page.id;
    },
    [client, reload],
  );

  const newPageIn = useCallback(
    async (target: NewViewTarget): Promise<void> => {
      const page = await client.savePage({name: null, data: emptyPageSnapshot()});
      await reload();
      openInNew(page.id, target);
    },
    [client, reload, openInNew],
  );

  const duplicatePage = useCallback(
    async (id: string): Promise<void> => {
      const src = await client.getPage(id);
      if (!src) return;
      const name = src.name && src.name.trim().length > 0 ? `${src.name} (copy)` : null;
      // Copy content + nesting. A hosted database isn't cloned (1:1 with its
      // host); the reactive cell values travel with the snapshot.
      const page = await client.savePage({name, data: src.data, parentId: src.parentId});
      const icon = readStoredPageIcon(id);
      if (icon) writePageIcon(page.id, icon);
      await reload();
      selectPage(page.id);
    },
    [client, reload, selectPage],
  );

  const deletePage = useCallback(
    async (id: string): Promise<void> => {
      await client.deletePage(id);
      removeFavorite(id); // a trashed page shouldn't linger in favourites
      const list = await reload();
      setWin((w) => (w ? W.reconcile(w, (pid) => pid !== id, list[0]?.id ?? null) : w));
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

  const movePage = useCallback(
    async (id: string, parentId: string | null, orderedIds: string[]): Promise<void> => {
      await client.movePage(id, {parentId, orderedIds});
      await reload();
    },
    [client, reload],
  );

  // ── @-mention page links ──────────────────────────────────────────────────
  const searchPages = useCallback(
    (query: string, opts?: {databasesOnly?: boolean}): PageLinkResult[] => {
      const q = query.trim().toLowerCase();
      const matches = pages
        .filter((p) => !opts?.databasesOnly || p.hostedDatabaseId)
        .map((p) => ({id: p.id, label: pageLabel(p.id), icon: readPageIcon(p.id)}))
        .filter((r) => q === '' || r.label.toLowerCase().includes(q));
      // Exact title match first, then prefix matches, then by position; cap
      // the list for the popover. Exact-first matters in big workspaces where
      // lookalikes ("Plan", "Plan (imported)", "Plan 2") share a prefix.
      const rank = (label: string): number => {
        const l = label.toLowerCase();
        return l === q ? 2 : l.startsWith(q) ? 1 : 0;
      };
      return matches.sort((a, b) => rank(b.label) - rank(a.label)).slice(0, 8);
    },
    [pages, pageLabel],
  );

  const createLinkedPage = useCallback(
    async (name: string): Promise<string> => {
      const page = await client.savePage({name: name.trim() || null, data: emptyPageSnapshot()});
      await reload();
      return page.id;
    },
    [client, reload],
  );

  // Initial load: list pages, ensure one exists, then open the window described
  // by the URL (`?page`/`?split`), falling back to the last/first page. Runs
  // exactly once (the shared promise survives StrictMode's double-mount).
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

        const known = new Set(list.map((p) => p.id));
        const resolve = async (id: string | null): Promise<string | null> => {
          if (!id) return null;
          if (id === HOME_PAGE_ID || id === FLOW_PANE_ID) return id; // pseudo-pages
          if (known.has(id)) return id;
          return (await client.getPage(id)) !== null ? id : null;
        };

        const {page, split} = readUrl();
        let primary = await resolve(page);
        if (!primary) primary = await resolve(readLastPage());
        if (!primary) primary = list[0]?.id ?? null;
        const secondary = primary ? await resolve(split && split !== primary ? split : null) : null;

        setWin(primary ? W.initWindow(primary, secondary) : null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [client]);

  // Real-time: keep the page list live, and drop panes whose top-level page was
  // deleted by anyone. Subpage panes (ids never in the list) are handled by
  // closePage from the page stream.
  useEffect(() => {
    return client.subscribePages((list) => {
      setPages(list);
      const newIds = new Set(list.map((p) => p.id));
      const removed = [...prevTopLevelIds.current].filter((id) => !newIds.has(id));
      prevTopLevelIds.current = newIds;
      if (removed.length === 0) return;
      removed.forEach(removeFavorite); // drop deleted pages from favourites
      const removedSet = new Set(removed);
      setWin((w) => (w ? W.reconcile(w, (id) => !removedSet.has(id), list[0]?.id ?? null) : w));
    });
  }, [client]);

  // Bridge the inline subpage blocks (which live outside React's context) to
  // navigation. Re-installing on every label/action change refreshes the blocks
  // (e.g. when a linked page is renamed).
  useEffect(() => {
    setPageLinkBridge({
      createSubpage: (parentId, kind) => createSubpage(parentId, kind),
      // A link click navigates the pane it came from (the editor passes 'primary'
      // or 'secondary'); without a target it falls back to the focused pane.
      openPage: (id, pane) => (pane ? selectPageInPane(id, pane) : selectPage(id)),
      label: (id) => pageLabel(id),
      icon: (id) => readPageIcon(id),
      searchPages,
      createPage: createLinkedPage,
    });
    return () => setPageLinkBridge(null);
  }, [createSubpage, selectPage, selectPageInPane, pageLabel, searchPages, createLinkedPage]);

  // Let an interactive block "Expand" its settings into the side pane (reusing
  // the split mechanism rather than a bespoke drawer).
  useEffect(
    () => registerKitPanelNav(() => openInSplit(CONFIG_PANE_ID), () => closeSplit()),
    [openInSplit, closeSplit],
  );

  // Refresh title hints from the live page list.
  useEffect(() => {
    if (pages.length === 0) return;
    setTitleHints((prev) => {
      const next = {...prev};
      for (const p of pages) next[p.id] = p.name && p.name.trim().length > 0 ? p.name : 'Untitled';
      return next;
    });
  }, [pages]);

  const currentPageId = win ? W.currentPageId(win) : null;

  // Track the focused page as "recently visited" (drives the palette's Recent
  // group). Covers every entry point — sidebar, palette, tabs, back/forward.
  useEffect(() => {
    // Home/flow/config are places, not documents — they never enter the recents trail.
    if (
      currentPageId &&
      currentPageId !== HOME_PAGE_ID &&
      currentPageId !== FLOW_PANE_ID &&
      currentPageId !== CONFIG_PANE_ID &&
      currentPageId !== CUSTOMISE_PANE_ID &&
      currentPageId !== REVIEW_PANE_ID
    )
      recordRecent(currentPageId);
  }, [currentPageId]);

  const panes = win ? W.panesOf(win) : [];
  const focusedPaneId: PaneId = win ? W.focusedPaneId(win) : 'primary';
  const splitOpen = win ? W.splitOpen(win) : false;
  const canGoBack = win ? W.canGoBack(win) : false;
  const canGoForward = win ? W.canGoForward(win) : false;
  const inWindowTabs = platform.tabs?.inWindow ?? false;
  const tabs = win ? win.tabs.map((t) => ({id: t.id, pageId: W.tabPageId(t)})) : [];
  const activeTabId = win?.activeTabId ?? '';

  const value = useMemo<NavigationContextValue>(
    () => ({
      pages,
      currentPageId,
      loading,
      error,
      inWindowTabs,
      tabs,
      activeTabId,
      selectTab,
      closeTab,
      panes,
      focusedPaneId,
      splitOpen,
      focusPane,
      openInSplit,
      closeSplit,
      closePane,
      openInNew,
      newPageIn,
      closePage,
      pageLabel,
      setPageHint,
      selectPage,
      selectPageInPane,
      goBack,
      goForward,
      canGoBack,
      canGoForward,
      createPage,
      createDatabasePage,
      createSubpage,
      duplicatePage,
      deletePage,
      renamePage,
      movePage,
      reload,
    }),
    [
      pages, currentPageId, loading, error, inWindowTabs, tabs, activeTabId, selectTab, closeTab,
      panes, focusedPaneId, splitOpen, focusPane, openInSplit,
      closeSplit, closePane, openInNew, newPageIn, closePage, pageLabel, setPageHint, selectPage, selectPageInPane, goBack,
      goForward, canGoBack, canGoForward, createPage, createDatabasePage, createSubpage, duplicatePage, deletePage, renamePage,
      movePage, reload,
    ],
  );

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
};
