import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, render, screen} from '@testing-library/react';
import type {PageMeta} from '@book.dev/sdk';
import FavoritesNav from '@/components/FavoritesNav';
import {SidebarPageRow} from '@/components/SidebarSections';
import {Tree} from '@/components/ui/tree';

const mocks = vi.hoisted(() => ({
  currentPageId: 'selected',
  pages: [] as PageMeta[],
  selectPageInPane: vi.fn(),
}));

vi.mock('@/providers', () => ({
  useNavigation: () => ({
    currentPageId: mocks.currentPageId,
    pages: mocks.pages,
    selectPageInPane: mocks.selectPageInPane,
  }),
  useTranslation: () => ({t: (key: string) => (key === 'nav.favorites' ? 'Favorites' : key)}),
}));

vi.mock('@/components/PageContextMenu', () => ({PageMenuItems: () => null}));
vi.mock('use-resize-observer', () => ({default: () => ({ref: () => {}, width: 320, height: 480})}));

const page = (id: string, name: string): PageMeta => ({
  id,
  name,
  icon: null,
  hostedDatabaseId: null,
  parentId: null,
  deletedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
});

function expectPersistentSelection(row: HTMLElement): void {
  const classes = row.className.split(/\s+/);
  expect(classes).toContain('bg-primary/15');
  expect(classes).toContain('text-primary');
  expect(classes).toContain('hover:bg-primary/20');
  expect(classes).toContain('before:w-0.5');
  expect(classes).toContain('before:bg-primary');
  expect(classes).not.toContain('font-medium');
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  mocks.pages = [];
  mocks.selectPageInPane.mockClear();
});

describe('selected sidebar page rows', () => {
  it('uses a sheet-relative foreground wash for unselected row hover', () => {
    mocks.currentPageId = 'other';
    render(<SidebarPageRow page={page('unselected', 'Unselected page')} />);
    expect(screen.getByText('Unselected page').parentElement!.className.split(/\s+/)).toContain(
      'hover:bg-[hsl(var(--sheet-1-foreground)/0.06)]',
    );
    mocks.currentPageId = 'selected';
  });

  it('keeps the Favorites row strong on hover and adds a metric-free rail', () => {
    mocks.pages = [page('selected', 'Favorite page')];
    localStorage.setItem('openbook.favorites', JSON.stringify(['selected']));
    render(<FavoritesNav />);

    expectPersistentSelection(screen.getByText('Favorite page').parentElement!);
  });

  it('keeps the flat section row strong on hover and adds a metric-free rail', () => {
    render(<SidebarPageRow page={page('selected', 'Suggested page')} />);

    expectPersistentSelection(screen.getByText('Suggested page').parentElement!);
  });

  it('keeps the tree row strong on hover and adds a metric-free rail', () => {
    render(<Tree data={[{id: 'selected', name: 'Tree page'}]} selectedItemId="selected" />);

    expectPersistentSelection(screen.getByRole('treeitem'));
  });
});
