import React, {useMemo} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {WebviewWindow} from '@tauri-apps/api/webviewWindow';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {
  DataProvider,
  DefaultLayout,
  DocumentArea,
  HudProvider,
  I18nProvider,
  NavigationProvider,
  PlatformLibraryProvider,
  PreferencesProvider,
  ThemeProvider,
  WorkspaceProvider,
  type PlatformLibrary,
  type WindowControls,
} from '@open-book/ui';
import type {ServerInfo} from '@open-book/sdk';

import {createDesktopClient} from './data/client';

import '@open-book/ui/style.css';

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

// Expose the Tauri-managed local server + in-window tabs + window controls.
const platform: PlatformLibrary = {
  serverControls: {
    info: () => invoke<ServerInfo>('server_info'),
    start: () => invoke<ServerInfo>('start_server'),
    stop: () => invoke<ServerInfo>('stop_server'),
  },
  tabs: {inWindow: true, openWindow},
  windowControls,
};

function App() {
  // Embedded local server by default, or an external one if configured.
  const client = useMemo(() => createDesktopClient(), []);

  return (
    <ThemeProvider>
      <I18nProvider>
        <PreferencesProvider>
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
        </PreferencesProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

export default App;
