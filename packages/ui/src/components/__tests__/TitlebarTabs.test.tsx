import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import TitlebarTabs, {tabIdsToCloseOthers, tabIdsToCloseRight} from '../TitlebarTabs';

const mocks = vi.hoisted(() => ({
  closeTab: vi.fn(),
  openInNew: vi.fn(),
  selectTab: vi.fn(),
  toggleFavorite: vi.fn(),
  desktop: true,
  tabs: [
    {id: 'tab-1', pageId: 'page-1'},
    {id: 'tab-2', pageId: 'page-2'},
    {id: 'tab-3', pageId: 'page-3'},
  ],
}));

const labels: Record<string, string> = {
  'common.close': 'Close',
  'tabs.close': 'Close tab',
  'tabs.new': 'New tab',
  'tabs.closeOthers': 'Close other tabs',
  'tabs.closeRight': 'Close tabs to the right',
  'tabs.duplicate': 'Duplicate tab',
  'tabs.moveToWindow': 'Move to new window',
  'menu.favorite': 'Favorite',
  'menu.openTab': 'Open in new tab',
  'menu.openWindow': 'Open in new window',
  'menu.openSplit': 'Open in split view',
};

vi.mock('@/providers', () => ({
  useNavigation: () => ({
    inWindowTabs: true,
    tabs: mocks.tabs,
    activeTabId: 'tab-1',
    selectTab: mocks.selectTab,
    closeTab: mocks.closeTab,
    openInNew: mocks.openInNew,
    pageLabel: (pageId: string) => `Page ${pageId.slice(-1)}`,
    pages: mocks.tabs.map((tab) => ({id: tab.pageId})),
    openInSplit: vi.fn(),
    createSubpage: vi.fn(),
    duplicatePage: vi.fn(),
    deletePage: vi.fn(),
    selectPage: vi.fn(),
  }),
  usePlatformCapabilities: () => ({
    tabs: mocks.desktop ? {inWindow: true, openWindow: vi.fn()} : undefined,
  }),
  useTranslation: () => ({t: (key: string) => labels[key] ?? key}),
  useHud: () => ({setHud: vi.fn()}),
  useConfirm: () => vi.fn(),
  usePreferences: () => ({preferences: {general: {confirmOnTrash: false}}}),
}));

vi.mock('@/components/LibrarySelectMenu', () => ({default: () => <button type="button">Library</button>}));
vi.mock('@/components/SideNavToggle', () => ({default: () => <button type="button">Sidebar</button>}));
vi.mock('@/components/BackForwardCluster', () => ({default: () => <button type="button">History</button>}));
vi.mock('@/components/PageIcon', () => ({PageIcon: () => null}));
vi.mock('@/components/ShareDialog', () => ({useSharingCapability: () => ({supported: true})}));
vi.mock('@/lib/pageIcon', () => ({readPageIcon: () => '', subscribePageIcon: () => () => {}}));
vi.mock('@/lib/useCopyPageLink', () => ({useCopyPageLink: () => vi.fn()}));
vi.mock('@/lib/pageFullWidth', () => ({usePageFullWidth: () => false, togglePageFullWidth: vi.fn()}));
vi.mock('@/lib/favorites', () => ({isFavorite: () => false, toggleFavorite: mocks.toggleFavorite}));

beforeEach(() => {
  mocks.desktop = true;
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('tab close target helpers', () => {
  const tabs = [{id: 'first'}, {id: 'middle'}, {id: 'last'}];

  it('closes every other tab from the first or last edge', () => {
    expect(tabIdsToCloseOthers(tabs, 'first')).toEqual(['middle', 'last']);
    expect(tabIdsToCloseOthers(tabs, 'last')).toEqual(['first', 'middle']);
  });

  it('keeps an only tab when closing others', () => {
    expect(tabIdsToCloseOthers([{id: 'only'}], 'only')).toEqual([]);
  });

  it('closes only tabs to the right from the first edge', () => {
    expect(tabIdsToCloseRight(tabs, 'first')).toEqual(['middle', 'last']);
  });

  it('has no right-side targets at the last or only-tab edges', () => {
    expect(tabIdsToCloseRight(tabs, 'last')).toEqual([]);
    expect(tabIdsToCloseRight([{id: 'only'}], 'only')).toEqual([]);
  });
});

describe('TitlebarTabs context menu', () => {
  it('renders tab actions at large width without redundant row open targets', () => {
    render(<TitlebarTabs />);
    fireEvent.contextMenu(screen.getAllByRole('tab')[0]);

    for (const label of [
      'Close',
      'Close other tabs',
      'Close tabs to the right',
      'Duplicate tab',
      'Move to new window',
      'Open in split view',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.queryByText('Open in new tab')).toBeNull();
    expect(screen.queryByText('Open in new window')).toBeNull();
    expect(screen.getByRole('menu').classList.contains('w-60')).toBe(true);

    fireEvent.click(screen.getByText('Favorite'));
    expect(mocks.toggleFavorite).toHaveBeenCalledWith('page-1');
  });

  it('runs close-others against the titlebar tab order', () => {
    render(<TitlebarTabs />);
    fireEvent.contextMenu(screen.getAllByRole('tab')[0]);
    fireEvent.click(screen.getByText('Close other tabs'));
    expect(mocks.closeTab.mock.calls).toEqual([['tab-2'], ['tab-3']]);
  });

  it('duplicates the target page in a new tab', () => {
    render(<TitlebarTabs />);
    fireEvent.contextMenu(screen.getAllByRole('tab')[0]);
    fireEvent.click(screen.getByText('Duplicate tab'));

    expect(mocks.openInNew).toHaveBeenCalledWith('page-1', 'tab');
  });

  it('opens the target page in a window before closing its tab', () => {
    render(<TitlebarTabs />);
    fireEvent.contextMenu(screen.getAllByRole('tab')[0]);
    fireEvent.click(screen.getByText('Move to new window'));

    expect(mocks.openInNew).toHaveBeenCalledWith('page-1', 'window');
    expect(mocks.closeTab).toHaveBeenCalledWith('tab-1');
    expect(mocks.openInNew.mock.invocationCallOrder[0]).toBeLessThan(mocks.closeTab.mock.invocationCallOrder[0]);
  });

  it('hides move-to-window without the desktop tabs capability', () => {
    mocks.desktop = false;
    render(<TitlebarTabs />);
    fireEvent.contextMenu(screen.getAllByRole('tab')[0]);
    expect(screen.queryByText('Move to new window')).toBeNull();
  });
});

describe('TitlebarTabs pointer activation', () => {
  it('selects a tab only on primary-button mousedown', () => {
    render(<TitlebarTabs />);
    const tab = screen.getAllByRole('tab')[1];

    fireEvent.mouseDown(tab, {button: 2});
    expect(mocks.selectTab).not.toHaveBeenCalled();

    fireEvent.mouseDown(tab, {button: 0});
    expect(mocks.selectTab).toHaveBeenCalledWith('tab-2');
  });

  it('closes a tab only on primary-button mousedown', () => {
    render(<TitlebarTabs />);
    const close = screen.getAllByRole('button', {name: 'Close tab'})[0];

    fireEvent.mouseDown(close, {button: 2});
    expect(mocks.closeTab).not.toHaveBeenCalled();
    expect(mocks.selectTab).not.toHaveBeenCalled();

    fireEvent.mouseDown(close, {button: 0});
    expect(mocks.closeTab).toHaveBeenCalledWith('tab-1');
    expect(mocks.selectTab).not.toHaveBeenCalled();
  });
});
