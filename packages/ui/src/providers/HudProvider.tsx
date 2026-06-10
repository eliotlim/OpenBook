import React, {createContext, PropsWithChildren, useContext} from 'react';
import {HUD_STORAGE_KEY, HudDefault, HudProps, loadHudStorage, saveHudStorage} from '@/lib/hud';
import {useImmer} from 'use-immer';

export interface HudContext {
  hud: HudProps;
  setHud: React.Dispatch<HudProps | ((draft: HudProps) => HudProps)>;
}

export const HudContext = createContext<HudContext>({
  hud: HudDefault,
  setHud: () => false
});

export const useHud = () => useContext(HudContext);

export const HudProvider: React.FC<PropsWithChildren<unknown>> = ({children}) => {
  const [hud, setHud] = useImmer<HudProps>(loadHudStorage);
  // Whether a HUD preference existed before this mount — captured at first
  // render, because the save effect below persists one immediately.
  const hadStoredHud = React.useRef(
    typeof window !== 'undefined' && localStorage.getItem(HUD_STORAGE_KEY) !== null,
  );

  React.useEffect(() => {
    saveHudStorage(hud);
  }, [hud]);

  // First visit on a narrow screen (phone): default the sidebar collapsed so
  // the document gets the width — a 256px rail leaves nothing at 375px.
  // Collapsed = undocked + closed (the same state the toggle produces); the
  // edge-hover/toggle still brings it back. Post-mount (not in the state
  // initializer) so SSR and hydration render the same tree; any stored
  // preference wins.
  React.useEffect(() => {
    if (!hadStoredHud.current && window.innerWidth < 768) {
      setHud((draft) => {
        draft.sideNav.open = false;
        draft.sideNav.docked = false;
        return draft;
      });
    }
  }, [setHud]);

  // Global keyboard shortcuts (incl. ⌘K for the palette) are owned by the
  // <GlobalShortcuts> behavior in the layout, which fires the shared command
  // registry — so a key and its command/menu entry never drift.

  const hudMouseListener = React.useCallback((e: MouseEvent) => {
    if (!hud.sideNav.docked) {
      if (e.clientX > 320 || e.clientX <= 1) {
        setHud(draft => {draft.sideNav.open = false; return draft;});
      } else if (e.clientX < 16) {
        setHud(draft => {draft.sideNav.open = true; return draft;});
      }
    }
  }, [hud, hud.sideNav, setHud]);

  React.useEffect(() => {
    document.addEventListener('mousemove', hudMouseListener);
    return () => document.removeEventListener('mousemove', hudMouseListener);
  }, [hudMouseListener]);

  const state = {
    hud: hud,
    setHud: setHud,
  };

  return <HudContext.Provider value={state}>
    {children}
  </HudContext.Provider>;
};
