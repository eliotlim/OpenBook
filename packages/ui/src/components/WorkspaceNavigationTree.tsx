import {useEffect, useMemo, useState} from 'react';
import type {PageMeta} from '@open-book/sdk';
import {Tree, TreeDataItem} from '@/components/ui/tree';
import {IconButton} from '@/components/ui/icon-button';
import {PageMenuItems} from '@/components/PageContextMenu';
import {useNavigation} from '@/providers';
import {readStoredPageIcon, subscribePageIcon} from '@/lib/pageIcon';
import {planTreeMove, type DropWhere} from '@/lib/treeMove';
import {Database, FileText, Folder, Plus, Table2, Workflow} from 'lucide-react';

const displayName = (name: string | null): string =>
  name && name.trim().length > 0 ? name : 'Untitled';

/**
 * Build the sidebar tree from the flat page list: each page becomes a node, and
 * a page with a `parentId` is attached under that parent (recursively). Pages
 * whose parent isn't in the list (e.g. it was deleted) surface at the top level.
 * The page list arrives in manual sidebar order (server `position`), so each
 * parent's children come out in the order the user arranged them.
 *
 * A node's icon is the page's chosen emoji when it has one, otherwise a generic
 * database/file glyph.
 */
export function buildTree(pages: PageMeta[]): TreeDataItem[] {
  const nodes = new Map<string, TreeDataItem>();
  for (const page of pages) {
    nodes.set(page.id, {
      id: page.id,
      name: displayName(page.name),
      icon: readStoredPageIcon(page.id) ?? (page.hostedDatabaseId ? Database : FileText),
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
  const {pages, currentPageId, selectPage, createPage, createDatabasePage, movePage} = useNavigation();

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
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">Pages</span>
        <div className="flex items-center gap-0.5">
          <IconButton size="sm" onClick={() => void createDatabasePage()} aria-label="New database" title="New database">
            <Table2 className="h-4 w-4" />
          </IconButton>
          <IconButton size="sm" onClick={() => void createPage()} aria-label="New page" title="New page">
            <Plus className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
      <Tree
        data={data}
        className="w-full flex-1 border-0"
        selectedItemId={currentPageId ?? undefined}
        onSelectChange={(item) => item && selectPage(item.id)}
        folderIcon={Folder}
        itemIcon={Workflow}
        renderItemContextMenu={(item) => <PageMenuItems pageId={item.id} />}
        onMove={onMove}
      />
    </div>
  );
}
