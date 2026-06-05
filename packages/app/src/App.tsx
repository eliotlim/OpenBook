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

// All windows share one tabbing identifier, so macOS groups them as native
// window-tabs (a tab bar at the top of the window). Each tab is its own
// WebviewWindow running the app on a page, all talking to the one bundled
// server — so the OS provides the tab UX while the server stays the source of
// truth shared across tabs.
const TABBING_IDENTIFIER = 'openbook';

const newWindowLabel = (): string =>
  `tab-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : `${Date.now()}`}`;

/** Open `pageId` in a new macOS window-tab. */
function openPageInNewTab(pageId: string): void {
  const target = new URL(window.location.href);
  target.searchParams.set('page', pageId);
  target.searchParams.delete('split');
  const tab = new WebviewWindow(newWindowLabel(), {
    url: `${target.pathname}${target.search}`,
    title: 'OpenBook',
    width: 1440,
    height: 900,
    tabbingIdentifier: TABBING_IDENTIFIER,
  });
  void tab.once('tauri://error', (e) => console.error('OpenBook: failed to open a new tab:', e.payload));
}

// Expose the Tauri-managed local server + native tabs to the UI.
const platform: PlatformLibrary = {
  serverControls: {
    info: () => invoke<ServerInfo>('server_info'),
    start: () => invoke<ServerInfo>('start_server'),
    stop: () => invoke<ServerInfo>('stop_server'),
  },
  tabs: {openPageInNewTab},
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
