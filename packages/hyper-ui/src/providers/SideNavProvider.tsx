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
  docked: true,
};

export const SideNavContext = createContext<SideNavContext>({
  sideNav: SideNavDefault,
  setSideNav: () => false
});

export const useSideNav = () => useContext(SideNavContext);

export const SideNavProvider: React.FC<PropsWithChildren<unknown>> = ({children}) => {
  const [sideNav, setSideNav] = useState<SideNavProps>(SideNavDefault);
  return <SideNavContext.Provider value={{sideNav, setSideNav}}>
    {children}
  </SideNavContext.Provider>;
};
