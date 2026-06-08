import React, {createContext, PropsWithChildren, useContext} from 'react';
import {HudDefault, HudProps, loadHudStorage, saveHudStorage} from '@/lib/hud';
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

  React.useEffect(() => {
    saveHudStorage(hud);
  }, [hud]);

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
