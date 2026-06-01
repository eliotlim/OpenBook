import React, {createContext, PropsWithChildren, useContext} from 'react';
import type {ServerControls} from '@open-book/sdk';

/**
 * Capabilities the host platform provides to the UI. The Tauri desktop app
 * supplies `serverControls` (start/stop/inspect the bundled local server); the
 * web shell leaves it undefined since it has no local server to manage.
 */
export interface PlatformLibrary {
  serverControls?: ServerControls;
}

const PlatformLibraryContext = createContext<PlatformLibrary>({});

export const usePlatformLibrary = (): PlatformLibrary => useContext(PlatformLibraryContext);

export const PlatformLibraryProvider: React.FC<PropsWithChildren<{value?: PlatformLibrary}>> = ({
  value = {},
  children,
}) => <PlatformLibraryContext.Provider value={value}>{children}</PlatformLibraryContext.Provider>;
