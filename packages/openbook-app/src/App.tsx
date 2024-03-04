import React from 'react';
import {
  DefaultLayout,
  HudProvider,
  PageDocument,
  ThemeProvider,
  WorkspaceProvider,
} from '@bookhq/openbook-ui';

import '@bookhq/openbook-ui/style.css';

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
