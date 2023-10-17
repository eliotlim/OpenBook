import React, {createContext, PropsWithChildren, useContext, useState} from 'react';

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
  const storageKey = 'hud';
  const [hud, setHud] = useState<HudProps>(() => {
    if (typeof window === 'undefined' || localStorage.getItem(storageKey) === null) {
      return HudDefault;
    }
    return JSON.parse(localStorage.getItem(storageKey) ?? '{}') as HudProps;
  });

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
      localStorage.setItem(storageKey, JSON.stringify(hud));
      setHud(hud);
    }
  };

  return <HudContext.Provider value={state}>
    {children}
  </HudContext.Provider>;
};
