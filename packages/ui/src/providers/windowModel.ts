/**
 * The window navigation model.
 *
 * A window holds one or more **tabs**; each tab is a back/forward history for a
 * **primary** page plus an optional **split** beside a second page. The active
 * tab's pages are what the document area renders, and (on the desktop) the tabs
 * are drawn as a custom bar in the titlebar. The web shell never opens more than
 * one tab per window — there a "new tab" is a real browser tab — so its window
 * always has a single tab.
 *
 * Everything here is pure (no React, storage, or DOM) so it can be unit-tested
 * and reused by {@link NavigationProvider}.
 */

export type PaneId = 'primary' | 'secondary';

/** One tab: a primary page (with history) plus an optional split. */
export interface TabState {
  id: string;
  /** Visited primary-page ids; `history[index]` is the page on screen. */
  history: string[];
  index: number;
  /** The split pane's page id, or `null` when not split. */
  split: string | null;
  /** Which pane is focused (drives back/forward target and the breadcrumb). */
  focused: PaneId;
}

/** A window: an ordered list of tabs, one active. */
export interface WindowState {
  tabs: TabState[];
  activeTabId: string;
}

export interface Pane {
  id: PaneId;
  pageId: string;
}

let counter = 0;
const newId = (): string => {
  counter += 1;
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : `${counter}`;
  return `tab_${rand}`;
};

// ── Tab-level (pure on a single TabState) ─────────────────────────────────────

export const makeTab = (pageId: string, split: string | null = null): TabState => ({
  id: newId(),
  history: [pageId],
  index: 0,
  split: split && split !== pageId ? split : null,
  focused: 'primary',
});

const tabPrimary = (t: TabState): string => t.history[t.index];
const tabIsSplit = (t: TabState): boolean => t.split !== null;

const tabPanes = (t: TabState): Pane[] => {
  const panes: Pane[] = [{id: 'primary', pageId: tabPrimary(t)}];
  if (t.split !== null) panes.push({id: 'secondary', pageId: t.split});
  return panes;
};

const tabCurrent = (t: TabState): string =>
  t.focused === 'secondary' && t.split !== null ? t.split : tabPrimary(t);

const tabPushPrimary = (t: TabState, pageId: string): TabState => {
  if (tabPrimary(t) === pageId) return t;
  const history = t.history.slice(0, t.index + 1);
  history.push(pageId);
  return {...t, history, index: history.length - 1};
};

const tabNavigate = (t: TabState, pageId: string): TabState => {
  if (t.focused === 'secondary' && tabIsSplit(t)) {
    return t.split === pageId ? t : {...t, split: pageId};
  }
  return tabPushPrimary(t, pageId);
};

const tabStep = (t: TabState, delta: -1 | 1): TabState => {
  const index = t.index + delta;
  return index >= 0 && index < t.history.length ? {...t, index} : t;
};

const tabOpenSplit = (t: TabState, pageId: string): TabState => ({...t, split: pageId, focused: 'secondary'});

const tabCloseSplit = (t: TabState): TabState =>
  tabIsSplit(t) ? {...t, split: null, focused: 'primary'} : t;

const tabClosePane = (t: TabState, pane: PaneId): TabState => {
  if (pane === 'secondary') return tabCloseSplit(t);
  if (!tabIsSplit(t)) return t; // can't close the only pane
  return {...t, history: [t.split!], index: 0, split: null, focused: 'primary'};
};

const tabFocusPane = (t: TabState, pane: PaneId): TabState => (pane === t.focused ? t : {...t, focused: pane});

/** Reconcile one tab against surviving pages; returns `null` if it has nothing left. */
const tabReconcile = (t: TabState, exists: (id: string) => boolean): TabState | null => {
  const history = t.history.filter(exists);
  let next = t;
  if (history.length !== t.history.length) {
    if (history.length === 0) return null; // the tab's page is gone — drop it
    next = {...next, history, index: Math.min(t.index, history.length - 1)};
  }
  if (next.split !== null && !exists(next.split)) next = {...next, split: null, focused: 'primary'};
  return next;
};

// ── Window-level ──────────────────────────────────────────────────────────────

/** A fresh window with a single tab on `pageId`, optionally already split. */
export const initWindow = (pageId: string, split: string | null = null): WindowState => {
  const tab = makeTab(pageId, split);
  return {tabs: [tab], activeTabId: tab.id};
};

export const activeTab = (w: WindowState): TabState => w.tabs.find((t) => t.id === w.activeTabId) ?? w.tabs[0];

const mapActive = (w: WindowState, fn: (t: TabState) => TabState): WindowState => {
  const active = activeTab(w);
  const next = fn(active);
  if (next === active) return w; // no-op keeps the reference (lets React skip work)
  return {...w, tabs: w.tabs.map((t) => (t.id === active.id ? next : t))};
};

/** The primary page id of a tab (for rendering the tab's label). */
export const tabPageId = (t: TabState): string => tabPrimary(t);

export const primaryPage = (w: WindowState): string => tabPrimary(activeTab(w));
export const panesOf = (w: WindowState): Pane[] => tabPanes(activeTab(w));
export const currentPageId = (w: WindowState): string => tabCurrent(activeTab(w));
export const focusedPaneId = (w: WindowState): PaneId => activeTab(w).focused;
export const splitOpen = (w: WindowState): boolean => activeTab(w).split !== null;

export const canGoBack = (w: WindowState): boolean => activeTab(w).index > 0;
export const canGoForward = (w: WindowState): boolean => {
  const t = activeTab(w);
  return t.index < t.history.length - 1;
};

/** Every page id referenced by any tab (for icon/title prefetch + reconcile). */
export const allOpenPageIds = (w: WindowState): string[] => {
  const ids = new Set<string>();
  for (const t of w.tabs) {
    for (const p of t.history) ids.add(p);
    if (t.split) ids.add(t.split);
  }
  return [...ids];
};

// Active-tab navigation.
export const navigateFocused = (w: WindowState, pageId: string): WindowState =>
  mapActive(w, (t) => tabNavigate(t, pageId));
export const goBack = (w: WindowState): WindowState => mapActive(w, (t) => tabStep(t, -1));
export const goForward = (w: WindowState): WindowState => mapActive(w, (t) => tabStep(t, 1));
export const openSplit = (w: WindowState, pageId: string): WindowState => mapActive(w, (t) => tabOpenSplit(t, pageId));
export const closeSplit = (w: WindowState): WindowState => mapActive(w, tabCloseSplit);
export const closePane = (w: WindowState, pane: PaneId): WindowState => mapActive(w, (t) => tabClosePane(t, pane));
export const focusPane = (w: WindowState, pane: PaneId): WindowState => mapActive(w, (t) => tabFocusPane(t, pane));

// Tab management.
export const addTab = (w: WindowState, pageId: string): WindowState => {
  const tab = makeTab(pageId);
  return {tabs: [...w.tabs, tab], activeTabId: tab.id};
};

export const selectTab = (w: WindowState, tabId: string): WindowState =>
  w.tabs.some((t) => t.id === tabId) ? {...w, activeTabId: tabId} : w;

/** Close a tab. The window always keeps at least one. */
export const closeTab = (w: WindowState, tabId: string): WindowState => {
  if (w.tabs.length <= 1) return w;
  const index = w.tabs.findIndex((t) => t.id === tabId);
  const tabs = w.tabs.filter((t) => t.id !== tabId);
  const activeTabId =
    w.activeTabId === tabId ? tabs[Math.min(index, tabs.length - 1)].id : w.activeTabId;
  return {tabs, activeTabId};
};

/**
 * Drop pages that no longer exist (e.g. after a deletion) from every tab. A tab
 * whose page is gone is closed; if that empties the window it falls back to a
 * single tab on `fallbackId`. Returns the same reference when nothing changed.
 */
export const reconcile = (
  w: WindowState,
  exists: (pageId: string) => boolean,
  fallbackId: string | null,
): WindowState => {
  let changed = false;
  const tabs: TabState[] = [];
  for (const t of w.tabs) {
    const next = tabReconcile(t, exists);
    if (next === null) {
      changed = true; // tab dropped
    } else {
      if (next !== t) changed = true;
      tabs.push(next);
    }
  }

  if (tabs.length === 0) {
    return fallbackId ? initWindow(fallbackId) : w;
  }
  if (!changed) return w;

  const activeTabId = tabs.some((t) => t.id === w.activeTabId) ? w.activeTabId : tabs[0].id;
  return {tabs, activeTabId};
};
