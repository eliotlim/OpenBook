import React, {createContext, PropsWithChildren, useContext, useState} from 'react';
import {HudDefault, HudProps, loadHudStorage, saveHudStorage} from "@/lib/hud";

export interface HudContext {
  hud: HudProps;
  setHud: React.Dispatch<HudProps>;
}

export const HudContext = createContext<HudContext>({
  hud: HudDefault,
  setHud: () => false
});

export const useHud = () => useContext(HudContext);

export const HudProvider: React.FC<PropsWithChildren<unknown>> = ({children}) => {
  const [hud, setHud] = useState<HudProps>(loadHudStorage);

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
        setHud({...hud, sideNav: {...hud.sideNav, open: false}});
      } else if (e.clientX < 16) {
        setHud({...hud, sideNav: {...hud.sideNav, open: true}});
      }
    }
  }, [hud, hud.sideNav, setHud]);

  React.useEffect(() => {
    document.addEventListener('mousemove', hudMouseListener);
    return () => document.removeEventListener('mousemove', hudMouseListener);
  }, [hudMouseListener]);

  const state = {
    hud: hud,
    setHud: (hud: HudProps) => {
      saveHudStorage(hud);
      setHud(hud);
    }
  };

  return <HudContext.Provider value={state}>
    {children}
  </HudContext.Provider>;
};
