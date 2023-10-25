import {
  DropdownMenu, DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import {Button} from '@/components/ui/button';
import {DotsVerticalIcon} from '@radix-ui/react-icons';
import {useHud} from "@/providers";

export default function NavContextMenu() {
  const {hud, setHud} = useHud();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="px-3 py-1"
        >
          <DotsVerticalIcon className="h-4 w-4"/>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>View Options</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={hud.viewMode.fullWidth}
          onCheckedChange={e => setHud({...hud, viewMode: {...hud.viewMode, fullWidth: e.valueOf()}})}
        >
          Full Width
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator/>
        <DropdownMenuItem>Favourite</DropdownMenuItem>
        <DropdownMenuItem>Settings</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
