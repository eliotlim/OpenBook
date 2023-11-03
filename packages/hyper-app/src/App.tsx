import React from 'react';
import {
  DefaultLayout,
  HudProvider,
  PageDocument,
  ThemeProvider,
  WorkspaceProvider,
} from '@hyper-hq/hyper-ui';

import '@hyper-hq/hyper-ui/style.css';

function App() {

  return (
    <ThemeProvider>
      <WorkspaceProvider>
        <HudProvider>
          <DefaultLayout>
            <PageDocument/>
          </DefaultLayout>
        </HudProvider>
      </WorkspaceProvider>

    </ThemeProvider>
  );
}

export default App;
