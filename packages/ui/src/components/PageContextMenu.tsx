import React, {useCallback} from 'react';
import {
  AppWindow,
  Columns2,
  CopyPlus,
  ExternalLink,
  FilePlus2,
  Link2,
  Pencil,
  Star,
  StarOff,
  Table2,
  Trash2,
} from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {useConfirm, useNavigation, usePreferences, useTranslation} from '@/providers';
import {copyPageLink, requestRenamePage} from '@/lib/pageActions';
import {isFavorite, toggleFavorite} from '@/lib/favorites';

/**
 * The right-click actions for a page, shared by the sidebar tree rows and the
 * page body. Rendered inside a {@link ContextMenuContent}.
 */
export function PageMenuItems({pageId}: {pageId: string}) {
  const {openInNew, openInSplit, createSubpage, duplicatePage, deletePage, selectPage} = useNavigation();
  const confirm = useConfirm();
  const {preferences} = usePreferences();
  const {t} = useTranslation();

  const onDelete = useCallback(async () => {
    // Skip the confirm when the user has turned it off in General settings.
    if (preferences.general.confirmOnTrash) {
      const ok = await confirm({
        title: t('confirm.trashTitle'),
        description: t('confirm.trashBody'),
        confirmText: t('confirm.trashConfirm'),
        destructive: true,
      });
      if (!ok) return;
    }
    void deletePage(pageId);
  }, [confirm, deletePage, pageId, preferences.general.confirmOnTrash, t]);

  // "Rename" focuses the page's title field: switch to the page first, then ask
  // its (possibly freshly mounted) editor to focus the title for editing.
  const onRename = useCallback(() => {
    selectPage(pageId);
    setTimeout(() => requestRenamePage(pageId), 50);
  }, [pageId, selectPage]);

  // Read at render — the menu re-mounts each time it opens, so this is current.
  const fav = isFavorite(pageId);

  return (
    <>
      <ContextMenuItem onSelect={() => toggleFavorite(pageId)}>
        {fav ? <StarOff className="mr-2 h-4 w-4" /> : <Star className="mr-2 h-4 w-4" />}
        {fav ? t('menu.unfavorite') : t('menu.favorite')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => openInNew(pageId, 'tab')}>
        <ExternalLink className="mr-2 h-4 w-4" />
        {t('menu.openTab')}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => openInNew(pageId, 'window')}>
        <AppWindow className="mr-2 h-4 w-4" />
        {t('menu.openWindow')}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => openInSplit(pageId)}>
        <Columns2 className="mr-2 h-4 w-4" />
        {t('menu.openSplit')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={onRename}>
        <Pencil className="mr-2 h-4 w-4" />
        {t('menu.rename')}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void copyPageLink(pageId)}>
        <Link2 className="mr-2 h-4 w-4" />
        {t('menu.copyLink')}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void duplicatePage(pageId)}>
        <CopyPlus className="mr-2 h-4 w-4" />
        {t('menu.duplicate')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => void createSubpage(pageId, 'page').then(selectPage)}>
        <FilePlus2 className="mr-2 h-4 w-4" />
        {t('menu.addSubpage')}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void createSubpage(pageId, 'database').then(selectPage)}>
        <Table2 className="mr-2 h-4 w-4" />
        {t('menu.addDatabase')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => void onDelete()} className="text-destructive focus:text-destructive">
        <Trash2 className="mr-2 h-4 w-4" />
        {t('menu.moveToTrash')}
      </ContextMenuItem>
    </>
  );
}

/**
 * Wrap the page body so right-clicking it opens the page's context menu. (The
 * block editor supplies its own per-block actions through the gutter handle; the
 * sidebar tree wires {@link PageMenuItems} in directly.)
 */
export function PageContextMenu({pageId, children}: {pageId: string; children: React.ReactNode}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="contents">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <PageMenuItems pageId={pageId} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
