import {Tree, TreeDataItem} from '@/components/ui/tree';
import {useNavigation} from '@/providers';
import {FileText, Folder, Plus, Workflow} from 'lucide-react';

const displayName = (name: string | null): string =>
  name && name.trim().length > 0 ? name : 'Untitled';

export default function WorkspaceNavigationTree() {
  const {pages, currentPageId, selectPage, createPage} = useNavigation();

  const data: TreeDataItem[] = pages.map((page) => ({
    id: page.id,
    name: displayName(page.name),
    icon: FileText,
  }));

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pb-1 pt-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">Pages</span>
        <button
          onClick={() => void createPage()}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="New page"
          title="New page"
        >
          <Plus className="h-4 w-4" />
        </button>
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
