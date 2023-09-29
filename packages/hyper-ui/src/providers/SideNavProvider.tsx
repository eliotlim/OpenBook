import React, {createContext, useContext, useState, PropsWithChildren} from 'react';

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
  const [sideNav, setSideNav] = useState<SideNavProps>(SideNavDefault);

  const sidenavMenuListener = React.useCallback((e: MouseEvent) => {
    if (!sideNav.docked) {
      if (e.clientX > 320) {
        setSideNav({...sideNav, open: false});
      }
      if (e.clientX < 16) {
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

  return <SideNavContext.Provider value={{sideNav, setSideNav}}>
    {children}
  </SideNavContext.Provider>;
};
