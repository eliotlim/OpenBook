import {Tree, TreeDataItem} from '@/components/ui/tree';
import {cn} from '@/lib/utils';
import {useHud, useNavigation} from '@/providers';
import {Button} from '@/components/ui/button';
import {FileText, Folder, Plus, Workflow} from 'lucide-react';

const displayName = (name: string | null): string =>
  name && name.trim().length > 0 ? name : 'Untitled';

export default function WorkspaceNavigationTree() {
  const {hud} = useHud();
  const {pages, currentPageId, selectPage, createPage} = useNavigation();

  const data: TreeDataItem[] = pages.map((page) => ({
    id: page.id,
    name: displayName(page.name),
    icon: FileText,
  }));

  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="ghost"
        className="flex justify-start h-7 px-2 text-muted-foreground"
        onClick={() => void createPage()}
      >
        <Plus className="w-4 h-4 mr-2" />
        New page
      </Button>
      <Tree
        // Re-key on selection so the highlighted item tracks the current page.
        key={currentPageId ?? 'none'}
        data={data}
        className={cn('w-full border-0', hud.sideNav.docked ? 'h-[calc(100vh-14rem)]' : 'h-[calc(100vh-22rem)]')}
        initialSlelectedItemId={currentPageId ?? undefined}
        onSelectChange={(item) => item && selectPage(item.id)}
        folderIcon={Folder}
        itemIcon={Workflow}
      />
    </div>
  );
}
