import {Columns2, PanelRightClose, Plus} from 'lucide-react';
import {useNavigation} from '@/providers';
import {cn} from '@/lib/utils';

/**
 * Window-level actions in the nav bar: open a new native tab, and toggle the
 * in-window split. "New tab" spawns a real browser tab (web) or a macOS
 * window-tab (desktop); the split shows a second page inside this window.
 */
export default function WindowActionsCluster() {
  const {newTab, splitOpen, openInSplit, closeSplit, currentPageId} = useNavigation();

  const buttonClass =
    'flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:text-muted-foreground/35';

  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => void newTab()}
        aria-label="New tab"
        title="New tab"
        className={buttonClass}
      >
        <Plus className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => (splitOpen ? closeSplit() : currentPageId && openInSplit(currentPageId))}
        disabled={!splitOpen && !currentPageId}
        aria-label={splitOpen ? 'Close split' : 'Split view'}
        title={splitOpen ? 'Close split' : 'Split view'}
        className={cn(buttonClass, splitOpen && 'bg-accent text-foreground')}
      >
        {splitOpen ? <PanelRightClose className="h-4 w-4" /> : <Columns2 className="h-4 w-4" />}
      </button>
    </div>
  );
}
