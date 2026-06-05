import React, {createContext, PropsWithChildren, useContext} from 'react';
import type {ServerControls} from '@open-book/sdk';

/**
 * How the host opens a page in a new native tab. The desktop supplies a Tauri
 * implementation (a new macOS window-tab); the web shell leaves it undefined,
 * and the UI falls back to `window.open` (a real browser tab).
 */
export interface TabsPlatform {
  /** Open `pageId` in a new OS/browser tab. */
  openPageInNewTab: (pageId: string) => void;
}

/**
 * Capabilities the host platform provides to the UI. The Tauri desktop app
 * supplies `serverControls` (start/stop/inspect the bundled local server) and
 * `tabs` (native macOS window-tabs); the web shell leaves `serverControls`
 * undefined (no local server) and relies on the default browser-tab behavior.
 */
export interface PlatformLibrary {
  serverControls?: ServerControls;
  tabs?: TabsPlatform;
}

const PlatformLibraryContext = createContext<PlatformLibrary>({});

export const usePlatformLibrary = (): PlatformLibrary => useContext(PlatformLibraryContext);

export const PlatformLibraryProvider: React.FC<PropsWithChildren<{value?: PlatformLibrary}>> = ({
  value = {},
  children,
}) => <PlatformLibraryContext.Provider value={value}>{children}</PlatformLibraryContext.Provider>;
