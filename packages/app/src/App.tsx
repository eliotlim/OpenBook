import React, {useMemo} from 'react';
import {
  ConnectedPageDocument,
  DataProvider,
  DefaultLayout,
  HudProvider,
  ThemeProvider,
  WorkspaceProvider,
  useCurrentPageId,
} from '@open-book/ui';

import {createDesktopClient} from './data/client';

import '@open-book/ui/style.css';

function DocumentRoute() {
  // Stable per-install page id (persisted in localStorage). Null until mounted.
  const pageId = useCurrentPageId();
  return pageId ? <ConnectedPageDocument pageId={pageId} /> : null;
}

function App() {
  // The client is chosen once per session: embedded Postgres (Tauri commands)
  // by default, or an external server if one is configured. All persistence
  // flows through it.
  const client = useMemo(() => createDesktopClient(), []);

  return (
    <ThemeProvider>
      <DataProvider client={client}>
        <WorkspaceProvider>
          <HudProvider>
            <DefaultLayout>
              <DocumentRoute />
            </DefaultLayout>
          </HudProvider>
        </WorkspaceProvider>
      </DataProvider>
    </ThemeProvider>
  );
}

export default App;
