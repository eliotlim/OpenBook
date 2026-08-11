import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {PageMenuItems} from '../PageContextMenu';
import {ContextMenu, ContextMenuContent, ContextMenuTrigger} from '../ui/context-menu';

const mocks = vi.hoisted(() => ({
  openInNew: vi.fn(),
  openInSplit: vi.fn(),
}));

const labels: Record<string, string> = {
  'menu.favorite': 'Add to favorites',
  'menu.openTab': 'Open in new tab',
  'menu.openWindow': 'Open in new window',
  'menu.openSplit': 'Open in split view',
  'menu.rename': 'Rename',
  'menu.copyLink': 'Copy link',
  'menu.duplicate': 'Duplicate',
  'menu.moveTo': 'Move to…',
  'menu.addSubpage': 'Add subpage',
  'menu.addDatabase': 'Add database',
  'menu.moveToTrash': 'Move to trash',
};

vi.mock('@/providers', () => ({
  useNavigation: () => ({
    openInNew: mocks.openInNew,
    openInSplit: mocks.openInSplit,
    createSubpage: vi.fn(),
    duplicatePage: vi.fn(),
    deletePage: vi.fn(),
    selectPage: vi.fn(),
    pages: [{id: 'page-1'}],
  }),
  usePlatformCapabilities: () => ({deepLink: false}),
  useTranslation: () => ({t: (key: string) => labels[key] ?? key}),
  useHud: () => ({setHud: vi.fn()}),
  useConfirm: () => vi.fn(),
  usePreferences: () => ({preferences: {general: {confirmOnTrash: false}}}),
}));

vi.mock('@/components/ShareDialog', () => ({useSharingCapability: () => ({supported: true})}));
vi.mock('@/lib/useCopyPageLink', () => ({useCopyPageLink: () => vi.fn()}));
vi.mock('@/lib/pageFullWidth', () => ({usePageFullWidth: () => false, togglePageFullWidth: vi.fn()}));
vi.mock('@/lib/favorites', () => ({isFavorite: () => false, toggleFavorite: vi.fn()}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderRowMenu(omit?: Readonly<{openTab?: boolean; openWindow?: boolean}>): void {
  render(
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button type="button">Page row</button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <PageMenuItems pageId="page-1" omit={omit} />
      </ContextMenuContent>
    </ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByRole('button', {name: 'Page row'}));
}

function itemLabels(): string[] {
  return screen.getAllByRole('menuitem').map((item) => item.textContent ?? '');
}

describe('PageMenuItems row surface', () => {
  it('keeps the default sidebar row action set unchanged', () => {
    renderRowMenu();

    expect(itemLabels()).toEqual([
      'Add to favorites',
      'Open in new tab',
      'Open in new window',
      'Open in split view',
      'Rename',
      'Copy link',
      'Duplicate',
      'Move to…',
      'Add subpage',
      'Add database',
      'Move to trash',
    ]);
  });

  it('can omit host-redundant tab and window targets without changing other row actions', () => {
    renderRowMenu({openTab: true, openWindow: true});

    expect(itemLabels()).toEqual([
      'Add to favorites',
      'Open in split view',
      'Rename',
      'Copy link',
      'Duplicate',
      'Move to…',
      'Add subpage',
      'Add database',
      'Move to trash',
    ]);
  });
});
