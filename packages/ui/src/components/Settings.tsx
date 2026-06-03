import React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {DialogOverlay, DialogPortal} from '@/components/ui/dialog';
import {useHud} from '@/providers';
import {cn} from '@/lib/utils';
import {type SettingsMode, type SettingsTab} from '@/lib/hud';
import SettingsPanel from '@/components/SettingsPanel';

// Centered, fixed-size card.
const MODAL_CLS =
  'left-1/2 top-1/2 h-[600px] max-h-[85vh] w-[calc(100vw-2rem)] max-w-[860px] -translate-x-1/2 -translate-y-1/2 rounded-lg border ' +
  'data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95';
// Edge-to-edge over the whole viewport.
const FULLSCREEN_CLS = 'inset-0 h-screen w-screen rounded-none';

/**
 * Settings surface, presented as either a centered modal or a fullscreen view
 * per `hud.settings.mode`. Both presentations are the same Radix dialog (so each
 * gets focus trapping, Escape-to-close, and scroll locking) sized differently,
 * wrapping the shared {@link SettingsPanel}. Rendered once at the layout root.
 */
export default function Settings() {
  const {hud, setHud} = useHud();
  const {open, mode, tab} = hud.settings;

  const setOpen = React.useCallback(
    (next: boolean) => setHud((draft) => {draft.settings.open = next; return draft;}),
    [setHud],
  );
  const setTab = React.useCallback(
    (next: SettingsTab) => setHud((draft) => {draft.settings.tab = next; return draft;}),
    [setHud],
  );
  const setMode = React.useCallback(
    (next: SettingsMode) => setHud((draft) => {draft.settings.mode = next; return draft;}),
    [setHud],
  );

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          className={cn(
            'fixed z-50 flex overflow-hidden bg-background p-0 shadow-lg duration-200',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            mode === 'fullscreen' ? FULLSCREEN_CLS : MODAL_CLS,
          )}
        >
          <DialogPrimitive.Title className="sr-only">Settings</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Application settings</DialogPrimitive.Description>
          <SettingsPanel
            tab={tab}
            onTabChange={setTab}
            mode={mode}
            onModeChange={setMode}
            onClose={() => setOpen(false)}
          />
        </DialogPrimitive.Content>
      </DialogPortal>
    </DialogPrimitive.Root>
  );
}
