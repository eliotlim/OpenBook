import React, {createContext, useContext, useState, PropsWithChildren} from "react";

export interface PlatformLibrary {

}

export const PlatformLibraryContext = createContext<PlatformLibrary | null>(null);

export const usePlatformLibrary = () => useContext(PlatformLibraryContext);

export const PlatformLibraryProvider: React.FC<PropsWithChildren<unknown>> = ({children}) => {
  const [platformLibrary, setPlatformLibrary] = useState<PlatformLibrary | null>(null);
  return <PlatformLibraryContext.Provider value={{platformLibrary, setPlatformLibrary}}>
    {children}
  </PlatformLibraryContext.Provider>
}
