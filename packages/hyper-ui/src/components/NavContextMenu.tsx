import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import {Button} from '@/components/ui/button';
import {DotsVerticalIcon} from '@radix-ui/react-icons';
import {useHud} from "@/providers";
import {Switch} from "@/components/ui/switch";

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
      <DropdownMenuContent className="w-56">
        <DropdownMenuLabel>View Options</DropdownMenuLabel>
        <DropdownMenuLabel
          className="flex flex-row justify-between"
        >
          Full Width
          <DropdownMenuShortcut>
            <Switch
              checked={hud.viewMode.fullWidth}
              onCheckedChange={e => setHud({...hud, viewMode: {...hud.viewMode, fullWidth: e.valueOf()}})}
            />
          </DropdownMenuShortcut>
        </DropdownMenuLabel>
        <DropdownMenuSeparator/>
        <DropdownMenuItem>Favourite</DropdownMenuItem>
        <DropdownMenuItem>Settings</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
