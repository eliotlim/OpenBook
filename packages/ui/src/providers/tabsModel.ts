/**
 * The view model behind multi-tab + split-pane navigation.
 *
 * A **view** is one or two side-by-side **panes**; each pane holds an ordered
 * list of **tabs**, one of them active; each tab carries its own browser-style
 * back/forward **history** of visited page ids. This unifies both features:
 * multiple tabs in one pane *are* the tab bar, and a second pane *is* the split.
 *
 * Everything here is pure (no React, no storage, no DOM) so the reducer logic
 * can be unit-tested in isolation and reused by {@link NavigationProvider}.
 */

export interface TabState {
  id: string;
  /** Visited page ids; `history[index]` is the page the tab currently shows. */
  history: string[];
  index: number;
}

export interface PaneState {
  id: string;
  tabs: TabState[];
  activeTabId: string;
}

export interface ViewState {
  panes: PaneState[];
  focusedPaneId: string;
}

let counter = 0;
const newId = (prefix: string): string => {
  counter += 1;
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : `${counter}`;
  return `${prefix}_${rand}`;
};

// ── Constructors ─────────────────────────────────────────────────────────────

export const makeTab = (pageId: string): TabState => ({id: newId('tab'), history: [pageId], index: 0});

export const makePane = (pageId: string): PaneState => {
  const tab = makeTab(pageId);
  return {id: newId('pane'), tabs: [tab], activeTabId: tab.id};
};

/** A fresh single-pane, single-tab view opened on `pageId`. */
export const initView = (pageId: string): ViewState => {
  const pane = makePane(pageId);
  return {panes: [pane], focusedPaneId: pane.id};
};

// ── Accessors ────────────────────────────────────────────────────────────────

export const tabPageId = (tab: TabState): string => tab.history[tab.index];

export const activeTab = (pane: PaneState): TabState =>
  pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0];

export const focusedPane = (view: ViewState): PaneState =>
  view.panes.find((p) => p.id === view.focusedPaneId) ?? view.panes[0];

/** The page id shown in the focused pane's active tab (the "current page"). */
export const currentPageId = (view: ViewState): string | null => {
  const pane = focusedPane(view);
  if (!pane) return null;
  const tab = activeTab(pane);
  return tab ? tabPageId(tab) : null;
};

export const tabCanGoBack = (tab: TabState): boolean => tab.index > 0;
export const tabCanGoForward = (tab: TabState): boolean => tab.index < tab.history.length - 1;

/** Every page id referenced by any tab in any pane (for icon/title prefetch). */
export const allOpenPageIds = (view: ViewState): string[] => {
  const ids = new Set<string>();
  for (const pane of view.panes) for (const tab of pane.tabs) ids.add(tabPageId(tab));
  return [...ids];
};

// ── Mutations (return a new ViewState; never mutate the input) ────────────────

const mapPane = (view: ViewState, paneId: string, fn: (pane: PaneState) => PaneState): ViewState => ({
  ...view,
  panes: view.panes.map((p) => (p.id === paneId ? fn(p) : p)),
});

const mapTab = (pane: PaneState, tabId: string, fn: (tab: TabState) => TabState): PaneState => ({
  ...pane,
  tabs: pane.tabs.map((t) => (t.id === tabId ? fn(t) : t)),
});

/** Push a page onto a tab's history, truncating any forward entries. */
const pushHistory = (tab: TabState, pageId: string): TabState => {
  if (tabPageId(tab) === pageId) return tab;
  const history = tab.history.slice(0, tab.index + 1);
  history.push(pageId);
  return {...tab, history, index: history.length - 1};
};

/** Navigate the focused pane's active tab to a page (the classic "select page"). */
export const navigateTo = (view: ViewState, pageId: string): ViewState => {
  const pane = focusedPane(view);
  if (!pane) return initView(pageId);
  return mapPane(view, pane.id, (p) => mapTab(p, p.activeTabId, (t) => pushHistory(t, pageId)));
};

const stepActiveTab = (view: ViewState, delta: -1 | 1): ViewState => {
  const pane = focusedPane(view);
  if (!pane) return view;
  return mapPane(view, pane.id, (p) =>
    mapTab(p, p.activeTabId, (t) => {
      const index = t.index + delta;
      return index >= 0 && index < t.history.length ? {...t, index} : t;
    }),
  );
};

export const goBack = (view: ViewState): ViewState => stepActiveTab(view, -1);
export const goForward = (view: ViewState): ViewState => stepActiveTab(view, 1);

/** Focus a pane (its active tab becomes the "current page"). */
export const focusPane = (view: ViewState, paneId: string): ViewState =>
  view.panes.some((p) => p.id === paneId) ? {...view, focusedPaneId: paneId} : view;

/** Open a page in a brand-new tab within a pane (defaults to the focused pane), and focus it. */
export const openTab = (view: ViewState, pageId: string, paneId?: string): ViewState => {
  const targetId = paneId ?? view.focusedPaneId;
  const tab = makeTab(pageId);
  return {
    ...mapPane(view, targetId, (p) => ({...p, tabs: [...p.tabs, tab], activeTabId: tab.id})),
    focusedPaneId: targetId,
  };
};

/** Make a tab active (and focus its pane). */
export const selectTab = (view: ViewState, paneId: string, tabId: string): ViewState => ({
  ...mapPane(view, paneId, (p) => (p.tabs.some((t) => t.id === tabId) ? {...p, activeTabId: tabId} : p)),
  focusedPaneId: paneId,
});

/**
 * Close a tab. Closing a pane's last tab removes the pane — unless it is the
 * only pane, in which case the last tab is kept (a window always has one tab).
 * Focus falls back to a surviving pane.
 */
export const closeTab = (view: ViewState, paneId: string, tabId: string): ViewState => {
  const pane = view.panes.find((p) => p.id === paneId);
  if (!pane) return view;
  const remaining = pane.tabs.filter((t) => t.id !== tabId);

  if (remaining.length === 0) {
    if (view.panes.length === 1) return view; // never leave zero tabs
    const panes = view.panes.filter((p) => p.id !== paneId);
    return {panes, focusedPaneId: panes[0].id};
  }

  // If the active tab was closed, activate its neighbour.
  const closedIndex = pane.tabs.findIndex((t) => t.id === tabId);
  const activeTabId =
    pane.activeTabId === tabId ? remaining[Math.min(closedIndex, remaining.length - 1)].id : pane.activeTabId;
  return mapPane(view, paneId, (p) => ({...p, tabs: remaining, activeTabId}));
};

/**
 * Open a page in a split: ensure a second pane exists (creating it if the view
 * is currently single-pane), open the page there as a new tab, and focus it. If
 * already split, the page opens as a new tab in the non-focused pane.
 */
export const openInSplit = (view: ViewState, pageId: string): ViewState => {
  if (view.panes.length >= 2) {
    const other = view.panes.find((p) => p.id !== view.focusedPaneId) ?? view.panes[1];
    return openTab(view, pageId, other.id);
  }
  const pane = makePane(pageId);
  return {panes: [...view.panes, pane], focusedPaneId: pane.id};
};

/** Remove a pane outright (the split's "close" button). No-op on the last pane. */
export const closePane = (view: ViewState, paneId: string): ViewState => {
  if (view.panes.length <= 1) return view;
  const panes = view.panes.filter((p) => p.id !== paneId);
  return {panes, focusedPaneId: panes.some((p) => p.id === view.focusedPaneId) ? view.focusedPaneId : panes[0].id};
};

/**
 * Reconcile the view against the set of pages that still exist (e.g. after a
 * deletion elsewhere). Each tab's history is filtered to surviving ids; a tab
 * whose history empties is dropped, and a pane that loses all its tabs is
 * dropped too — so a split pane showing a deleted subpage simply closes. Only
 * when *every* pane disappears does the view fall back to `fallbackId`. Returns
 * the same reference when nothing changed so React can skip re-rendering.
 */
export const reconcile = (
  view: ViewState,
  exists: (pageId: string) => boolean,
  fallbackId: string | null,
): ViewState => {
  let changed = false;

  const panes: PaneState[] = [];
  for (const pane of view.panes) {
    const tabs: TabState[] = [];
    for (const tab of pane.tabs) {
      const history = tab.history.filter(exists);
      if (history.length === tab.history.length) {
        tabs.push(tab);
        continue;
      }
      changed = true;
      if (history.length > 0) {
        const index = Math.min(tab.index, history.length - 1);
        tabs.push({...tab, history, index});
      }
      // else: tab dropped entirely (its only page no longer exists)
    }

    if (tabs.length > 0) {
      const activeTabId = tabs.some((t) => t.id === pane.activeTabId) ? pane.activeTabId : tabs[0].id;
      panes.push(activeTabId === pane.activeTabId && tabs === pane.tabs ? pane : {...pane, tabs, activeTabId});
    } else {
      changed = true; // pane dropped
    }
  }

  if (panes.length === 0) {
    return fallbackId ? initView(fallbackId) : view;
  }
  if (!changed) return view;

  const focusedPaneId = panes.some((p) => p.id === view.focusedPaneId) ? view.focusedPaneId : panes[0].id;
  return {panes, focusedPaneId};
};
