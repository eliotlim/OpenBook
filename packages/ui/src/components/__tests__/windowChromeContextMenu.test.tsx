import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, createEvent, fireEvent, render, screen} from '@testing-library/react';
import TitlebarTabs from '../TitlebarTabs';
import WindowActionsCluster from '../WindowActionsCluster';
import WindowControls from '../WindowControls';

const mocks = vi.hoisted(() => ({
  inWindowTabs: true,
  windowControls: {
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  },
}));

vi.mock('@/providers', () => ({
  useNavigation: () => ({
    inWindowTabs: mocks.inWindowTabs,
    tabs: [],
    activeTabId: '',
    selectTab: vi.fn(),
    closeTab: vi.fn(),
    openInNew: vi.fn(),
    pageLabel: (id: string) => id,
    splitOpen: false,
    openInSplit: vi.fn(),
    closeSplit: vi.fn(),
    currentPageId: 'page-1',
  }),
  usePlatformCapabilities: () => ({windowControls: mocks.windowControls}),
  useTranslation: () => ({t: (key: string) => key}),
}));

vi.mock('../LibrarySelectMenu', () => ({default: () => <button type="button">Library</button>}));
vi.mock('../SideNavToggle', () => ({default: () => <button type="button">Sidebar</button>}));
vi.mock('../BackForwardCluster', () => ({default: () => <button type="button">History</button>}));
vi.mock('../PageIcon', () => ({PageIcon: () => null}));
vi.mock('@/lib/pageIcon', () => ({readPageIcon: () => '', subscribePageIcon: () => () => {}}));

function expectContextMenuSuppressed(element: Element): void {
  const event = createEvent.contextMenu(element);
  fireEvent(element, event);
  expect(event.defaultPrevented).toBe(true);
}

beforeEach(() => {
  mocks.inWindowTabs = true;
});

afterEach(cleanup);

describe('window chrome context-menu suppression', () => {
  it('suppresses every titlebar drag region', () => {
    const {container} = render(<TitlebarTabs />);
    const regions = container.querySelectorAll('[data-tauri-drag-region]');
    expect(regions).toHaveLength(2);
    regions.forEach(expectContextMenuSuppressed);
  });

  it('suppresses the web/desktop filler drag region', () => {
    mocks.inWindowTabs = false;
    const {container} = render(<TitlebarTabs />);
    expectContextMenuSuppressed(container.querySelector('[data-tauri-drag-region]')!);
  });

  it('suppresses frameless window controls', () => {
    render(<WindowControls />);
    for (const name of ['Minimize', 'Maximize', 'Close']) {
      expectContextMenuSuppressed(screen.getByRole('button', {name}));
    }
  });

  it('suppresses the window actions cluster', () => {
    render(<WindowActionsCluster />);
    expectContextMenuSuppressed(screen.getByRole('button', {name: 'Split view'}));
  });
});
