import React, {useMemo} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {WebviewWindow} from '@tauri-apps/api/webviewWindow';
import {
  DataProvider,
  DefaultLayout,
  DocumentArea,
  HudProvider,
  NavigationProvider,
  PlatformLibraryProvider,
  ThemeProvider,
  WorkspaceProvider,
  type PlatformLibrary,
} from '@open-book/ui';
import type {ServerInfo} from '@open-book/sdk';

import {createDesktopClient} from './data/client';

import '@open-book/ui/style.css';

// Windows that share this tabbing identifier are grouped by macOS into native
// window-tabs (a tab bar at the top of the window). A "new tab" carries the
// identifier so it joins the group; a "new window" omits it so macOS opens it
// standalone. Each is its own WebviewWindow running the app on a page, all
// talking to the one bundled server — the OS provides the tab/window UX while
// the server stays the source of truth shared across them.
const TABBING_IDENTIFIER = 'openbook';

const newWindowLabel = (): string =>
  `tab-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : `${Date.now()}`}`;

/** Open `pageId` in a new macOS window-tab (`tab`) or a standalone window (`window`). */
function openPage(pageId: string, target: 'tab' | 'window'): void {
  const url = new URL(window.location.href);
  url.searchParams.set('page', pageId);
  url.searchParams.delete('split');
  const view = new WebviewWindow(newWindowLabel(), {
    url: `${url.pathname}${url.search}`,
    title: 'OpenBook',
    width: 1440,
    height: 900,
    // Only tabs join the tabbing group; windows omit the identifier so macOS
    // keeps them standalone.
    ...(target === 'tab' ? {tabbingIdentifier: TABBING_IDENTIFIER} : {}),
  });
  void view.once('tauri://error', (e) => console.error(`OpenBook: failed to open a new ${target}:`, e.payload));
}

// Expose the Tauri-managed local server + native tabs/windows to the UI.
const platform: PlatformLibrary = {
  serverControls: {
    info: () => invoke<ServerInfo>('server_info'),
    start: () => invoke<ServerInfo>('start_server'),
    stop: () => invoke<ServerInfo>('stop_server'),
  },
  tabs: {openPage},
};

function App() {
  // Embedded local server by default, or an external one if configured.
  const client = useMemo(() => createDesktopClient(), []);

  return (
    <ThemeProvider>
      <PlatformLibraryProvider value={platform}>
        <DataProvider client={client}>
          <NavigationProvider>
            <WorkspaceProvider>
              <HudProvider>
                <DefaultLayout>
                  <DocumentArea />
                </DefaultLayout>
              </HudProvider>
            </WorkspaceProvider>
          </NavigationProvider>
        </DataProvider>
      </PlatformLibraryProvider>
    </ThemeProvider>
  );
}

export default App;
