import {
  DropdownMenu,
  DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {Button} from "@/components/ui/button";
import WorkspaceInfo from "@/components/WorkspaceInfo";
import {ChevronUpDownIcon} from "@heroicons/react/24/outline";

export default function WorkspaceSelectMenu (){
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="flex h-12 w-60 px-2 justify-start"
        >
          <WorkspaceInfo name={'Workspace 1'} url={'file:///~/hyper/Workspace 1'}/>
          <ChevronUpDownIcon className="w-4 h-4"/>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72 bg-sheet-2 text-sheet-2-foreground">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        <DropdownMenuSeparator/>
        <DropdownMenuItem>
          <WorkspaceInfo name={'Workspace 1'} url={'file:///~/hyper/Workspace 1'}/>
        </DropdownMenuItem>
        <DropdownMenuItem>
          <WorkspaceInfo name={'Workspace 2'} url={'https://workspace2.hyper.sh'}/>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
