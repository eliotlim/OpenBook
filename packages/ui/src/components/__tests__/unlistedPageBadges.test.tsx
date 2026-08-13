import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, render} from '@testing-library/react';
import type {PageMeta} from '@book.dev/sdk';
import LibraryNavigationTree from '@/components/LibraryNavigationTree';
import FavoritesNav from '@/components/FavoritesNav';
import {SidebarPageRow} from '@/components/SidebarSections';
import {TooltipProvider} from '@/components/ui/tooltip';

const mocks = vi.hoisted(() => ({
  pages: [] as PageMeta[],
  selectPageInPane: vi.fn(),
}));

vi.mock('@/providers', async () => {
  const {t} = await import('@/i18n');
  return {
    useTranslation: () => ({t, locale: 'en'}),
    useHud: () => ({setHud: vi.fn()}),
    useNavigation: () => ({
      pages: mocks.pages,
      loading: false,
      currentPageId: null,
      selectPageInPane: mocks.selectPageInPane,
      createPage: vi.fn(),
      createDatabasePage: vi.fn(),
      createSubpage: vi.fn(),
      movePage: vi.fn(),
    }),
  };
});

const page = (id: string, listed: boolean): PageMeta => ({
  id,
  name: `${listed ? 'Listed' : 'Hidden'} ${id}`,
  listed,
  icon: null,
  hostedDatabaseId: null,
  parentId: null,
  deletedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  mocks.pages = [];
  mocks.selectPageInPane.mockClear();
});

describe('owner hidden-page badges (UP-3)', () => {
  it('renders the same eye-off badge in tree, sidebar-section, and favorites rows', () => {
    const hidden = page('hidden', false);
    mocks.pages = [hidden];
    localStorage.setItem('openbook.favorites', JSON.stringify([hidden.id]));

    const {container} = render(
      <TooltipProvider delayDuration={0}>
        <LibraryNavigationTree />
        <SidebarPageRow page={hidden} />
        <FavoritesNav />
      </TooltipProvider>,
    );

    const badges = container.querySelectorAll('[data-hidden-page-badge]');
    expect(badges).toHaveLength(3);
    badges.forEach((badge) => {
      expect(badge.getAttribute('aria-label')).toBe('Hidden from navigation & search');
      expect(badge.querySelector('svg')).toBeTruthy();
    });
  });

  it('does not badge listed rows', () => {
    const listed = page('listed', true);
    mocks.pages = [listed];
    localStorage.setItem('openbook.favorites', JSON.stringify([listed.id]));

    const {container} = render(
      <TooltipProvider delayDuration={0}>
        <LibraryNavigationTree />
        <SidebarPageRow page={listed} />
        <FavoritesNav />
      </TooltipProvider>,
    );

    expect(container.querySelector('[data-hidden-page-badge]')).toBeNull();
  });
});
