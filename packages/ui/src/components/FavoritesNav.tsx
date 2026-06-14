import {useEffect, useMemo, useState} from 'react';
import type {PageMeta} from '@open-book/sdk';
import {Star} from 'lucide-react';
import {ContextMenu, ContextMenuContent, ContextMenuTrigger} from '@/components/ui/context-menu';
import {IconButton} from '@/components/ui/icon-button';
import {PageMenuItems} from '@/components/PageContextMenu';
import {SidebarSection} from '@/components/SidebarSections';
import {useNavigation, useTranslation} from '@/providers';
import {readPageIcon, subscribePageIcon} from '@/lib/pageIcon';
import {readFavorites, subscribeFavorites, toggleFavorite} from '@/lib/favorites';
import {SIDEBAR_ACTIVE, SIDEBAR_HOVER} from '@/lib/sidebarStyles';
import {cn} from '@/lib/utils';
import {t} from '@/i18n';

const displayName = (name: string | null): string =>
  name && name.trim().length > 0 ? name : t('common.untitled');

/**
 * The sidebar "Favourites" section: pinned pages, in pin order, shown above the
 * page tree. Renders nothing when empty. Rows mirror the tree row styling but
 * are intentionally not `role=treeitem` (they're a separate, flat list) so the
 * page tree stays the sole tree in the sidebar. A favourited page that's since
 * been deleted simply drops out (we only show ids still in the page list).
 */
export default function FavoritesNav() {
  const {pages, currentPageId, selectPageInPane} = useNavigation();
  const {t} = useTranslation();

  // Favourites + icons live in localStorage, which doesn't notify React; bump a
  // version on either change so the section re-renders.
  const [version, setVersion] = useState(0);
  useEffect(() => subscribeFavorites(() => setVersion((v) => v + 1)), []);
  useEffect(() => subscribePageIcon(() => setVersion((v) => v + 1)), []);

  const items = useMemo<PageMeta[]>(() => {
    const byId = new Map(pages.map((p) => [p.id, p] as const));
    // `version` participates so a (un)favourite re-derives the list.
    void version;
    return readFavorites()
      .map((id) => byId.get(id))
      .filter((p): p is PageMeta => !!p);
  }, [pages, version]);

  if (items.length === 0) return null;

  return (
    <SidebarSection id="favorites" label={t('nav.favorites')}>
      <div className="flex flex-col">
        {items.map((page) => {
          const selected = page.id === currentPageId;
          return (
            <ContextMenu key={page.id}>
              <ContextMenuTrigger asChild>
                <div
                  onClick={() => selectPageInPane(page.id, 'primary')}
                  className={cn(
                    'group/fav mx-1 flex cursor-pointer items-center rounded-md py-1 pl-2 pr-1.5 text-sm text-foreground/75 transition-colors',
                    SIDEBAR_HOVER,
                    selected && cn(SIDEBAR_ACTIVE, 'font-medium'),
                  )}
                >
                  <span className="mr-2 h-4 w-4 shrink-0 text-center text-xs leading-4" aria-hidden="true">
                    {readPageIcon(page.id)}
                  </span>
                  <span className="grow truncate">{displayName(page.name)}</span>
                  <span
                    className="ml-1 flex shrink-0 items-center opacity-0 transition-opacity group-hover/fav:opacity-100 focus-within:opacity-100"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <IconButton
                      size="sm"
                      className="h-5 w-5 rounded p-0.5"
                      aria-label={t('menu.unfavorite')}
                      title={t('menu.unfavorite')}
                      onClick={() => toggleFavorite(page.id)}
                    >
                      <Star className="h-3.5 w-3.5 fill-current text-amber-400" />
                    </IconButton>
                  </span>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-52">
                <PageMenuItems pageId={page.id} />
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
    </SidebarSection>
  );
}
