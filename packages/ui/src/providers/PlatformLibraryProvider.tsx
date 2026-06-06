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
 * The window-management buttons a frameless window must draw itself. The
 * desktop supplies these on Windows/Linux (where the window has no native title
 * bar); macOS keeps its native traffic lights, so it leaves this undefined and
 * the UI draws no custom controls.
 */
export interface WindowControls {
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  /**
   * Observe the maximized state (to show maximize vs restore). Calls back with
   * the current value immediately and on every change; returns an unsubscribe.
   */
  watchMaximized?: (cb: (maximized: boolean) => void) => () => void;
}

/**
 * Capabilities the host platform provides to the UI. The Tauri desktop app
 * supplies `serverControls` (start/stop/inspect the bundled local server),
 * `tabs` (in-window tabs), and `windowControls` (frameless min/max/close on
 * Windows/Linux); the web shell leaves these undefined.
 */
export interface PlatformLibrary {
  serverControls?: ServerControls;
  tabs?: TabsPlatform;
  windowControls?: WindowControls;
}

const PlatformLibraryContext = createContext<PlatformLibrary>({});

export const usePlatformLibrary = (): PlatformLibrary => useContext(PlatformLibraryContext);

export const PlatformLibraryProvider: React.FC<PropsWithChildren<{value?: PlatformLibrary}>> = ({
  value = {},
  children,
}) => <PlatformLibraryContext.Provider value={value}>{children}</PlatformLibraryContext.Provider>;
