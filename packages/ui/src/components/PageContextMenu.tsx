import React, {useCallback} from 'react';
import {AppWindow, ExternalLink, FilePlus2, Table2, Trash2} from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {useConfirm, useNavigation} from '@/providers';

/**
 * The right-click actions for a page, shared by the sidebar tree rows and the
 * page body. Rendered inside a {@link ContextMenuContent}.
 */
export function PageMenuItems({pageId}: {pageId: string}) {
  const {openInNew, createSubpage, deletePage, selectPage} = useNavigation();
  const confirm = useConfirm();

  const onDelete = useCallback(async () => {
    const ok = await confirm({
      title: 'Move this page to the trash?',
      description: 'You can restore it later from the trash.',
      confirmText: 'Move to trash',
      destructive: true,
    });
    if (ok) void deletePage(pageId);
  }, [confirm, deletePage, pageId]);

  return (
    <>
      <ContextMenuItem onSelect={() => openInNew(pageId, 'tab')}>
        <ExternalLink className="mr-2 h-4 w-4" />
        Open in new tab
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => openInNew(pageId, 'window')}>
        <AppWindow className="mr-2 h-4 w-4" />
        Open in new window
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => void createSubpage(pageId, 'page').then(selectPage)}>
        <FilePlus2 className="mr-2 h-4 w-4" />
        Add subpage
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void createSubpage(pageId, 'database').then(selectPage)}>
        <Table2 className="mr-2 h-4 w-4" />
        Add database
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => void onDelete()} className="text-destructive focus:text-destructive">
        <Trash2 className="mr-2 h-4 w-4" />
        Move to trash
      </ContextMenuItem>
    </>
  );
}

/**
 * Wrap `children` so right-clicking them opens the page action menu. Used for
 * the page body; the sidebar tree wires {@link PageMenuItems} in directly.
 */
export function PageContextMenu({pageId, children}: {pageId: string; children: React.ReactNode}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <PageMenuItems pageId={pageId} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
