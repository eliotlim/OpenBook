import {Columns2, PanelRightClose} from 'lucide-react';
import {useNavigation} from '@/providers';
import {cn} from '@/lib/utils';

/**
 * Window-level actions in the nav bar: toggle the in-window split view. (New
 * tabs are native — a real browser tab on the web, a macOS window-tab on the
 * desktop, opened from the titlebar's "+".)
 */
export default function WindowActionsCluster() {
  const {splitOpen, openInSplit, closeSplit, currentPageId} = useNavigation();

  const buttonClass =
    'flex h-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:text-muted-foreground/35';

  return (
    <div className="flex items-center gap-0.5">
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
