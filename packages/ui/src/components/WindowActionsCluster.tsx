import {ChevronDown, Columns2, PanelRightClose, Plus, SquarePlus} from 'lucide-react';
import {useNavigation} from '@/providers';
import {HOME_PAGE_ID} from '@/lib/homePage';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {cn} from '@/lib/utils';

/**
 * Window-level actions in the nav bar: open a new page (as a tab or a window),
 * and toggle the in-window split. A new tab/window is native — a real browser
 * tab/window on the web, a macOS window-tab or standalone window on the desktop.
 * The split shows a second page inside this window.
 */
export default function WindowActionsCluster() {
  const {openInNew, splitOpen, openInSplit, closeSplit, currentPageId} = useNavigation();

  const buttonClass =
    'flex h-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:text-muted-foreground/35';

  return (
    <div className="flex items-center gap-0.5">
      {/* New-page split button: click opens a tab; the caret chooses tab/window. */}
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => openInNew(HOME_PAGE_ID, 'tab')}
          aria-label="New tab"
          title="New tab"
          className={cn(buttonClass, 'w-6 rounded-r-none')}
        >
          <Plus className="h-4 w-4" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="New tab or window"
              title="New tab or window"
              className={cn(buttonClass, 'w-4 rounded-l-none')}
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => openInNew(HOME_PAGE_ID, 'tab')}>
              <Plus className="mr-2 h-4 w-4" />
              New tab
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openInNew(HOME_PAGE_ID, 'window')}>
              <SquarePlus className="mr-2 h-4 w-4" />
              New window
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <button
        type="button"
        onClick={() => (splitOpen ? closeSplit() : currentPageId && openInSplit(currentPageId))}
        disabled={!splitOpen && !currentPageId}
        aria-label={splitOpen ? 'Close split' : 'Split view'}
        title={splitOpen ? 'Close split' : 'Split view'}
        className={cn(buttonClass, 'w-7', splitOpen && 'bg-accent text-foreground')}
      >
        {splitOpen ? <PanelRightClose className="h-4 w-4" /> : <Columns2 className="h-4 w-4" />}
      </button>
    </div>
  );
}
