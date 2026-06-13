import React, {useEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import {Settings2, PanelRight} from 'lucide-react';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {registerKitConfig} from './kitConfig';
import {
  closeKitPanel,
  getKitPanel,
  getKitPanelHost,
  openKitPanel,
  subscribeKitPanel,
  subscribeKitPanelHost,
} from './kitPanel';

/**
 * The one settings affordance every interactive block shares: a gear at the
 * block's top-right (hidden until hover/focus), opening a settings **popover**
 * that can **expand into the side pane** for roomier editing. The gutter
 * context menu's "Configure" item opens the same popover (via the `kitConfig`
 * bridge). One component so inputs, charts and cards all behave alike — no more
 * per-block show/hide panels.
 */
export const KitSettings: React.FC<{
  /** Stable block id — drives the gutter bridge and the expand portal target. */
  blockId: string;
  /** Heading for the popover / side panel. */
  title: string;
  /** The configuration fields. */
  children: React.ReactNode;
}> = ({blockId, title, children}) => {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(getKitPanelHost());
  const [expanded, setExpanded] = useState(() => getKitPanel()?.blockId === blockId);

  // Gutter "Configure" opens this popover (deferred a tick so the closing
  // context menu doesn't immediately steal focus back).
  useEffect(() => registerKitConfig(blockId, () => setTimeout(() => setOpen(true), 0)), [blockId]);

  // Track the side-pane host + whether THIS block owns the expanded panel.
  useEffect(() => subscribeKitPanelHost(() => setHost(getKitPanelHost())), []);
  useEffect(() => subscribeKitPanel(() => setExpanded(getKitPanel()?.blockId === blockId)), [blockId]);

  // If this block unmounts while expanded, drop the side pane so it never shows
  // an orphaned, empty config.
  useEffect(
    () => () => {
      if (getKitPanel()?.blockId === blockId) closeKitPanel();
    },
    [blockId],
  );

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="obe-kit-gear" aria-label="Configure block" title="Configure">
            <Settings2 className="h-4 w-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-semibold">{title || 'Settings'}</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Expand to side panel"
              onClick={() => {
                setOpen(false);
                openKitPanel(blockId, title);
              }}
            >
              <PanelRight className="h-3.5 w-3.5" /> Expand
            </button>
          </div>
          {/* Closed once expanded, so the fields live in exactly one place. */}
          {!expanded && children}
        </PopoverContent>
      </Popover>
      {expanded && host && createPortal(children, host)}
    </>
  );
};

export default KitSettings;
