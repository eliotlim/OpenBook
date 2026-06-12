import {useCallback, useRef, useState} from 'react';
import {X} from 'lucide-react';
import {ScrollArea} from '@/components/ui/scroll-area';
import {IconButton} from '@/components/ui/icon-button';
import {ConnectedPageDocument, DataflowView, HomeScreen} from '@/screens';
import {FLOW_PANE_ID, HOME_PAGE_ID} from '@/lib/homePage';
import {useNavigation, useTranslation} from '@/providers';
import {cn} from '@/lib/utils';

/**
 * The split view's secondary page: a full-height pane docked at the window's
 * right edge (alongside the assistant panel), sliding in like a side peek
 * rather than carving the document area in two. Its left edge drags to
 * resize; the header closes it. The primary document keeps the NavBar and
 * the full editing surface.
 */
export function SplitPane() {
  const {panes, focusedPaneId, splitOpen, focusPane, closePane} = useNavigation();
  const {t} = useTranslation();
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

  return (
    <aside
      data-split-pane
      aria-label={t('command.splitView')}
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
      <div className="flex h-9 shrink-0 items-center justify-end border-b border-border px-1.5">
        <IconButton size="sm" onClick={() => closePane(pane.id)} aria-label={t('command.closeSplit')} title={t('command.closeSplit')}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      {pane.pageId === FLOW_PANE_ID ? (
        // react-flow owns its own pan/zoom viewport — no ScrollArea around it.
        <div className="min-h-0 flex-1">
          <DataflowView />
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
