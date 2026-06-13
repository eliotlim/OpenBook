import {useCallback, useEffect, useRef, useState} from 'react';
import {Maximize2, PanelRightClose} from 'lucide-react';
import {ScrollArea} from '@/components/ui/scroll-area';
import {IconButton} from '@/components/ui/icon-button';
import PageActionsCluster from '@/components/PageActionsCluster';
import {ConnectedPageDocument, DataflowView, HomeScreen} from '@/screens';
import {CONFIG_PANE_ID, FLOW_PANE_ID, HOME_PAGE_ID} from '@/lib/homePage';
import {closeKitPanel, getKitPanel, setKitPanelHost, subscribeKitPanel} from '@/blockeditor/kit/kitPanel';
import {useNavigation} from '@/providers';
import {cn} from '@/lib/utils';

/**
 * The expanded block-settings pane: a host element the interactive block's live
 * config fields portal into (see `blockeditor/kit/kitPanel.ts`). Publishing the
 * host on mount and clearing the panel on unmount keeps the bridge in step with
 * what the side pane is actually showing.
 */
function KitConfigPaneBody() {
  const [panel, setPanel] = useState(getKitPanel());
  useEffect(() => subscribeKitPanel(() => setPanel(getKitPanel())), []);
  const hostRef = useCallback((el: HTMLDivElement | null) => setKitPanelHost(el), []);
  useEffect(
    () => () => {
      setKitPanelHost(null);
      closeKitPanel({keepPane: true}); // the pane is already going away
    },
    [],
  );
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-4 py-2.5">
        <p className="truncate text-sm font-semibold">{panel?.title || 'Settings'}</p>
        <p className="text-xs text-muted-foreground">Block settings</p>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        {!panel && <p className="text-xs text-muted-foreground">Open a block’s settings to edit it here.</p>}
      </div>
    </div>
  );
}

/**
 * The split view's secondary page: a full-height pane docked at the window's
 * right edge (alongside the assistant panel), sliding in like a side peek
 * rather than carving the document area in two. Its left edge drags to
 * resize; the header closes it. The primary document keeps the NavBar and
 * the full editing surface.
 */
export function SplitPane() {
  const {panes, focusedPaneId, splitOpen, focusPane, closeSplit, closePane} = useNavigation();
  // Pane width in px; the drag clamps it between a readable minimum and most
  // of the window, so the primary document never collapses entirely.
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 480 : Math.min(560, Math.round(window.innerWidth * 0.42))));
  const dragRef = useRef<{startX: number; startWidth: number} | null>(null);

  // Pointer capture keeps every move routed to the handle for the whole drag —
  // window-level listeners lose events to the documents on either side.
  const onDividerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = {startX: e.clientX, startWidth: width};
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width],
  );

  const onDividerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = drag.startWidth + (drag.startX - e.clientX);
    setWidth(Math.min(Math.round(window.innerWidth * 0.7), Math.max(320, Math.round(next))));
  }, []);

  const onDividerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.style.removeProperty('cursor');
    document.body.style.removeProperty('user-select');
  }, []);

  if (!splitOpen || panes.length < 2) return null;
  const pane = panes[1];
  const focused = pane.id === focusedPaneId;
  const isFlow = pane.pageId === FLOW_PANE_ID;
  const isConfig = pane.pageId === CONFIG_PANE_ID;
  const isPage = !isFlow && !isConfig; // a real document — gets make-main + the actions cluster

  return (
    <aside
      data-split-pane
      aria-label="Split view"
      style={{width}}
      onMouseDownCapture={() => focusPane(pane.id)}
      className={cn(
        'relative flex shrink-0 flex-col border-l border-border bg-background',
        'animate-in fade-in slide-in-from-right-4 duration-200 print:hidden',
        focused && 'ring-1 ring-inset ring-primary/15',
      )}
    >
      {/* The drag handle: a slim hit area straddling the left border. */}
      <div
        onPointerDown={onDividerDown}
        onPointerMove={onDividerMove}
        onPointerUp={onDividerUp}
        onPointerCancel={onDividerUp}
        role="separator"
        aria-orientation="vertical"
        className="absolute inset-y-0 -left-0.5 z-10 w-1.5 cursor-col-resize transition-colors hover:bg-primary/30"
      />
      {/* The split pane owns its page's chrome: hide / expand on the left, and
          the page-actions cluster ("…" menu + status/copy/star) on the right. */}
      <div className="flex h-9 shrink-0 items-center justify-between gap-1 border-b border-border px-1.5">
        <div className="flex items-center gap-0.5">
          <IconButton size="sm" onClick={() => closeSplit()} aria-label="Hide split pane" title="Hide split pane">
            <PanelRightClose className="h-3.5 w-3.5" />
          </IconButton>
          {isPage && (
            <IconButton
              size="sm"
              onClick={() => closePane('primary')}
              aria-label="Make this the main pane"
              title="Make this the main pane"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </IconButton>
          )}
        </div>
        {isPage && <PageActionsCluster pageId={pane.pageId} />}
      </div>
      {isFlow ? (
        // react-flow owns its own pan/zoom viewport — no ScrollArea around it.
        <div className="min-h-0 flex-1">
          <DataflowView />
        </div>
      ) : isConfig ? (
        <div className="min-h-0 flex-1">
          <KitConfigPaneBody />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          {pane.pageId === HOME_PAGE_ID ? <HomeScreen /> : <ConnectedPageDocument key={pane.pageId} pageId={pane.pageId} />}
        </ScrollArea>
      )}
    </aside>
  );
}

export default SplitPane;
