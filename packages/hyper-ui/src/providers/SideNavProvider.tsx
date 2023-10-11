import React, {createContext, PropsWithChildren, useContext, useState} from 'react';

export interface SideNavProps {
  open: boolean;
  docked?: boolean;
}

export interface SideNavContext {
  sideNav: SideNavProps;
  setSideNav: React.Dispatch<SideNavProps>;
}

export const SideNavDefault = {
  open: false,
  docked: false,
};

export const SideNavContext = createContext<SideNavContext>({
  sideNav: SideNavDefault,
  setSideNav: () => false
});

export const useSideNav = () => useContext(SideNavContext);

export const SideNavProvider: React.FC<PropsWithChildren<unknown>> = ({children}) => {
  const storageKey = 'sideNav';
  const [sideNav, setSideNav] = useState<SideNavProps>(() => {
    if (typeof window === 'undefined' || localStorage.getItem(storageKey) === null) {
      return SideNavDefault;
    }
    return JSON.parse(localStorage.getItem(storageKey) ?? '{}') as SideNavProps;
  });

  const sidenavMenuListener = React.useCallback((e: MouseEvent) => {
    if (!sideNav.docked) {
      if (e.clientX > 320 || e.clientX <= 1) {
        setSideNav({...sideNav, open: false});
      } else if (e.clientX < 16) {
        setSideNav({...sideNav, open: true});
      }
    }
  }, [sideNav, setSideNav]);

  React.useEffect(() => {
    if (typeof window !== 'undefined') {
      window.addEventListener('mousemove', sidenavMenuListener);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('mousemove', sidenavMenuListener);
      }
    };
  }, [sidenavMenuListener]);

  const state = {
    sideNav,
    setSideNav: (sideNav: SideNavProps) => {
      localStorage.setItem(storageKey, JSON.stringify({docked: sideNav.docked, open: sideNav.open}));
      setSideNav(sideNav);
    }
  };

  return <SideNavContext.Provider value={state}>
    {children}
  </SideNavContext.Provider>;
};
