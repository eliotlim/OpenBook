import {useEffect, useMemo, useState} from 'react';
import type {PageMeta} from '@open-book/sdk';
import {Tree, TreeDataItem} from '@/components/ui/tree';
import {IconButton} from '@/components/ui/icon-button';
import {PageMenuItems} from '@/components/PageContextMenu';
import {useNavigation, useTranslation} from '@/providers';
import {readPageIcon, subscribePageIcon} from '@/lib/pageIcon';
import {planTreeMove, type DropWhere} from '@/lib/treeMove';
import {MoreHorizontal, Plus, Table2} from 'lucide-react';
import {t} from '@/i18n';

const displayName = (name: string | null): string =>
  name && name.trim().length > 0 ? name : t('common.untitled');

/**
 * Build the sidebar tree from the flat page list: each page becomes a node, and
 * a page with a `parentId` is attached under that parent (recursively). Pages
 * whose parent isn't in the list (e.g. it was deleted) surface at the top level.
 * The page list arrives in manual sidebar order (server `position`), so each
 * parent's children come out in the order the user arranged them.
 *
 * A node's icon mirrors the page's own icon: its chosen emoji, or the default
 * page icon (📄) when none is set — so the sidebar matches the page header.
 */
export function buildTree(pages: PageMeta[]): TreeDataItem[] {
  const nodes = new Map<string, TreeDataItem>();
  for (const page of pages) {
    nodes.set(page.id, {
      id: page.id,
      name: displayName(page.name),
      icon: readPageIcon(page.id),
    });
  }
  const roots: TreeDataItem[] = [];
  for (const page of pages) {
    const node = nodes.get(page.id)!;
    const parent = page.parentId ? nodes.get(page.parentId) : undefined;
    if (parent) (parent.children ??= []).push(node);
    else roots.push(node);
  }
  return roots;
}

export default function WorkspaceNavigationTree() {
  const {pages, currentPageId, selectPage, createPage, createDatabasePage, createSubpage, movePage} = useNavigation();
  const {t} = useTranslation();

  // Icons live in localStorage; re-render the tree when one changes so a freshly
  // picked emoji shows in the sidebar without a reload.
  const [iconVersion, setIconVersion] = useState(0);
  useEffect(() => subscribePageIcon(() => setIconVersion((v) => v + 1)), []);

  const data = useMemo(() => buildTree(pages), [pages, iconVersion]);

  const onMove = (draggedId: string, targetId: string, where: DropWhere) => {
    const plan = planTreeMove(pages, draggedId, targetId, where);
    if (plan) void movePage(draggedId, plan.parentId, plan.orderedIds);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pb-1 pt-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">{t('nav.pages')}</span>
        <div className="flex items-center gap-0.5">
          <IconButton size="sm" onClick={() => void createDatabasePage()} aria-label={t('nav.newDatabase')} title={t('nav.newDatabase')}>
            <Table2 className="h-4 w-4" />
          </IconButton>
          <IconButton size="sm" onClick={() => void createPage()} aria-label={t('nav.newPage')} title={t('nav.newPage')}>
            <Plus className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
      <Tree
        data={data}
        className="w-full flex-1 border-0"
        selectedItemId={currentPageId ?? undefined}
        onSelectChange={(item) => item && selectPage(item.id)}
        renderItemContextMenu={(item) => <PageMenuItems pageId={item.id} />}
        renderRowActions={(item, {openMenu}) => (
          <>
            <IconButton
              size="sm"
              className="h-5 w-5 rounded p-0.5"
              aria-label={t('menu.addSubpage')}
              title={t('menu.addSubpage')}
              onClick={() => void createSubpage(item.id, 'page').then(selectPage)}
            >
              <Plus className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton
              size="sm"
              className="h-5 w-5 rounded p-0.5"
              aria-label={t('nav.more')}
              title={t('nav.more')}
              onClick={openMenu}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </IconButton>
          </>
        )}
        onMove={onMove}
      />
    </div>
  );
}
