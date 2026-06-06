import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import {Button} from '@/components/ui/button';
import {DotsVerticalIcon} from '@radix-ui/react-icons';
import {AppWindow, ExternalLink} from 'lucide-react';
import {useHud, useNavigation} from '@/providers';

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
        {/* A real menu item (role=menuitemcheckbox), not a Switch inside a Label:
            Radix only routes pointer/keyboard activation to its menu items, so a
            bare control nested in a label never toggled (dead on click in the
            desktop WKWebView especially). `onSelect` preventDefault keeps the
            menu open so you can see the layout change. */}
        <DropdownMenuCheckboxItem
          checked={hud.viewMode.fullWidth}
          onCheckedChange={(checked) =>
            setHud({...hud, viewMode: {...hud.viewMode, fullWidth: checked}})
          }
          onSelect={(e) => e.preventDefault()}
        >
          Full Width
        </DropdownMenuCheckboxItem>
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
