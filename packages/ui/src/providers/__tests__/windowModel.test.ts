import {describe, expect, it} from 'vitest';
import {
  activeTab,
  addTab,
  allOpenPageIds,
  canGoBack,
  canGoForward,
  closePane,
  closeSplit,
  closeTab,
  currentPageId,
  focusedPaneId,
  focusPane,
  goBack,
  goForward,
  initWindow,
  navigateFocused,
  openSplit,
  panesOf,
  primaryPage,
  reconcile,
  selectTab,
  splitOpen,
} from '../windowModel';

describe('windowModel', () => {
  it('initializes with one tab on a single primary page', () => {
    const w = initWindow('a');
    expect(w.tabs).toHaveLength(1);
    expect(primaryPage(w)).toBe('a');
    expect(panesOf(w)).toHaveLength(1);
    expect(currentPageId(w)).toBe('a');
    expect(splitOpen(w)).toBe(false);
  });

  it('navigates the primary pane with back/forward', () => {
    let w = initWindow('a');
    w = navigateFocused(w, 'b');
    w = navigateFocused(w, 'c');
    expect(currentPageId(w)).toBe('c');
    expect(canGoBack(w)).toBe(true);
    expect(canGoForward(w)).toBe(false);
    w = goBack(w);
    expect(currentPageId(w)).toBe('b');
    w = goForward(w);
    expect(currentPageId(w)).toBe('c');
  });

  it('truncates forward history on a new navigation', () => {
    let w = initWindow('a');
    w = navigateFocused(w, 'b');
    w = goBack(w); // a
    w = navigateFocused(w, 'c');
    expect(canGoForward(w)).toBe(false);
    expect(currentPageId(w)).toBe('c');
  });

  it('opens a split, focuses it, and navigates the secondary pane', () => {
    let w = initWindow('a');
    w = openSplit(w, 'b');
    expect(panesOf(w).map((p) => p.pageId)).toEqual(['a', 'b']);
    expect(focusedPaneId(w)).toBe('secondary');
    expect(currentPageId(w)).toBe('b');
    w = navigateFocused(w, 'c');
    expect(activeTab(w).split).toBe('c');
    expect(primaryPage(w)).toBe('a');
  });

  it('navigates the primary pane when it is focused even while split', () => {
    let w = openSplit(initWindow('a'), 'b');
    w = focusPane(w, 'primary');
    w = navigateFocused(w, 'c');
    expect(primaryPage(w)).toBe('c');
    expect(activeTab(w).split).toBe('b');
  });

  it('closes the split and returns focus to the primary', () => {
    let w = openSplit(initWindow('a'), 'b');
    w = closeSplit(w);
    expect(splitOpen(w)).toBe(false);
    expect(focusedPaneId(w)).toBe('primary');
    expect(panesOf(w)).toHaveLength(1);
  });

  it('promotes the secondary to primary when the primary pane is closed', () => {
    let w = openSplit(initWindow('a'), 'b');
    w = closePane(w, 'primary');
    expect(primaryPage(w)).toBe('b');
    expect(splitOpen(w)).toBe(false);
  });

  it('never closes the only pane', () => {
    const w = initWindow('a');
    expect(closePane(w, 'primary')).toBe(w);
  });

  // ── In-window tabs ──────────────────────────────────────────────────────────

  it('adds a tab and makes it active', () => {
    let w = initWindow('a');
    w = addTab(w, 'b');
    expect(w.tabs).toHaveLength(2);
    expect(currentPageId(w)).toBe('b');
    const first = w.tabs[0].id;
    w = selectTab(w, first);
    expect(currentPageId(w)).toBe('a');
  });

  it('keeps each tab independent (own history + split)', () => {
    let w = initWindow('a');
    w = navigateFocused(w, 'a2'); // tab 1: a -> a2
    w = addTab(w, 'b');
    w = openSplit(w, 'b-split'); // tab 2 split
    const tab1 = w.tabs[0].id;
    w = selectTab(w, tab1);
    expect(currentPageId(w)).toBe('a2');
    expect(splitOpen(w)).toBe(false); // tab 1 isn't split
    expect(canGoBack(w)).toBe(true); // tab 1 has its own history
  });

  it('closing the active tab activates a neighbour; never closes the last', () => {
    let w = addTab(addTab(initWindow('a'), 'b'), 'c'); // tabs a,b,c active c
    const cId = w.activeTabId;
    w = closeTab(w, cId);
    expect(w.tabs).toHaveLength(2);
    expect(currentPageId(w)).toBe('b');
    const only = closeTab(closeTab(w, w.tabs[1].id), w.tabs[0].id);
    expect(only.tabs).toHaveLength(1); // last tab is kept
  });

  it('reconcile drops deleted pages from a tab and closes a split', () => {
    let w = initWindow('a');
    w = navigateFocused(w, 'b'); // history a,b
    w = openSplit(w, 'c');
    w = reconcile(w, (id) => id === 'a', 'a');
    expect(primaryPage(w)).toBe('a');
    expect(splitOpen(w)).toBe(false);
  });

  it('reconcile drops a whole tab whose page is gone', () => {
    let w = addTab(initWindow('a'), 'b'); // tabs a, b
    w = reconcile(w, (id) => id === 'a', 'a'); // b deleted -> its tab drops
    expect(w.tabs).toHaveLength(1);
    expect(primaryPage(w)).toBe('a');
  });

  it('reconcile falls back to one tab when every page is gone', () => {
    let w = addTab(initWindow('a'), 'b');
    w = reconcile(w, () => false, 'z');
    expect(w.tabs).toHaveLength(1);
    expect(primaryPage(w)).toBe('z');
  });

  it('reconcile returns the same reference when nothing changed', () => {
    const w = openSplit(initWindow('a'), 'b');
    expect(reconcile(w, () => true, 'a')).toBe(w);
  });

  it('allOpenPageIds covers every tab', () => {
    let w = navigateFocused(initWindow('a'), 'b');
    w = openSplit(w, 'c');
    w = addTab(w, 'd');
    expect(new Set(allOpenPageIds(w))).toEqual(new Set(['a', 'b', 'c', 'd']));
  });
});
