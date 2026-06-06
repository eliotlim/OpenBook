import {useMemo} from 'react';
import type {PageMeta} from '@open-book/sdk';
import {Tree, TreeDataItem} from '@/components/ui/tree';
import {useNavigation} from '@/providers';
import {Database, FileText, Folder, Plus, Table2, Workflow} from 'lucide-react';

const displayName = (name: string | null): string =>
  name && name.trim().length > 0 ? name : 'Untitled';

/**
 * Build the sidebar tree from the flat page list: each page becomes a node, and
 * a page with a `parentId` is attached under that parent (recursively). Pages
 * whose parent isn't in the list (e.g. it was deleted) surface at the top level.
 */
function buildTree(pages: PageMeta[]): TreeDataItem[] {
  const nodes = new Map<string, TreeDataItem>();
  for (const page of pages) {
    nodes.set(page.id, {
      id: page.id,
      name: displayName(page.name),
      icon: page.hostedDatabaseId ? Database : FileText,
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
  const {pages, currentPageId, selectPage, createPage, createDatabasePage} = useNavigation();

  const data = useMemo(() => buildTree(pages), [pages]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pb-1 pt-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">Pages</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => void createDatabasePage()}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="New database"
            title="New database"
          >
            <Table2 className="h-4 w-4" />
          </button>
          <button
            onClick={() => void createPage()}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="New page"
            title="New page"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>
      <Tree
        key={currentPageId ?? 'none'}
        data={data}
        className="w-full flex-1 border-0"
        initialSlelectedItemId={currentPageId ?? undefined}
        onSelectChange={(item) => item && selectPage(item.id)}
        folderIcon={Folder}
        itemIcon={Workflow}
      />
    </div>
  );
}
