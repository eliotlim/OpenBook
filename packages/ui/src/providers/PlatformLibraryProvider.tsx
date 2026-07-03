import React, {createContext, PropsWithChildren, useContext} from 'react';
import type {BookFolderFile, FetchLike, KeyStore, ServerControls} from '@book.dev/sdk';

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
 * Per-account device-token storage, namespaced by a local account id (OB-194).
 * The client can hold several account.book.pub accounts at once (work + personal),
 * so each account's bearer token gets its own slot — no shared key, no
 * cross-account leakage. The desktop backs this with the OS keychain (one entry
 * per account id, like {@link ForwardingPlatform.keyStore}); the web shell — and
 * unsigned desktop *dev* builds, whose per-relink cdhash loses keychain access —
 * leave it undefined and the UI falls back to a namespaced-`localStorage` store.
 */
export interface AccountSecretStore {
  /** Read account `id`'s device token, or `null` when none is stored. */
  get(id: string): Promise<string | null>;
  /** Store (overwrite) account `id`'s device token. */
  set(id: string, token: string): Promise<void>;
  /** Forget account `id`'s device token. */
  delete(id: string): Promise<void>;
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
  /** Secure, per-account device-token storage (OB-194). Omit on web / desktop dev;
   *  the UI then falls back to a namespaced-`localStorage` store. */
  secretStore?: AccountSecretStore;
}

/**
 * How the host reads/writes an on-disk book folder (the human-readable
 * `<book>/<page>.html` layout, lossless `openbook.space.json` sidecar). The
 * desktop supplies a native dialog + filesystem implementation; the web shell
 * leaves this undefined and the UI falls back to the File System Access API
 * (with a zip download/upload fallback for browsers that lack it).
 */
export interface BookFolderPlatform {
  /** Write an exported book folder to a host-chosen location. Resolves a summary
   *  (`location` to show the user, `count` of pages written), or `null` if the
   *  user cancelled. */
  export(files: BookFolderFile[]): Promise<{location: string; count: number} | null>;
  /** Read a host-chosen book folder back into files, or `null` if cancelled. */
  import?(): Promise<BookFolderFile[] | null>;
}

/**
 * How the host persists the forwarding site identity. Forwarding to *.book.pub
 * needs the Ed25519 device private key kept in the OS keychain, which only the
 * native shell can reach — so the desktop supplies a keychain-backed
 * {@link KeyStore} and the web shell leaves this undefined (forwarding is a
 * desktop-only affordance; the web app *is* the cloud).
 */
export interface ForwardingPlatform {
  keyStore: KeyStore;
  /**
   * The `fetch` the forwarding tunnel uses to serve inbound requests against the
   * local data server. On the desktop this is the IPC transport, so forwarded
   * traffic reaches the portless local server without opening a TCP port. Omit to
   * fall back to a normal `fetch` against a real `localOrigin`.
   */
  localFetch?: FetchLike;
}

/**
 * Capabilities the host platform provides to the UI. The Tauri desktop app
 * supplies `serverControls` (inspect/publish the local server), `bookFolder`
 * (native folder export/import), `forwarding` (keychain for *.book.pub),
 * `tabs` (in-window tabs), `windowControls` (frameless min/max/close on
 * Windows/Linux), and `account` (deep-link sign-in); the web shell leaves these
 * undefined and the UI falls back to browser behaviour.
 */
export interface PlatformLibrary {
  serverControls?: ServerControls;
  bookFolder?: BookFolderPlatform;
  forwarding?: ForwardingPlatform;
  tabs?: TabsPlatform;
  windowControls?: WindowControls;
  account?: AccountPlatform;
  /**
   * Declared by hosts whose workspace lives only in this browser profile — the
   * standalone web app's embedded PGlite store (P0-4 sharing audit). Nothing
   * outside this browser can reach that workspace and the build has no publish
   * affordance, so the sharing surfaces (Share dialog, Members, Sharing &
   * publishing) stay functional but say honestly that these settings can't
   * reach anyone until a workspace is published from the desktop app. Leave
   * unset on desktop, on forwarded `<prefix>.book.cloud` sites and on
   * remote-server connections — those all reach a real shared instance.
   */
  browserLocalWorkspace?: boolean;
}

const PlatformLibraryContext = createContext<PlatformLibrary>({});

export const usePlatformLibrary = (): PlatformLibrary => useContext(PlatformLibraryContext);

export const PlatformLibraryProvider: React.FC<PropsWithChildren<{value?: PlatformLibrary}>> = ({
  value = {},
  children,
}) => <PlatformLibraryContext.Provider value={value}>{children}</PlatformLibraryContext.Provider>;
