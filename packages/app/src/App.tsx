import React from 'react';
import {
  DefaultLayout,
  HudProvider,
  PageDocument,
  ThemeProvider,
  WorkspaceProvider,
} from '@open-book/ui';

import '@open-book/ui/style.css';

function App() {
  return (
    <ThemeProvider>
      <WorkspaceProvider>
        <HudProvider>
          <DefaultLayout>
            <PageDocument />
          </DefaultLayout>
        </HudProvider>
      </WorkspaceProvider>
    </ThemeProvider>
  );
}

export default App;
