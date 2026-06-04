import React, {useCallback, useRef, useState} from 'react';
import {ScrollArea} from '@/components/ui/scroll-area';
import {ConnectedPageDocument} from '@/screens';
import {useNavigation, type PaneState} from '@/providers';
import {activeTab, tabPageId} from '@/providers/tabsModel';
import {cn} from '@/lib/utils';
import TabStrip from '@/components/TabStrip';
import {X} from 'lucide-react';

/** One pane: its tab strip over the scrollable document of its active tab. */
const Pane: React.FC<{pane: PaneState; focused: boolean; split: boolean; style?: React.CSSProperties}> = ({
  pane,
  focused,
  split,
  style,
}) => {
  const {focusPane, closePane} = useNavigation();
  const pageId = tabPageId(activeTab(pane));

  return (
    <section
      onMouseDownCapture={() => focusPane(pane.id)}
      style={style}
      className={cn(
        'relative flex min-h-0 min-w-0 flex-col',
        split && focused && 'ring-1 ring-inset ring-primary/15',
      )}
    >
      <div className="flex items-stretch">
        <div className="min-w-0 flex-1">
          <TabStrip pane={pane} />
        </div>
        {split && (
          <button
            onClick={() => closePane(pane.id)}
            className="flex shrink-0 items-center border-b border-border px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close split pane"
            title="Close split"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ConnectedPageDocument key={pageId} pageId={pageId} />
      </ScrollArea>
    </section>
  );
};

/**
 * The document workspace: one pane, or two side-by-side with a draggable
 * divider when the user opens a split. Replaces the single-document route in
 * the desktop and web shells, so both get tabs and the split pane for free.
 */
export default function DocumentArea() {
  const {panes, focusedPaneId, loading} = useNavigation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Fraction of width given to the left pane when split (clamped 20–80%).
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
          <Pane
            pane={pane}
            focused={pane.id === focusedPaneId}
            split={split}
            style={split && index === 0 ? {flex: `0 0 ${ratio * 100}%`} : {flex: '1 1 0%'}}
          />
        </React.Fragment>
      ))}
    </div>
  );
}
