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
import {AppWindow, ExternalLink} from 'lucide-react';
import {useHud, useNavigation} from '@/providers';
import {Switch} from '@/components/ui/switch';

export default function NavContextMenu() {
  const {hud, setHud} = useHud();
  const {openInNew, currentPageId} = useNavigation();

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
        <DropdownMenuItem
          disabled={!currentPageId}
          onClick={() => currentPageId && openInNew(currentPageId, 'tab')}
        >
          <ExternalLink className="mr-2 h-4 w-4" />
          Open in new tab
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!currentPageId}
          onClick={() => currentPageId && openInNew(currentPageId, 'window')}
        >
          <AppWindow className="mr-2 h-4 w-4" />
          Open in new window
        </DropdownMenuItem>
        <DropdownMenuItem>Favourite</DropdownMenuItem>
        <DropdownMenuItem>Settings</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
