import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import type {PageMeta} from '@book.dev/sdk';
import BreadcrumbCluster from '@/components/BreadcrumbCluster';
import HomeScreen from '@/screens/HomeScreen';
import {LinksPaneBody} from '@/components/links/LinksPaneBody';
import {setLinksTarget} from '@/lib/linksPane';

const mocks = vi.hoisted(() => ({
  pageAction: vi.fn(),
  selectPage: vi.fn(),
  selectPageAtBlock: vi.fn(),
  selectPageInPane: vi.fn(),
  pages: [] as PageMeta[],
  currentPageId: null as string | null,
  panes: [] as Array<{pageId: string}>,
  listBacklinks: vi.fn(),
  getPage: vi.fn(),
  aiSearch: vi.fn(),
  subscribePages: vi.fn(() => () => {}),
}));

vi.mock('@/components/PageContextMenu', async () => {
  const {ContextMenuItem} = await import('@/components/ui/context-menu');
  return {
    PageMenuItems: ({
      pageId,
      surface,
      menu,
    }: {
      pageId: string;
      surface: 'row' | 'page';
      menu: 'context' | 'dropdown';
    }) => (
      <ContextMenuItem onSelect={() => mocks.pageAction(pageId, surface, menu)}>
        Open in new tab
      </ContextMenuItem>
    ),
  };
});

vi.mock('@/providers', async () => {
  const {t} = await import('@/i18n');
  return {
    useLibrary: () => ({library: {name: 'Test library', icon: '📚'}}),
    useNavigation: () => ({
      pages: mocks.pages,
      panes: mocks.panes,
      currentPageId: mocks.currentPageId,
      pageLabel: (id: string) => mocks.pages.find((page) => page.id === id)?.name ?? id,
      selectPage: mocks.selectPage,
      selectPageAtBlock: mocks.selectPageAtBlock,
      selectPageInPane: mocks.selectPageInPane,
      createPage: vi.fn(),
      createDatabasePage: vi.fn(),
      reload: vi.fn(),
      closeSplit: vi.fn(),
      openInSplit: vi.fn(),
    }),
    useTranslation: () => ({t, locale: 'en'}),
    useHud: () => ({setHud: vi.fn()}),
    usePreferences: () => ({preferences: {profile: {displayName: '', name: ''}}}),
  };
});

vi.mock('@/data', () => ({
  useData: () => ({
    listBacklinks: mocks.listBacklinks,
    getPage: mocks.getPage,
    aiSearch: mocks.aiSearch,
    subscribePages: mocks.subscribePages,
    listTrash: vi.fn().mockResolvedValue([]),
  }),
}));

const page = (id: string, name: string, parentId: string | null = null): PageMeta => ({
  id,
  name,
  icon: null,
  hostedDatabaseId: null,
  parentId,
  deletedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  setLinksTarget(null);
  mocks.pageAction.mockClear();
  mocks.selectPage.mockClear();
  mocks.selectPageAtBlock.mockClear();
  mocks.selectPageInPane.mockClear();
  mocks.pages = [];
  mocks.currentPageId = null;
  mocks.panes = [];
  mocks.listBacklinks.mockReset();
  mocks.getPage.mockReset();
  mocks.aiSearch.mockReset();
});

describe('page entry-point context menus', () => {
  it('opens a breadcrumb page menu without breaking crumb navigation or truncation', () => {
    mocks.pages = [page('parent', 'Parent'), page('current', 'Current', 'parent')];
    mocks.currentPageId = 'current';
    mocks.panes = [{pageId: 'current'}];
    render(<BreadcrumbCluster />);

    const crumb = screen.getByTitle('Current');
    expect(crumb.querySelector('.truncate')).toBeTruthy();
    fireEvent.click(crumb);
    expect(mocks.selectPageInPane).toHaveBeenCalledWith('current', 'primary');

    fireEvent.contextMenu(crumb);
    fireEvent.click(screen.getByText('Open in new tab'));
    expect(mocks.pageAction).toHaveBeenCalledWith('current', 'row', 'context');
  });

  it('opens the shared page-row menu from a Home tile', () => {
    mocks.pages = [page('tile', 'Home tile')];
    localStorage.setItem('openbook.recents', JSON.stringify(['tile']));
    render(<HomeScreen />);

    const tile = screen.getAllByText('Home tile')[0].closest('button')!;
    fireEvent.contextMenu(tile);
    fireEvent.click(screen.getByText('Open in new tab'));
    expect(mocks.pageAction).toHaveBeenCalledWith('tile', 'row', 'context');
  });

  it('opens the shared page-row menu from backlink and mention rows', async () => {
    mocks.pages = [page('target', 'Target')];
    mocks.listBacklinks.mockResolvedValue([page('backlink', 'Backlink page')]);
    mocks.getPage.mockResolvedValue({data: {editorjs: {blocks: []}, values: [], names: []}});
    mocks.aiSearch.mockResolvedValue({
      results: [{pageId: 'mention', title: 'Mention page', snippet: 'A reference to Target', blockId: 'block-1'}],
    });
    setLinksTarget('target');
    render(<LinksPaneBody />);

    const backlink = await screen.findByTitle('Backlink page');
    fireEvent.contextMenu(backlink);
    fireEvent.click(screen.getByText('Open in new tab'));
    expect(mocks.pageAction).toHaveBeenLastCalledWith('backlink', 'row', 'context');

    const mention = await screen.findByTitle('Mention page');
    fireEvent.contextMenu(mention);
    fireEvent.click(screen.getByText('Open in new tab'));
    expect(mocks.pageAction).toHaveBeenLastCalledWith('mention', 'row', 'context');
  });
});
