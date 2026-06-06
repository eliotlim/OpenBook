import React, {createContext, PropsWithChildren, useContext} from 'react';
import type {ServerControls} from '@open-book/sdk';

/** Where to open a page: a new tab or a separate new window. */
export type NewViewTarget = 'tab' | 'window';

/**
 * How the host handles new tabs/windows. The desktop sets `inWindow` so a "new
 * tab" becomes an in-window tab (a custom tab bar in the titlebar) and supplies
 * `openWindow` for a separate OS window. The web shell leaves this undefined, so
 * the UI falls back to `window.open` — a real browser tab or a popup window.
 */
export interface TabsPlatform {
  /** Tabs live inside the window (custom titlebar tab bar) rather than as OS tabs. */
  inWindow?: boolean;
  /** Open `pageId` in a separate OS window. */
  openWindow: (pageId: string) => void;
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
