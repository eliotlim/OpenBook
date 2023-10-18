import React, {createContext, PropsWithChildren, useContext, useState} from 'react';
import {loadHudStorage, saveHudStorage} from "@/lib/hud";

export interface HudProps {
  sideNav: {
    open: boolean;
    docked: boolean;
  };
}

export interface HudContext {
  hud: HudProps;
  setHud: React.Dispatch<HudProps>;
}

export const HudDefault = {
  sideNav: {
    open: false,
    docked: false,
  },
};

export const HudContext = createContext<HudContext>({
  hud: HudDefault,
  setHud: () => false
});

export const useHud = () => useContext(HudContext);

export const HudProvider: React.FC<PropsWithChildren<unknown>> = ({children}) => {
  const [hud, setHud] = useState<HudProps>(loadHudStorage);

  const hudSidenavHoverListener = React.useCallback((e: MouseEvent) => {
    if (!hud.sideNav.docked) {
      if (e.clientX > 320 || e.clientX <= 1) {
        setHud({...hud, sideNav: {...hud.sideNav, open: false}});
      } else if (e.clientX < 16) {
        setHud({...hud, sideNav: {...hud.sideNav, open: true}});
      }
    }
  }, [hud, hud.sideNav, setHud]);

  React.useEffect(() => {
    if (typeof window !== 'undefined') {
      window.addEventListener('mousemove', hudSidenavHoverListener);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('mousemove', hudSidenavHoverListener);
      }
    };
  }, [hudSidenavHoverListener]);

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
