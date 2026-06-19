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
 * How the host completes account.book.pub's deep-link sign-in. The desktop sets
 * a custom-scheme `redirectUri` (`openbook://auth-callback`), opens the browser
 * itself, and delivers the minted token back through the OS deep-link
 * (`onCallback`). The web shell leaves this undefined: it falls back to an
 * `${origin}/account/callback` popup that hands the token back same-origin.
 */
export interface AccountPlatform {
  /** The OAuth callback URI the account service redirects back to. Omit on web
   *  (the provider defaults to `${origin}/account/callback`). */
  redirectUri?: string;
  /** Open the sign-in URL in the system browser. Omit on web (defaults to a popup). */
  openSignIn?: (url: string) => void;
  /** Subscribe to deep-link callbacks carrying the minted token; returns an
   *  unsubscribe. Desktop only — web receives the token via its callback page. */
  onCallback?: (cb: (params: {token: string; state: string}) => void) => () => void;
}

/**
 * Capabilities the host platform provides to the UI. The Tauri desktop app
 * supplies `serverControls` (start/stop/inspect the bundled local server),
 * `tabs` (in-window tabs), `windowControls` (frameless min/max/close on
 * Windows/Linux), and `account` (deep-link sign-in); the web shell leaves these
 * undefined and the UI falls back to browser behaviour.
 */
export interface PlatformLibrary {
  serverControls?: ServerControls;
  tabs?: TabsPlatform;
  windowControls?: WindowControls;
  account?: AccountPlatform;
}

const PlatformLibraryContext = createContext<PlatformLibrary>({});

export const usePlatformLibrary = (): PlatformLibrary => useContext(PlatformLibraryContext);

export const PlatformLibraryProvider: React.FC<PropsWithChildren<{value?: PlatformLibrary}>> = ({
  value = {},
  children,
}) => <PlatformLibraryContext.Provider value={value}>{children}</PlatformLibraryContext.Provider>;
