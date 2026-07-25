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
import {defaultDatabaseSchema, emptyPageSnapshot, type PageMeta} from '@book.dev/sdk';
import {useData} from '@/data';
import {setPageLinkBridge, type PageLinkResult} from '@/lib/pageLinks';
import {hydratePageIcons, readPageIcon, readStoredPageIcon, writePageIcon} from '@/lib/pageIcon';
import {recordRecent} from '@/lib/recents';
import {AGENT_PANE_ID, CONFIG_PANE_ID, CUSTOMISE_PANE_ID, FLOW_PANE_ID, HISTORY_PANE_ID, HOME_PAGE_ID, REVIEW_PANE_ID, TRASH_PAGE_ID} from '@/lib/homePage';
import {PANE_TARGET_STORES, paneHasTarget} from '@/lib/paneTarget';
import {registerKitPanelNav} from '@/blockeditor/kit/kitPanel';
import {t as bareT} from '@/i18n';
import {pagePathLabel} from '@/lib/pagePath';
import {removeFavorite} from '@/lib/favorites';
import {readCrashedPages} from '@/lib/crashRecovery';
import {showToast} from '@/components/ui/toast';
import {usePlatformCapabilities, type NewViewTarget} from './PlatformCapabilitiesProvider';
import * as W from './windowModel';
import type {Pane, PaneId, WindowState} from './windowModel';

export type {Pane, PaneId, WindowState} from './windowModel';

export interface NavigationContextValue {
  /** All top-level pages, most-recently-updated first (database rows excluded). */
  pages: PageMeta[];
  /** The page in the focused pane of this window. */
  currentPageId: string | null;
  /** The page in the PRIMARY (left) pane — what side panes (the assistant,
   *  review, dataflow) act on, regardless of which pane is focused. */
  primaryPageId: string | null;
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
  // ── Active database view (URL `?view=`) ─────────────────────────────────────
  /** The `?view=` param, scoped to the PRIMARY page's database. `null` when the
   *  primary page has no view param (or has navigated away). Consumers should
   *  still confirm it names a real view of *their* database before honouring it. */
  activeViewParam: string | null;
  /** Reflect the primary database's active view id into the URL (`?view=`), or
   *  clear it with `null`. No-op'd by callers that don't own the primary page. */
  setActiveViewParam: (viewId: string | null) => void;

  // ── One-shot database anchors (URL `?row=` / `?group=`) ─────────────────────
  /** A pending "scroll to this row" request from a copied row link
   *  (`?page=<hostDb>&row=<rowId>`), captured at init and cleared on the URL's
   *  first mirror. `null` once there's nothing to anchor. The DatabaseView owning
   *  the row honours it (scroll + transient highlight), then calls {@link clearRowAnchor}. */
  rowAnchor: string | null;
  /** A pending "scroll to this group header" request from a copied group link
   *  (`?page=<hostDb>&group=<groupKey>`). See {@link rowAnchor}. */
  groupAnchor: string | null;
  /** A pending "scroll to this block" request — from a search pick, a copied
   *  block link (`?page=<page>&block=<blockId>`), or {@link selectPageAtBlock}.
   *  The page document owning the block honours it (scroll + transient
   *  highlight), then calls {@link clearBlockAnchor}. See {@link rowAnchor}. */
  blockAnchor: string | null;
  /** Consume {@link rowAnchor} once the row has been scrolled into view. */
  clearRowAnchor: () => void;
  /** Consume {@link groupAnchor} once the group header has been scrolled into view. */
  clearGroupAnchor: () => void;
  /** Consume {@link blockAnchor} once the block has been scrolled into view. */
  clearBlockAnchor: () => void;

  /** Navigate the focused pane to a page. */
  selectPage: (id: string) => void;
  /** Navigate the focused pane to a page and scroll/flash a specific block on
   *  arrival (a search pick or copy-block-link landing on the matched block). */
  selectPageAtBlock: (id: string, blockId: string) => void;
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

  /** Database ROWS whose title matches `query` (best matches first). Rows are
   *  pages too, so the palette and `@`-mention picker can both surface them —
   *  they live under each database, not the top-level {@link pages} list, so
   *  this is async (per-database results are cached and reused). */
  searchRows: (query: string, limit?: number) => Promise<PageLinkResult[]>;
}

const NavigationContext = createContext<NavigationContextValue | null>(null);

export const useNavigation = (): NavigationContextValue => {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error('useNavigation must be used within a <NavigationProvider>');
  return ctx;
};

/** Like {@link useNavigation}, but returns `null` instead of throwing when there
 *  is no provider — for components that may render in a reduced harness (unit
 *  tests, previews) where nav isn't wired. The real app always supplies one. */
export const useOptionalNavigation = (): NavigationContextValue | null => useContext(NavigationContext);

const LAST_PAGE_KEY = 'openbook.currentPageId';

// ── URL <-> window state ──────────────────────────────────────────────────────
// A window's pages live in the query string so it restores on refresh and new
// native tabs open by URL: `?page=<primary>&split=<secondary>`.

const readUrl = (): {
  page: string | null;
  split: string | null;
  view: string | null;
  paneTarget: string | null;
  row: string | null;
  group: string | null;
  block: string | null;
} => {
  if (typeof window === 'undefined')
    return {page: null, split: null, view: null, paneTarget: null, row: null, group: null, block: null};
  const params = new URLSearchParams(window.location.search);
  return {
    page: params.get('page'),
    split: params.get('split'),
    view: params.get('view'),
    paneTarget: params.get('paneTarget'),
    row: params.get('row'),
    group: params.get('group'),
    block: params.get('block'),
  };
};

/** The per-tab primary-history position mirrored into `history.state` on web,
 *  so a `popstate` (browser Back/Forward) can be translated back into a window-
 *  model step. `null` outside the web-history surface (desktop's in-window tabs
 *  own their own back/forward and never touch browser history). */
export interface HistoryEntryState {
  obIndex: number;
}

const writeUrl = (
  primary: string,
  split: string | null,
  view: string | null,
  paneTarget: string | null,
  // How to mirror this window into browser history. `index` is the active tab's
  // primary-history position, stamped into `history.state`; `push` requests a
  // *new* browser entry (a page navigation grew the history) rather than an
  // in-place mirror (a pane/view/anchor change). Absent on the desktop, where
  // the URL is a plain `replaceState` mirror with no browser-history semantics.
  nav?: {push: boolean; index: number | null},
): void => {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('page', primary);
  if (split) url.searchParams.set('split', split);
  else url.searchParams.delete('split');
  // `?view=` names the active database view of the `?page='d database, so a chosen
  // board/timeline is shareable. It is scoped to the primary page — dropped when
  // the pane navigates elsewhere (see the provider's view-param reconciliation).
  if (view) url.searchParams.set('view', view);
  else url.searchParams.delete('view');
  // `?paneTarget=` names the page a side pane (customise/review) is acting on,
  // so `?split=customise&paneTarget=<id>` survives reload pointed at the same
  // page. Omitted when the pane targets the primary page (the restore default).
  if (paneTarget) url.searchParams.set('paneTarget', paneTarget);
  else url.searchParams.delete('paneTarget');
  // `?row=`/`?group=`/`?block=` are one-shot scroll-to anchors (a copied row /
  // group / block link, or a search pick). They're consumed into provider state
  // at init, then dropped here on the first window mirror so the anchor fires
  // exactly once and the address bar stays clean.
  url.searchParams.delete('row');
  url.searchParams.delete('group');
  url.searchParams.delete('block');
  const path = `${url.pathname}${url.search}${url.hash}`;
  const state: HistoryEntryState | null = nav && nav.index !== null ? {obIndex: nav.index} : null;
  // A page navigation on the web pushes a real browser entry so Back/Forward
  // walk the visited-page trail (IA-2). Pane/view/anchor mirrors — and every
  // desktop write — replace in place, keeping a single entry per page.
  if (nav?.push) window.history.pushState(state, '', path);
  else window.history.replaceState(state, '', path);
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
  url.searchParams.delete('view'); // a fresh page opens on its own default view
  url.searchParams.delete('paneTarget'); // no side pane carried into a new tab
  url.searchParams.delete('row'); // a new tab isn't a one-shot scroll-to anchor
  url.searchParams.delete('group');
  url.searchParams.delete('block');
  return url.toString();
};

const readLastPage = (): string | null => {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(LAST_PAGE_KEY) : null;
  } catch {
    return null;
  }
};

/**
 * Forget the last-opened page so the next startup won't auto-reopen it. Called
 * by the crash boundaries (STAB-3) when a page or the whole app throws while
 * rendering, so a reload doesn't deterministically re-poison itself.
 */
export const clearLastPage = (): void => {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(LAST_PAGE_KEY);
  } catch {
    // ignore storage failures
  }
};

export const NavigationProvider: React.FC<PropsWithChildren<unknown>> = ({children}) => {
  const client = useData();
  const platform = usePlatformCapabilities();
  const [pages, setPages] = useState<PageMeta[]>([]);
  const [win, setWin] = useState<WindowState | null>(null);
  const [titleHints, setTitleHints] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The active database view of the primary page, mirrored to `?view=`. Seeded
  // from the URL so a deep link (`?page=…&view=…`) lands on that view.
  const [viewParam, setViewParam] = useState<string | null>(() => readUrl().view);
  // One-shot db anchors from a copied row/group link. Seeded synchronously from
  // the URL (before the window-mirror effect strips them) so the anchor survives
  // the URL cleanup; consumed by the DatabaseView that owns the row/group.
  const [rowAnchor, setRowAnchor] = useState<string | null>(() => readUrl().row);
  const [groupAnchor, setGroupAnchor] = useState<string | null>(() => readUrl().group);
  // One-shot block anchor: seeded from `?block=` (a shared/copied block link) and
  // also set in-session by search picks / block links via {@link selectPageAtBlock}.
  const [blockAnchor, setBlockAnchor] = useState<string | null>(() => readUrl().block);
  const clearRowAnchor = useCallback(() => setRowAnchor(null), []);
  const clearGroupAnchor = useCallback(() => setGroupAnchor(null), []);
  const clearBlockAnchor = useCallback(() => setBlockAnchor(null), []);
  // Mirror of each pane-target store (customise/review), so the URL-sync effect
  // re-runs — and re-writes `?paneTarget=` — the instant a pane's target page
  // changes. A monotonic tick is enough; the effect reads the fresh value.
  const [paneTargetTick, setPaneTargetTick] = useState(0);

  const initRef = useRef<Promise<void> | null>(null);
  const prevTopLevelIds = useRef<Set<string>>(new Set());
  // Lazy per-database row cache for the `@`-mention row search (rows aren't in
  // the top-level `pages` list). Cleared whenever the page list changes, so a
  // renamed/added/removed row is re-listed on the next mention search.
  const rowLinkCache = useRef<Map<string, PageLinkResult[]>>(new Map());
  // The active tab's primary-history index last reflected into browser history
  // (web only). Lets the URL-mirror effect decide push (new page) vs replace
  // (pane/view/anchor), and lets the popstate handler mark the model in sync
  // without re-pushing. `null` until the first mirror seeds it.
  const browserIndexRef = useRef<number | null>(null);

  // Web only: the browser owns Back/Forward. The desktop draws its own in-window
  // tabs, each with a private history, and never touches browser history.
  const webHistory = !(platform.tabs?.inWindow ?? false);
  // The primary page id `viewParam` was last reconciled against — lets us drop a
  // stale `?view=` the moment the primary pane navigates to a different page.
  const prevPrimaryRef = useRef<string | null>(null);

  // Keep the URL-sync effect honest about target changes: bump a tick whenever
  // either pane-target store moves, so a customise/review pane re-mirrors its
  // `?paneTarget=` even when `win` and `viewParam` are unchanged.
  useEffect(() => {
    const bump = () => setPaneTargetTick((n) => n + 1);
    const unsubs = Object.values(PANE_TARGET_STORES).map((store) => store.subscribe(bump));
    return () => unsubs.forEach((u) => u());
  }, []);

  // Mirror the window into the URL whenever it changes. The block-settings and
  // agent panes are ephemeral (their state lives in in-memory bridges with no
  // page target), so they never go in the URL — a reload would otherwise reopen
  // an empty pane. The customise/review panes DO act on a page, so they persist
  // as `?split=…` plus `?paneTarget=<pageId>` (homePage.ts / lib/paneTarget.ts
  // document each pane's persistence).
  useEffect(() => {
    if (!win) return;
    const split = W.activeTab(win).split;
    const ephemeral = split === CONFIG_PANE_ID || split === AGENT_PANE_ID;
    const primary = W.primaryPage(win);
    // A page-targeting pane records its target — but only when it differs from
    // the primary page, since restore defaults an absent param to the primary.
    let paneTarget: string | null = null;
    if (paneHasTarget(split)) {
      const target = PANE_TARGET_STORES[split].get();
      if (target && target !== primary) paneTarget = target;
    }
    // On the web, mirror the active tab's primary-history index into browser
    // history: a *forward* move (the index grew past what the browser reflects)
    // pushes a new entry so Back returns here; every other change (pane/view/
    // anchor, or a Back/Forward the popstate handler already applied) replaces
    // in place. `browserIndexRef` tracks what the browser currently reflects.
    const index = W.activeTab(win).index;
    const push = webHistory && browserIndexRef.current !== null && index > browserIndexRef.current;
    writeUrl(
      primary,
      ephemeral ? null : split,
      viewParam,
      paneTarget,
      webHistory ? {push, index} : undefined,
    );
    if (webHistory) browserIndexRef.current = index;
  }, [win, viewParam, paneTargetTick, webHistory]);

  // Web only: translate the browser's Back/Forward (a `popstate`) into the
  // window model's back/forward. Each entry we wrote carries its primary-history
  // index in `history.state.obIndex`; step the model until it matches. Entries
  // without our state (history from before the app loaded) are left to the
  // browser — stepping past our first entry simply leaves the app, as on any site.
  useEffect(() => {
    if (!webHistory || typeof window === 'undefined') return;
    const onPopState = (event: PopStateEvent) => {
      const state = event.state as HistoryEntryState | null;
      const target = state && typeof state.obIndex === 'number' ? state.obIndex : null;
      if (target === null) return;
      browserIndexRef.current = target; // mark in sync so the mirror won't re-push
      setWin((prev) => {
        if (!prev) return prev;
        let next = prev;
        // Walk one step at a time (guarded by the model's own bounds) so a
        // multi-entry jump — or a stale index — can never spin.
        while (W.activeTab(next).index > target && W.canGoBack(next)) next = W.goBack(next);
        while (W.activeTab(next).index < target && W.canGoForward(next)) next = W.goForward(next);
        return next;
      });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [webHistory]);

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
  // Navigate, then anchor a block. Set the anchor before navigating so it's in
  // place by the time the destination document mounts and consumes it (a same-
  // page pick fires it too, since the anchor — not the page — changed).
  const selectPageAtBlock = useCallback(
    (id: string, blockId: string) => {
      setBlockAnchor(blockId);
      update((w) => W.navigateFocused(w, id));
    },
    [update],
  );
  const selectPageInPane = useCallback(
    (id: string, pane: PaneId) => update((w) => W.navigatePane(w, pane, id)),
    [update],
  );
  // On the web the browser owns the history stack, so the app's own Back/Forward
  // controls drive it (the popstate handler then steps the model) — otherwise
  // the model and browser history would drift apart. The desktop steps the
  // window model directly (its in-window tabs have no browser history).
  const goBack = useCallback(() => {
    if (webHistory && typeof window !== 'undefined') window.history.back();
    else update(W.goBack);
  }, [update, webHistory]);
  const goForward = useCallback(() => {
    if (webHistory && typeof window !== 'undefined') window.history.forward();
    else update(W.goForward);
  }, [update, webHistory]);
  const focusPane = useCallback((pane: PaneId) => update((w) => W.focusPane(w, pane)), [update]);
  const openInSplit = useCallback((id: string) => update((w) => W.openSplit(w, id)), [update]);
  const closeSplit = useCallback(() => update(W.closeSplit), [update]);
  const closePane = useCallback((pane: PaneId) => update((w) => W.closePane(w, pane)), [update]);
  const selectTab = useCallback((tabId: string) => update((w) => W.selectTab(w, tabId)), [update]);
  const closeTab = useCallback((tabId: string) => update((w) => W.closeTab(w, tabId)), [update]);

  const closePage = useCallback(
    (id: string) => setWin((w) => (w ? W.reconcile(w, (pid) => pid !== id, pages[0]?.id ?? HOME_PAGE_ID) : w)),
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
      const label = name && name.trim().length > 0 ? name : bareT('common.untitled');
      if (prev[id] === label) return prev;
      return {...prev, [id]: label};
    });
  }, []);

  const pageLabel = useCallback(
    (id: string): string => {
      if (id === HOME_PAGE_ID) return bareT('nav.home');
      if (id === TRASH_PAGE_ID) return bareT('nav.trash');
      if (id === FLOW_PANE_ID) return bareT('flow.title');
      if (id === CONFIG_PANE_ID) return bareT('pane.config');
      if (id === CUSTOMISE_PANE_ID) return bareT('pane.customise');
      if (id === REVIEW_PANE_ID) return bareT('pane.review');
      if (id === AGENT_PANE_ID) return bareT('pane.agent');
      if (id === HISTORY_PANE_ID) return bareT('pane.history');
      const meta = pages.find((p) => p.id === id);
      if (meta) return meta.name && meta.name.trim().length > 0 ? meta.name : bareT('common.untitled');
      return titleHints[id] ?? bareT('common.untitled');
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
      const page = await client.savePage({name, data: src.data, parentId: src.parentId});
      // A database is 1:1 with its host page, so duplicating the host must
      // clone the database too (schema + rows + sub-item nesting) — a copy
      // that silently drops its table isn't a copy.
      if (src.hostedDatabaseId) {
        const db = await client.getDatabase(src.hostedDatabaseId);
        if (db) {
          const copy = await client.createDatabase({pageId: page.id, name: db.name, schema: db.schema});
          const rows = await client.listRows(db.id);
          // Parents before children so sub-item nesting can point at the
          // already-created copy of the parent row.
          const created = new Set<string>();
          const idMap = new Map<string, string>();
          const pending = [...rows];
          while (pending.length > 0) {
            const readyIndex = pending.findIndex((r) => !r.parentId || created.has(r.parentId));
            // An orphaned parentId (parent row deleted mid-flight): fall back
            // to importing the remainder un-nested rather than spinning.
            const index = readyIndex === -1 ? 0 : readyIndex;
            const row = pending.splice(index, 1)[0];
            const rowPage = await client.getPage(row.id);
            const copied = await client.createRow(copy.id, {
              name: row.name,
              properties: row.properties,
              data: rowPage?.data,
              parentId: row.parentId ? (idMap.get(row.parentId) ?? null) : null,
            });
            created.add(row.id);
            idMap.set(row.id, copied.id);
          }
          // Second pass: dependency (and same-db relation) values captured row
          // ids of the ORIGINAL database — remap any value matching a copied
          // row id so the copy links within itself, not back at the source.
          const remapValue = (v: unknown): unknown =>
            typeof v === 'string' && idMap.has(v)
              ? idMap.get(v)
              : Array.isArray(v)
                ? v.map(remapValue)
                : v;
          for (const row of rows) {
            const next = Object.fromEntries(
              Object.entries(row.properties).map(([k, v]) => [k, remapValue(v)]),
            );
            if (JSON.stringify(next) !== JSON.stringify(row.properties)) {
              await client.updateRow(copy.id, idMap.get(row.id)!, {properties: next});
            }
          }
        }
      }
      const icon = readStoredPageIcon(id);
      if (icon) writePageIcon(page.id, icon);
      await reload();
      selectPage(page.id);
    },
    [client, reload, selectPage],
  );

  const deletePage = useCallback(
    async (id: string): Promise<void> => {
      const label = pageLabel(id);
      await client.deletePage(id);
      removeFavorite(id); // a trashed page shouldn't linger in favourites
      const list = await reload();
      setWin((w) => (w ? W.reconcile(w, (pid) => pid !== id, list[0]?.id ?? HOME_PAGE_ID) : w));
      // Every delete path gets a moment-of-mistake recovery affordance; the
      // Trash dialog remains the durable one.
      showToast({
        message: bareT('trash.movedToast', {page: label}),
        actionLabel: bareT('common.undo'),
        onAction: () => {
          void client.restorePage(id).then(async (restored) => {
            if (!restored) return;
            await reload();
            selectPage(id);
          });
        },
      });
    },
    [client, reload, pageLabel, selectPage],
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
      const byId = new Map(pages.map((p) => [p.id, p] as const));
      const matches = pages
        .filter((p) => !opts?.databasesOnly || p.hostedDatabaseId)
        .map((p) => ({id: p.id, label: pageLabel(p.id), icon: readPageIcon(p.id), path: pagePathLabel(p, byId)}))
        .filter((r) => q === '' || r.label.toLowerCase().includes(q));
      // Exact title match first, then prefix matches, then by position; cap
      // the list for the popover. Exact-first matters in big libraries where
      // lookalikes ("Plan", "Plan (imported)", "Plan 2") share a prefix.
      const rank = (label: string): number => {
        const l = label.toLowerCase();
        return l === q ? 2 : l.startsWith(q) ? 1 : 0;
      };
      return matches.sort((a, b) => rank(b.label) - rank(a.label)).slice(0, 8);
    },
    [pages, pageLabel],
  );

  // Row targets for the `@`-mention picker — database rows are pages too, so `@`
  // can link one (mirroring backlinks, which already point at rows). Async
  // because rows live under each database, not in the top-level page list; the
  // per-database results are cached (invalidated on any page-list change) so a
  // keystroke doesn't re-list every table.
  const searchRows = useCallback(
    async (query: string, limit = 6): Promise<PageLinkResult[]> => {
      const q = query.trim().toLowerCase();
      const dbPages = pages.filter((p) => p.hostedDatabaseId);
      const collected: PageLinkResult[] = [];
      for (const dbPage of dbPages) {
        const dbId = dbPage.hostedDatabaseId!;
        let rows = rowLinkCache.current.get(dbId);
        if (!rows) {
          try {
            const list = await client.listRows(dbId);
            rows = list.map((r) => ({
              id: r.id,
              label: r.name && r.name.trim().length > 0 ? r.name : bareT('common.untitled'),
              icon: readPageIcon(r.id),
              // The host database's name gives the row a disambiguating context,
              // the way an ancestor path does for a page.
              path: pageLabel(dbPage.id),
            }));
            rowLinkCache.current.set(dbId, rows);
          } catch {
            rows = [];
          }
        }
        collected.push(...rows);
      }
      const rank = (label: string): number => {
        const l = label.toLowerCase();
        return l === q ? 2 : l.startsWith(q) ? 1 : 0;
      };
      const top = collected
        .filter((r) => q === '' || r.label.toLowerCase().includes(q))
        .sort((a, b) => rank(b.label) - rank(a.label))
        .slice(0, limit);
      // Seed each row's title so an inserted mention chip renders its name.
      top.forEach((r) => setPageHint(r.id, r.label));
      return top;
    },
    [pages, client, pageLabel, setPageHint],
  );

  // Drop the row cache whenever the page list changes (a row rename/add/remove
  // reflows the list); the next mention search re-lists lazily.
  useEffect(() => {
    rowLinkCache.current.clear();
  }, [pages]);

  const createLinkedPage = useCallback(
    async (name: string, parentId: string | null = null): Promise<string> => {
      // Duplicate names are allowed (migration 0015) — a "[[" wikilink to a name
      // that already exists still creates a fresh child page when the user picks
      // the explicit Create row, so no dedupe here.
      const page = await client.savePage({name: name.trim() || null, data: emptyPageSnapshot(), parentId});
      await reload();
      return page.id;
    },
    [client, reload],
  );

  // Initial load: list pages, then open the window described by the URL
  // (`?page`/`?split`), falling back to the last/first page. A brand-new
  // (empty) library lands on Home — its guided start — rather than
  // auto-creating a blank "Untitled" page nobody asked for. Runs exactly once
  // (the shared promise survives StrictMode's double-mount).
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = (async () => {
      try {
        const list = await client.listPages();
        setPages(list);
        prevTopLevelIds.current = new Set(list.map((p) => p.id));

        const known = new Set(list.map((p) => p.id));
        // Pages that threw while rendering earlier this session (STAB-3). The
        // resolver must NOT auto-open a quarantined page — that's the crash loop
        // (poison persists on disk, startup re-opens the last page, app dies
        // again). Skipped here so the app lands on Home instead; the page stays
        // in the sidebar and reachable by an explicit click.
        const crashed = readCrashedPages();
        const resolve = async (id: string | null): Promise<string | null> => {
          if (!id) return null;
          // Pseudo-pages: Home, Trash, dataflow, and the page-targeting side panes
          // (customise/review) that now round-trip through the URL.
          if (id === HOME_PAGE_ID || id === TRASH_PAGE_ID || id === FLOW_PANE_ID || paneHasTarget(id)) return id;
          if (crashed.has(id)) return null;
          if (known.has(id)) return id;
          return (await client.getPage(id)) !== null ? id : null;
        };

        const {page, split, paneTarget} = readUrl();
        let primary = await resolve(page);
        if (!primary) primary = await resolve(readLastPage());
        // Fall back to the first NON-quarantined page (or Home) rather than
        // list[0], so a poisoned first page can't re-crash the app on startup.
        if (!primary) primary = list.find((p) => !crashed.has(p.id))?.id ?? HOME_PAGE_ID;
        const secondary = await resolve(split && split !== primary ? split : null);

        // Seed a restored side pane's target from the URL (falling back to the
        // primary page) BEFORE the window — hence the pane body — mounts, so it
        // renders pointed at the right page instead of an empty bridge.
        if (paneHasTarget(secondary)) {
          const target = (await resolve(paneTarget)) ?? primary;
          PANE_TARGET_STORES[secondary].set(target);
        }

        setWin(W.initWindow(primary, secondary));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [client]);

  // Icons travel on the page list now (page.properties), so hydrate the shared
  // icon cache whenever the list changes — the sidebar, tabs, mentions, etc. read
  // every page's icon synchronously from there.
  useEffect(() => {
    hydratePageIcons(pages);
  }, [pages]);

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
      setWin((w) => (w ? W.reconcile(w, (id) => !removedSet.has(id), list[0]?.id ?? HOME_PAGE_ID) : w));
    });
  }, [client]);

  // Bridge the inline subpage blocks (which live outside React's context) to
  // navigation. Re-installing on every label/action change refreshes the blocks
  // (e.g. when a linked page is renamed).
  useEffect(() => {
    setPageLinkBridge({
      createSubpage: (parentId, kind) => createSubpage(parentId, kind),
      // A link click navigates the pane it came from (the editor passes 'primary'
      // or 'secondary'); without a target it falls back to the focused pane. A
      // `blockId` additionally anchors the landing on that block (a block-scoped
      // link) — the same one-shot scroll/flash a search pick uses.
      openPage: (id, pane, blockId) => {
        if (blockId) setBlockAnchor(blockId);
        return pane ? selectPageInPane(id, pane) : selectPage(id);
      },
      label: (id) => pageLabel(id),
      icon: (id) => readPageIcon(id),
      searchPages,
      searchRows,
      createPage: createLinkedPage,
    });
    return () => setPageLinkBridge(null);
  }, [createSubpage, selectPage, selectPageInPane, pageLabel, searchPages, searchRows, createLinkedPage]);

  // Let an interactive block "Expand" its settings into the side pane (reusing
  // the split mechanism rather than a bespoke drawer).
  useEffect(
    () => registerKitPanelNav(() => openInSplit(CONFIG_PANE_ID), () => closeSplit()),
    [openInSplit, closeSplit],
  );

  // Desktop `openbook://page/<id>` deep links: the host delivers the target page
  // id here (a cold-start link or one opened while running); navigate the primary
  // pane to it. Pseudo-pages (home/trash) pass straight through; a real id is
  // confirmed against the store first so a stale/foreign link falls back to Home
  // rather than stranding the pane on a page that doesn't exist here.
  useEffect(() => {
    const onNavigate = platform.deepLink?.onNavigate;
    if (!onNavigate) return;
    return onNavigate((pageId) => {
      if (pageId === HOME_PAGE_ID || pageId === TRASH_PAGE_ID || pageId === FLOW_PANE_ID || paneHasTarget(pageId)) {
        selectPageInPane(pageId, 'primary');
        return;
      }
      void client
        .getPage(pageId)
        .then((page) => {
          selectPageInPane(page ? pageId : HOME_PAGE_ID, 'primary');
        })
        // A failed lookup (offline/transport error) must not leave an unhandled
        // rejection — fall back to Home, same as a stale/foreign id.
        .catch(() => selectPageInPane(HOME_PAGE_ID, 'primary'));
    });
  }, [platform.deepLink, client, selectPageInPane]);

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
  const primaryPageId = win ? W.primaryPage(win) : null;

  // A `?view=` names a view of the PRIMARY page's database, so it only survives
  // while that page stays put. When the primary pane navigates to a different
  // page (a non-db page, or another database) the param is stale — drop it. The
  // first observation (init) is preserved so a deep-linked `?view=` still lands.
  useEffect(() => {
    if (primaryPageId === null) return; // window not ready yet
    const prev = prevPrimaryRef.current;
    prevPrimaryRef.current = primaryPageId;
    if (prev !== null && prev !== primaryPageId) setViewParam(null);
  }, [primaryPageId]);

  const setActiveViewParam = useCallback(
    (viewId: string | null) => {
      // The caller owns the primary page; anchor the param to it so the
      // reconciliation effect above doesn't immediately treat it as stale.
      prevPrimaryRef.current = primaryPageId;
      setViewParam(viewId);
    },
    [primaryPageId],
  );

  // Track the focused page as "recently visited" (drives the palette's Recent
  // group). Covers every entry point — sidebar, palette, tabs, back/forward.
  useEffect(() => {
    // Home/trash/flow/config are places, not documents — they never enter the recents trail.
    if (
      currentPageId &&
      currentPageId !== HOME_PAGE_ID &&
      currentPageId !== TRASH_PAGE_ID &&
      currentPageId !== FLOW_PANE_ID &&
      currentPageId !== CONFIG_PANE_ID &&
      currentPageId !== CUSTOMISE_PANE_ID &&
      currentPageId !== REVIEW_PANE_ID &&
      currentPageId !== HISTORY_PANE_ID
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
      primaryPageId,
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
      activeViewParam: viewParam,
      setActiveViewParam,
      rowAnchor,
      groupAnchor,
      blockAnchor,
      clearRowAnchor,
      clearGroupAnchor,
      clearBlockAnchor,
      selectPage,
      selectPageAtBlock,
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
      searchRows,
    }),
    [
      pages, currentPageId, primaryPageId, loading, error, inWindowTabs, tabs, activeTabId, selectTab, closeTab,
      panes, focusedPaneId, splitOpen, focusPane, openInSplit,
      closeSplit, closePane, openInNew, newPageIn, closePage, pageLabel, setPageHint, viewParam, setActiveViewParam,
      rowAnchor, groupAnchor, blockAnchor, clearRowAnchor, clearGroupAnchor, clearBlockAnchor,
      selectPage, selectPageAtBlock, selectPageInPane, goBack,
      goForward, canGoBack, canGoForward, createPage, createDatabasePage, createSubpage, duplicatePage, deletePage, renamePage,
      movePage, reload, searchRows,
    ],
  );

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
};
