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

// Tabs are in-window (a custom tab bar drawn in the titlebar by the UI), so a
// "new tab" never opens an OS window — only "new window" does. The windows use
// an overlay titlebar (content extends under it) so the tab bar sits level with
// the traffic lights; the layout reserves a strip of this height at the top.
// Tune here if the tab bar overlaps the nav bar or leaves a gap.
const TITLEBAR_HEIGHT = '38px';
if (typeof document !== 'undefined') {
  document.documentElement.style.setProperty('--ob-titlebar-height', TITLEBAR_HEIGHT);
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
    titleBarStyle: 'overlay',
    hiddenTitle: true,
  });
  void view.once('tauri://error', (e) => console.error('OpenBook: failed to open a new window:', e.payload));
}

// Expose the Tauri-managed local server + in-window tabs to the UI.
const platform: PlatformLibrary = {
  serverControls: {
    info: () => invoke<ServerInfo>('server_info'),
    start: () => invoke<ServerInfo>('start_server'),
    stop: () => invoke<ServerInfo>('stop_server'),
  },
  tabs: {inWindow: true, openWindow},
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
