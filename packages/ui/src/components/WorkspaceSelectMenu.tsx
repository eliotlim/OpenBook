import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import {Button} from '@/components/ui/button';
import WorkspaceInfo from '@/components/WorkspaceInfo';
import {ChevronUpDownIcon, PencilSquareIcon, PlusIcon} from '@heroicons/react/24/outline';
import {useWorkspace} from '@/providers';

export default function WorkspaceSelectMenu() {
  const {workspace} = useWorkspace();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="flex h-12 w-full justify-start gap-1 px-2"
        >
          <WorkspaceInfo icon={workspace?.icon} name={workspace?.name ?? 'Loading...'} url={workspace?.uri ?? ''}/>
          <ChevronUpDownIcon className="h-4 w-4 shrink-0 text-muted-foreground"/>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72 bg-sheet-2 text-sheet-2-foreground">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        <DropdownMenuSeparator/>
        <DropdownMenuItem>
          <WorkspaceInfo name={'Workspace 1'} url={'file:///~/open-book/Workspace 1'}/>
        </DropdownMenuItem>
        <DropdownMenuItem>
          <WorkspaceInfo name={'Workspace 2'} url={'https://workspace2.open.book.dev'}/>
        </DropdownMenuItem>
        <DropdownMenuSeparator/>
        <DropdownMenuItem>
          <PlusIcon className="w-4 h-4 mr-2"/>
          Add a Workspace...
        </DropdownMenuItem>
        <DropdownMenuItem>
          <PencilSquareIcon className="w-4 h-4 mr-2"/>
          Manage Workspaces
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
