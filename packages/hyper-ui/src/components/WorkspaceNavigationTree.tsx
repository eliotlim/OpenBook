import {useWorkspace} from "@/providers/WorkspaceProvider";
import {Tree} from "@/components/Tree";
import {cn} from "@/lib/utils";
import {useHud} from "@/providers";

export default function WorkspaceNavigationTree() {
  const {hud} = useHud();
  const {workspace} = useWorkspace();

  const data = [
    {id: "1", name: "Unread"},
    {id: "2", name: "Threads"},
    {
      id: "3",
      name: "Chat Rooms",
      children: [
        {id: "c1", name: "General"},
        {id: "c2", name: "Random"},
        {id: "c3", name: "Open Source Projects"},
      ],
    },
    {
      id: "4",
      name: "Direct Messages",
      children: [
        {
          id: "d1",
          name: "Alice",
          children: [
            {id: "d11", name: "Alice2"},
            {id: "d12", name: "Bob2"},
            {id: "d13", name: "Charlie2"},
          ],
        },
        {id: "d2", name: "Bob"},
        {id: "d3", name: "Charlie"},
      ],
    },
    {
      id: "5",
      name: "Direct Messages",
      children: [
        {
          id: "e1",
          name: "Alice",
          children: [
            {id: "e11", name: "Alice2"},
            {id: "e12", name: "Bob2"},
            {id: "e13", name: "Charlie2"},
          ],
        },
        {id: "e2", name: "Bob"},
        {id: "e3", name: "Charlie"},
      ],
    },
    {
      id: "6",
      name: "Direct Messages",
      children: [
        {
          id: "f1",
          name: "Alice",
          children: [
            {id: "f11", name: "Alice2"},
            {id: "f12", name: "Bob2"},
            {id: "f13", name: "Charlie2"},
          ],
        },
        {id: "f2", name: "Bob"},
        {id: "f3", name: "Charlie"},
      ],
    },
  ];

  return (
    <>
      <Tree
        data={data}
        className={cn("w-full border-0", hud.sideNav.docked ? `h-[calc(100vh-12rem)]` : `h-[calc(100vh-20rem)]`)}
        initialSlelectedItemId="f12"
        // onSelectChange={(item) => setContent(item?.name ?? "")}
        // folderIcon={Folder}
        // itemIcon={Workflow}
      />
    </>
  );
}