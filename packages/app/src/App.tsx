import React, {useEffect, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {WebviewWindow} from '@tauri-apps/api/webviewWindow';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {open as openExternal} from '@tauri-apps/plugin-shell';
import {getCurrent as currentDeepLink, onOpenUrl} from '@tauri-apps/plugin-deep-link';
import {
  AccountProvider,
  DataProvider,
  DefaultLayout,
  DocumentArea,
  ForwardingProvider,
  HudProvider,
  I18nProvider,
  NavigationProvider,
  PlatformLibraryProvider,
  PreferencesProvider,
  ThemeProvider,
  WorkspaceProvider,
  type PlatformLibrary,
  type WindowControls,
} from '@book.dev/ui';
import type {BookFolderFile, DataClient, ServerInfo} from '@book.dev/sdk';

import {createDesktopClient, DEV_SERVER_URL} from './data/client';
import {tauriFetch} from './data/ipc';
import {createTauriKeyStore, createLocalStorageKeyStore} from './data/keychain';

import '@book.dev/ui/style.css';

// Tabs are in-window (a custom tab bar drawn in the titlebar by the UI), so a
// "new tab" never opens an OS window — only "new window" does.
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);

// macOS uses an overlay titlebar (content extends under it) so the tab bar sits
// level with the traffic lights; the leading inset clears them. On Windows /
// Linux the macOS-only `titleBarStyle`/`hiddenTitle` options are ignored, so the
// tab bar renders as a strip below the OS title bar with no leading inset. Tune
// the height here if the tab bar overlaps the nav bar or leaves a gap.
const TITLEBAR_HEIGHT = '38px';
if (typeof document !== 'undefined') {
  document.documentElement.style.setProperty('--ob-titlebar-height', TITLEBAR_HEIGHT);
  document.documentElement.style.setProperty('--ob-titlebar-pad-left', IS_MAC ? '78px' : '8px');
  // The native window corner radius, so the notebook "sheets" curve concentrically
  // with the window (macOS ≈ 10px; Windows 11 ≈ 8px). Web keeps the CSS fallback.
  document.documentElement.style.setProperty('--ob-window-radius', IS_MAC ? '10px' : '8px');
  // On the desktop the titlebar is the book cover's top edge, so the pages sit
  // flush beneath it — no top inset (the bottom keeps one).
  document.documentElement.style.setProperty('--ob-inset-top', '0px');
}

const newWindowLabel = (): string =>
  `win-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : `${Date.now()}`}`;

/** Open `pageId` in a separate OS window. */
function openWindow(pageId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('page', pageId);
  url.searchParams.delete('split');
  const view = new WebviewWindow(newWindowLabel(), {
    url: `${url.pathname}${url.search}`,
    title: 'OpenBook',
    width: 1440,
    height: 900,
    // macOS keeps its native traffic lights via an overlay titlebar; elsewhere
    // the window is frameless and the UI draws its own controls.
    ...(IS_MAC ? {titleBarStyle: 'overlay', hiddenTitle: true} : {decorations: false}),
  });
  void view.once('tauri://error', (e) => console.error('OpenBook: failed to open a new window:', e.payload));
}

// Frameless window controls (Windows/Linux); macOS uses its native traffic lights.
const windowControls: WindowControls | undefined = IS_MAC
  ? undefined
  : {
    minimize: () => void getCurrentWindow().minimize(),
    toggleMaximize: () => void getCurrentWindow().toggleMaximize(),
    close: () => void getCurrentWindow().close(),
    watchMaximized: (cb) => {
      const win = getCurrentWindow();
      void win.isMaximized().then(cb).catch(() => undefined);
      const unlisten = win.onResized(() => void win.isMaximized().then(cb).catch(() => undefined));
      return () => void unlisten.then((u) => u()).catch(() => undefined);
    },
  };

// Parse `openbook://auth-callback#token=…&state=…` into the token handoff. The
// AccountProvider still validates `state` against the in-flight sign-in; pinning
// the host here is just defence-in-depth against stray `openbook://` links.
function parseAuthCallback(raw: string): {token: string; state: string} | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'openbook:' || u.hostname !== 'auth-callback') return null;
    const p = new URLSearchParams(u.hash.replace(/^#/, ''));
    const token = p.get('token');
    return token ? {token, state: p.get('state') ?? ''} : null;
  } catch {
    return null;
  }
}

// Expose the Tauri-managed local server + in-window tabs + window controls +
// the account.book.pub deep-link sign-in.
const platform: PlatformLibrary = {
  serverControls: {
    info: () => invoke<ServerInfo>('server_info'),
    // Publish on the LAN: the local server *also* binds 0.0.0.0 + requires the
    // token. The local UI keeps using IPC, so there's no client switch — only the
    // LAN listener toggles.
    publish: (enabled: boolean) => invoke<ServerInfo>('publish_server', {enabled}),
    // Native folder picker / reveal for the on-disk book mirror.
    chooseBookDir: () => invoke<ServerInfo>('choose_book_dir'),
    revealBookDir: () => invoke<void>('reveal_book_dir'),
  },
  // Native book-folder export/import (the WKWebView has no File System Access
  // API, so this goes through a Tauri dialog + fs rather than the web fallback).
  bookFolder: {
    export: (files: BookFolderFile[]) =>
      invoke<{location: string; count: number} | null>('export_book_folder', {files}),
    import: () => invoke<BookFolderFile[] | null>('import_book_folder'),
  },
  // Forwarding to *.book.pub: the site identity (incl. the Ed25519 private key)
  // lives in the OS keychain via the Rust keychain_* commands, and the tunnel
  // serves the local data server over the same IPC transport (no port).
  forwarding: {
    // Dev builds are adhoc-signed with a per-rebuild cdhash, and macOS gates
    // keychain access by code identity — so a key saved by one `tauri dev` build
    // can't be reattached by the next, and forwarding re-provisions a new site
    // (new `library-*` host) each run. A localStorage store survives rebuilds; the
    // keychain is correct for a signed release build (stable identity across versions).
    keyStore: import.meta.env.DEV ? createLocalStorageKeyStore() : createTauriKeyStore(),
    // Serve forwarded requests over the SAME transport the local data client uses
    // (see createDesktopClient): the Unix-socket IPC bridge in a managed release
    // build, but plain loopback HTTP in dev — the `pnpm dev` server is TCP-only and
    // never opens the socket, so `tauriFetch` would dead-dial it. `localOrigin`
    // stays '' (ForwardingProvider), so the dev impl resolves the path against :4319.
    localFetch: import.meta.env.DEV ? (input, init) => fetch(`${DEV_SERVER_URL}${input}`, init) : tauriFetch,
  },
  tabs: {inWindow: true, openWindow},
  windowControls,
  account: {
    redirectUri: 'openbook://auth-callback',
    // Sign-in happens in the user's real browser (OAuth, then the deep link back).
    openSignIn: (url) => void openExternal(url).catch((e) => console.error('OpenBook: failed to open the browser:', e)),
    // Deliver the token from the `openbook://` deep link to the AccountProvider.
    onCallback: (cb) => {
      const emit = (urls: string[]): void => {
        for (const u of urls) {
          const parsed = parseAuthCallback(u);
          if (parsed) cb(parsed);
        }
      };
      // A link that cold-started the app, plus every link while it's running.
      void currentDeepLink().then((urls) => urls && emit(urls)).catch(() => undefined);
      let unlisten: (() => void) | undefined;
      void onOpenUrl(emit).then((un) => {
        unlisten = un;
      });
      return () => unlisten?.();
    },
  },
};

function App() {
  // Embedded local server by default, or an external one if configured. Built
  // async because we ask the host for the server status (loopback address + the
  // access token when published) before connecting.
  const [client, setClient] = useState<DataClient | null>(null);
  useEffect(() => {
    void createDesktopClient().then(setClient);
  }, []);

  return (
    <ThemeProvider>
      <I18nProvider>
        <PreferencesProvider>
          <PlatformLibraryProvider value={platform}>
            {client && (
              <DataProvider client={client}>
                <NavigationProvider>
                  <WorkspaceProvider>
                    <AccountProvider>
                      <ForwardingProvider>
                        <HudProvider>
                          <DefaultLayout>
                            <DocumentArea />
                          </DefaultLayout>
                        </HudProvider>
                      </ForwardingProvider>
                    </AccountProvider>
                  </WorkspaceProvider>
                </NavigationProvider>
              </DataProvider>
            )}
          </PlatformLibraryProvider>
        </PreferencesProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

export default App;
