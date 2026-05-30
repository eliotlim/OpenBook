import React, {useCallback} from 'react';
import {
  DefaultLayout,
  HudProvider,
  PageDocument,
  ThemeProvider,
  WorkspaceProvider,
  type PageSnapshot,
} from '@open-book/ui';
import {BaseDirectory, createDir, exists, readTextFile, writeTextFile} from '@tauri-apps/api/fs';

import '@open-book/ui/style.css';

// Single-document v0: one save file per OpenBook install, stored in the
// Tauri-managed AppData directory.
const SAVE_PATH = 'page.json';
const SAVE_OPTS = {dir: BaseDirectory.AppData} as const;

function App() {
  const handleSave = useCallback(async (snap: PageSnapshot) => {
    // Ensure AppData dir exists (first save on a fresh install).
    try {
      await createDir('', {...SAVE_OPTS, recursive: true});
    } catch {
      // Already exists; ignore.
    }
    await writeTextFile(SAVE_PATH, JSON.stringify(snap, null, 2), SAVE_OPTS);
  }, []);

  const handleLoad = useCallback(async (): Promise<PageSnapshot | null> => {
    const there = await exists(SAVE_PATH, SAVE_OPTS).catch(() => false);
    if (!there) return null;
    try {
      const text = await readTextFile(SAVE_PATH, SAVE_OPTS);
      return JSON.parse(text) as PageSnapshot;
    } catch (e) {
      console.error('App: failed to read save file:', e);
      return null;
    }
  }, []);

  return (
    <ThemeProvider>
      <WorkspaceProvider>
        <HudProvider>
          <DefaultLayout>
            <PageDocument onSave={handleSave} onLoad={handleLoad} />
          </DefaultLayout>
        </HudProvider>
      </WorkspaceProvider>
    </ThemeProvider>
  );
}

export default App;
