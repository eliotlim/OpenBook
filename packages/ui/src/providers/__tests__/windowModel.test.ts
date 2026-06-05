import {describe, expect, it} from 'vitest';
import {
  allOpenPageIds,
  canGoBack,
  canGoForward,
  closePane,
  closeSplit,
  currentPageId,
  focusPane,
  goBack,
  goForward,
  initWindow,
  navigateFocused,
  openSplit,
  panesOf,
  primaryPage,
  reconcile,
} from '../windowModel';

describe('windowModel', () => {
  it('initializes on a single primary page', () => {
    const w = initWindow('a');
    expect(primaryPage(w)).toBe('a');
    expect(panesOf(w)).toHaveLength(1);
    expect(currentPageId(w)).toBe('a');
    expect(w.split).toBeNull();
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
    expect(w.focused).toBe('secondary');
    expect(currentPageId(w)).toBe('b');
    // Navigating now moves the secondary pane, not the primary.
    w = navigateFocused(w, 'c');
    expect(w.split).toBe('c');
    expect(primaryPage(w)).toBe('a');
  });

  it('navigates the primary pane when it is focused even while split', () => {
    let w = openSplit(initWindow('a'), 'b');
    w = focusPane(w, 'primary');
    w = navigateFocused(w, 'c');
    expect(primaryPage(w)).toBe('c');
    expect(w.split).toBe('b');
  });

  it('closes the split and returns focus to the primary', () => {
    let w = openSplit(initWindow('a'), 'b');
    w = closeSplit(w);
    expect(w.split).toBeNull();
    expect(w.focused).toBe('primary');
    expect(panesOf(w)).toHaveLength(1);
  });

  it('promotes the secondary to primary when the primary pane is closed', () => {
    let w = openSplit(initWindow('a'), 'b');
    w = closePane(w, 'primary');
    expect(primaryPage(w)).toBe('b');
    expect(w.split).toBeNull();
  });

  it('never closes the only pane', () => {
    const w = initWindow('a');
    expect(closePane(w, 'primary')).toBe(w);
  });

  it('reconcile drops deleted pages and falls back', () => {
    let w = initWindow('a');
    w = navigateFocused(w, 'b'); // history a,b
    w = openSplit(w, 'c');
    w = reconcile(w, (id) => id === 'a', 'a');
    expect(primaryPage(w)).toBe('a');
    expect(w.split).toBeNull(); // c deleted -> split closed
  });

  it('reconcile returns the same reference when nothing changed', () => {
    const w = openSplit(initWindow('a'), 'b');
    expect(reconcile(w, () => true, 'a')).toBe(w);
  });

  it('allOpenPageIds covers history and split', () => {
    let w = navigateFocused(initWindow('a'), 'b');
    w = openSplit(w, 'c');
    expect(new Set(allOpenPageIds(w))).toEqual(new Set(['a', 'b', 'c']));
  });
});
