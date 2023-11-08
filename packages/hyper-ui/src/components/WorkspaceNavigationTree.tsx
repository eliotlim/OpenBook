import {NavPageRecord, useWorkspace} from "@/providers/WorkspaceProvider";
import {Tree, TreeDataItem} from "@/components/Tree";
import {cn} from "@/lib/utils";
import {useHud} from "@/providers";
import {FolderIcon} from 'lucide-react';

export function parsePageTree(pages?: NavPageRecord[]): TreeDataItem[] | undefined {
  if (!pages) return undefined;
  return pages.map(page => ({
    id: page.pageId,
    name: page.title,
    icon: FolderIcon,
    children: parsePageTree(page.subPages),
  }));
}

export default function WorkspaceNavigationTree() {
  const {hud} = useHud();
  const {workspace} = useWorkspace();

  const data = parsePageTree(workspace?.pages);

  return (
    <>
      <Tree
        data={data ?? []}
        className={cn("w-full border-0", hud.sideNav.docked ? `h-[calc(100vh-12rem)]` : `h-[calc(100vh-20rem)]`)}
        initialSlelectedItemId="f12"
        // onSelectChange={(item) => setContent(item?.name ?? "")}
        // folderIcon={Folder}
        // itemIcon={Workflow}
      />
    </>
  );
}