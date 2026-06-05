/**
 * The per-window navigation model.
 *
 * Tabs are now platform-native: each browser tab (web) or macOS window-tab
 * (desktop) runs its own app instance showing one **primary** page, optionally
 * **split** beside a second page. So a window's state is just a back/forward
 * history for the primary page plus one optional secondary page id — no in-app
 * tab list. The primary page is mirrored into the URL (`?page=`), the secondary
 * into `?split=`, so a window restores on refresh and new tabs open by URL.
 *
 * Everything here is pure (no React, storage, or DOM) so it can be unit-tested
 * and reused by {@link NavigationProvider}.
 */

export type PaneId = 'primary' | 'secondary';

export interface WindowState {
  /** Visited primary-page ids; `history[index]` is the page on screen. */
  history: string[];
  index: number;
  /** The split pane's page id, or `null` when not split. */
  split: string | null;
  /** Which pane is focused (drives back/forward target and the breadcrumb). */
  focused: PaneId;
}

export interface Pane {
  id: PaneId;
  pageId: string;
}

/** A fresh window on `pageId`, optionally already split on `split`. */
export const initWindow = (pageId: string, split: string | null = null): WindowState => ({
  history: [pageId],
  index: 0,
  split: split && split !== pageId ? split : null,
  focused: 'primary',
});

export const primaryPage = (w: WindowState): string => w.history[w.index];

const isSplit = (w: WindowState): boolean => w.split !== null;

/** The panes to render: the primary, plus the secondary when split. */
export const panesOf = (w: WindowState): Pane[] => {
  const panes: Pane[] = [{id: 'primary', pageId: primaryPage(w)}];
  if (w.split !== null) panes.push({id: 'secondary', pageId: w.split});
  return panes;
};

/** The page in the focused pane (the "current page"). */
export const currentPageId = (w: WindowState): string =>
  w.focused === 'secondary' && w.split !== null ? w.split : primaryPage(w);

export const canGoBack = (w: WindowState): boolean => w.index > 0;
export const canGoForward = (w: WindowState): boolean => w.index < w.history.length - 1;

/** Every page id referenced by the window (for icon/title prefetch + reconcile). */
export const allOpenPageIds = (w: WindowState): string[] => {
  const ids = new Set<string>(w.history);
  if (w.split !== null) ids.add(w.split);
  return [...ids];
};

// ── Mutations (return a new WindowState; never mutate the input) ──────────────

const pushPrimary = (w: WindowState, pageId: string): WindowState => {
  if (primaryPage(w) === pageId) return w;
  const history = w.history.slice(0, w.index + 1);
  history.push(pageId);
  return {...w, history, index: history.length - 1};
};

/** Navigate the focused pane to a page (the classic sidebar click). */
export const navigateFocused = (w: WindowState, pageId: string): WindowState => {
  if (w.focused === 'secondary' && isSplit(w)) {
    return w.split === pageId ? w : {...w, split: pageId};
  }
  return pushPrimary(w, pageId);
};

const stepPrimary = (w: WindowState, delta: -1 | 1): WindowState => {
  const index = w.index + delta;
  return index >= 0 && index < w.history.length ? {...w, index} : w;
};

export const goBack = (w: WindowState): WindowState => stepPrimary(w, -1);
export const goForward = (w: WindowState): WindowState => stepPrimary(w, 1);

/** Open a page in the split pane (creating the split) and focus it. */
export const openSplit = (w: WindowState, pageId: string): WindowState => ({
  ...w,
  split: pageId,
  focused: 'secondary',
});

/** Close the split pane and return focus to the primary. */
export const closeSplit = (w: WindowState): WindowState =>
  isSplit(w) ? {...w, split: null, focused: 'primary'} : w;

/** Close a specific pane. Closing the secondary collapses the split; closing
 *  the primary while split promotes the secondary to primary. */
export const closePane = (w: WindowState, pane: PaneId): WindowState => {
  if (pane === 'secondary') return closeSplit(w);
  if (!isSplit(w)) return w; // can't close the only pane
  return {history: [w.split!], index: 0, split: null, focused: 'primary'};
};

export const focusPane = (w: WindowState, pane: PaneId): WindowState =>
  pane === w.focused ? w : {...w, focused: pane};

/**
 * Drop pages that no longer exist (e.g. after a deletion). The primary history
 * is filtered; if it empties it falls back to `fallbackId`. A split showing a
 * deleted page simply closes. Returns the same reference when nothing changed.
 */
export const reconcile = (
  w: WindowState,
  exists: (pageId: string) => boolean,
  fallbackId: string | null,
): WindowState => {
  let next = w;

  const history = w.history.filter(exists);
  if (history.length !== w.history.length) {
    if (history.length > 0) {
      const index = Math.min(w.index, history.length - 1);
      next = {...next, history, index};
    } else if (fallbackId) {
      next = {...next, history: [fallbackId], index: 0};
    } else {
      return w; // nothing to fall back to; leave as-is
    }
  }

  if (next.split !== null && !exists(next.split)) {
    next = {...next, split: null, focused: 'primary'};
  }

  return next;
};
