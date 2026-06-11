import {ScrollArea} from '@/components/ui/scroll-area';
import {ConnectedPageDocument} from '@/screens';
import {useNavigation} from '@/providers';
import {cn} from '@/lib/utils';

/**
 * The document workspace for this window: the primary page. Tabs themselves
 * are native (browser tabs on web, macOS window-tabs on desktop) — each
 * window runs one of these. The split view's secondary page renders as a
 * full-height side pane ({@link SplitPane} in the layout), not here, so the
 * primary keeps the NavBar and full width when alone.
 */
export default function DocumentArea() {
  const {panes, focusedPaneId, splitOpen, focusPane, loading} = useNavigation();

  if (loading || panes.length === 0) return null;
  const pane = panes[0];

  return (
    <section
      onMouseDownCapture={() => focusPane(pane.id)}
      className={cn(
        'relative flex h-full min-h-0 w-full min-w-0 flex-col',
        // When split, mark where keyboard focus lives (the side pane rings too).
        splitOpen && pane.id === focusedPaneId && 'ring-1 ring-inset ring-primary/15',
      )}
    >
      <ScrollArea className="min-h-0 flex-1">
        <ConnectedPageDocument key={pane.pageId} pageId={pane.pageId} />
      </ScrollArea>
    </section>
  );
}
