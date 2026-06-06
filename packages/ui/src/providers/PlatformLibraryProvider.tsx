import React, {createContext, PropsWithChildren, useContext} from 'react';
import type {ServerControls} from '@open-book/sdk';

/** Where to open a page: a new tab or a separate new window. */
export type NewViewTarget = 'tab' | 'window';

/**
 * How the host opens a page in a new tab or window. The desktop supplies a
 * Tauri implementation (a macOS window-tab, or a standalone window); the web
 * shell leaves it undefined and the UI falls back to `window.open` (a browser
 * tab, or a popup window).
 */
export interface TabsPlatform {
  /** Open `pageId` in a new tab or a separate window. */
  openPage: (pageId: string, target: NewViewTarget) => void;
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
