import React, {createContext, PropsWithChildren, useContext} from 'react';
import {HudDefault, HudProps, loadHudStorage, saveHudStorage} from "@/lib/hud";
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

  const hudKeyListener = React.useCallback((e: KeyboardEvent) => {
    if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setHud({...hud, commandPalette: {...hud.commandPalette, open: true}});
    }
  }, []);

  React.useEffect(() => {
    document.addEventListener('keydown', hudKeyListener);
    return () => document.removeEventListener('keydown', hudKeyListener);
  }, []);

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
