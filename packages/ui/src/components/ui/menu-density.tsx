import React, {createContext, useContext} from 'react';

/** Visual spacing for context and dropdown menus. */
export type MenuDensity = 'compact' | 'comfortable';

const MenuDensityContext = createContext<MenuDensity>('comfortable');

/** Applies one density to every nested context/dropdown menu primitive. */
export function MenuDensityProvider({
  density,
  children,
}: React.PropsWithChildren<{density: MenuDensity}>) {
  return <MenuDensityContext.Provider value={density}>{children}</MenuDensityContext.Provider>;
}

/** The active menu density; standalone primitives default to comfortable. */
export function useMenuDensity(): MenuDensity {
  return useContext(MenuDensityContext);
}
