import React, {useCallback, useRef, useState} from 'react';
import {X} from 'lucide-react';
import {ScrollArea} from '@/components/ui/scroll-area';
import {ConnectedPageDocument} from '@/screens';
import {useNavigation, type Pane as PaneModel} from '@/providers';
import {cn} from '@/lib/utils';

/** One pane: an optional close header (when split) over the scrollable document. */
const Pane: React.FC<{pane: PaneModel; focused: boolean; split: boolean}> = ({pane, focused, split}) => {
  const {focusPane, closePane} = useNavigation();

  return (
    <section
      onMouseDownCapture={() => focusPane(pane.id)}
      className={cn(
        'relative flex min-h-0 min-w-0 flex-1 flex-col',
        split && focused && 'ring-1 ring-inset ring-primary/15',
      )}
    >
      {split && (
        <div className="flex h-7 items-center justify-end border-b border-border bg-background/60 px-1">
          <button
            onClick={() => closePane(pane.id)}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close pane"
            title="Close pane"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <ConnectedPageDocument key={pane.pageId} pageId={pane.pageId} />
      </ScrollArea>
    </section>
  );
};

/**
 * The document workspace for this window: the primary page, or two pages
 * side-by-side with a draggable divider when split. Tabs themselves are native
 * (browser tabs on web, macOS window-tabs on desktop) — each window runs one of
 * these — so there is no in-app tab strip here, only the split.
 */
export default function DocumentArea() {
  const {panes, focusedPaneId, loading} = useNavigation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Fraction of width given to the primary pane when split (clamped 20–80%).
  const [ratio, setRatio] = useState(0.5);
  const draggingRef = useRef(false);

  const onDividerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const next = (ev.clientX - rect.left) / rect.width;
      setRatio(Math.min(0.8, Math.max(0.2, next)));
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  if (loading || panes.length === 0) return null;

  const split = panes.length >= 2;

  return (
    <div ref={containerRef} className="flex h-full w-full min-h-0">
      {panes.map((pane, index) => (
        <React.Fragment key={pane.id}>
          {index > 0 && (
            <div
              onPointerDown={onDividerDown}
              className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/30"
              role="separator"
              aria-orientation="vertical"
            />
          )}
          <div
            className="flex min-w-0 flex-col"
            style={split && index === 0 ? {flex: `0 0 ${ratio * 100}%`} : {flex: '1 1 0%'}}
          >
            <Pane pane={pane} focused={pane.id === focusedPaneId} split={split} />
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}
