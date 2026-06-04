import {describe, expect, it} from 'vitest';
import {
  activeTab,
  closePane,
  closeTab,
  currentPageId,
  focusedPane,
  goBack,
  goForward,
  initView,
  navigateTo,
  openInSplit,
  openTab,
  reconcile,
  selectTab,
  tabCanGoBack,
  tabCanGoForward,
  tabPageId,
} from '../tabsModel';

describe('tabsModel', () => {
  it('initializes a single pane / single tab on a page', () => {
    const v = initView('a');
    expect(v.panes).toHaveLength(1);
    expect(v.panes[0].tabs).toHaveLength(1);
    expect(currentPageId(v)).toBe('a');
  });

  it('navigateTo pushes history and supports back/forward', () => {
    let v = initView('a');
    v = navigateTo(v, 'b');
    v = navigateTo(v, 'c');
    expect(currentPageId(v)).toBe('c');
    const tab = activeTab(focusedPane(v));
    expect(tabCanGoBack(tab)).toBe(true);
    expect(tabCanGoForward(tab)).toBe(false);

    v = goBack(v);
    expect(currentPageId(v)).toBe('b');
    v = goForward(v);
    expect(currentPageId(v)).toBe('c');
  });

  it('navigateTo truncates forward history', () => {
    let v = initView('a');
    v = navigateTo(v, 'b');
    v = goBack(v); // back to a
    v = navigateTo(v, 'c'); // replaces forward 'b'
    expect(tabCanGoForward(activeTab(focusedPane(v)))).toBe(false);
    expect(currentPageId(v)).toBe('c');
  });

  it('navigateTo to the same page is a no-op for history', () => {
    let v = initView('a');
    v = navigateTo(v, 'a');
    expect(activeTab(focusedPane(v)).history).toEqual(['a']);
  });

  it('opens and selects tabs within a pane', () => {
    let v = initView('a');
    v = openTab(v, 'b');
    expect(focusedPane(v).tabs).toHaveLength(2);
    expect(currentPageId(v)).toBe('b');
    const firstTabId = focusedPane(v).tabs[0].id;
    v = selectTab(v, focusedPane(v).id, firstTabId);
    expect(currentPageId(v)).toBe('a');
  });

  it('closing the active tab activates a neighbour', () => {
    let v = initView('a');
    v = openTab(v, 'b');
    v = openTab(v, 'c'); // tabs: a, b, c; active c
    const paneId = focusedPane(v).id;
    const cTab = activeTab(focusedPane(v)).id;
    v = closeTab(v, paneId, cTab);
    expect(focusedPane(v).tabs).toHaveLength(2);
    expect(currentPageId(v)).toBe('b');
  });

  it('never closes the last tab of the only pane', () => {
    let v = initView('a');
    const paneId = v.panes[0].id;
    const tabId = v.panes[0].tabs[0].id;
    v = closeTab(v, paneId, tabId);
    expect(v.panes).toHaveLength(1);
    expect(v.panes[0].tabs).toHaveLength(1);
  });

  it('opens a split pane and closes it', () => {
    let v = initView('a');
    v = openInSplit(v, 'b');
    expect(v.panes).toHaveLength(2);
    expect(currentPageId(v)).toBe('b'); // focus moved to the new pane
    v = closePane(v, focusedPane(v).id);
    expect(v.panes).toHaveLength(1);
    expect(currentPageId(v)).toBe('a');
  });

  it('opening a split when already split adds a tab to the other pane', () => {
    let v = initView('a');
    v = openInSplit(v, 'b'); // pane2 focused, tab b
    v = openInSplit(v, 'c'); // already split -> opens in the non-focused pane (pane1)
    expect(v.panes).toHaveLength(2);
    const pane1 = v.panes[0];
    expect(pane1.tabs.map(tabPageId)).toContain('c');
  });

  it('closing a pane to zero tabs removes the pane', () => {
    let v = initView('a');
    v = openInSplit(v, 'b');
    const focused = focusedPane(v);
    v = closeTab(v, focused.id, focused.tabs[0].id);
    expect(v.panes).toHaveLength(1);
    expect(currentPageId(v)).toBe('a');
  });

  it('reconcile drops deleted pages and falls back', () => {
    let v = initView('a');
    v = navigateTo(v, 'b'); // history a,b
    v = openInSplit(v, 'c'); // pane2 on c
    const exists = (id: string) => id === 'a'; // b and c deleted
    v = reconcile(v, exists, 'a');
    // pane2 had only c -> dropped; pane1 history collapses to a
    expect(v.panes).toHaveLength(1);
    expect(currentPageId(v)).toBe('a');
  });

  it('reconcile returns the same reference when nothing changed', () => {
    const v = navigateTo(initView('a'), 'b');
    const out = reconcile(v, () => true, 'a');
    expect(out).toBe(v);
  });
});
