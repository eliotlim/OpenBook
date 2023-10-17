import React from 'react';
import {
  DefaultLayout,
  PageDocument,
  HudProvider,
  ThemeProvider
} from '@hyper-hq/hyper-ui';

import '@hyper-hq/hyper-ui/style.css';

function App() {

  return (
    <ThemeProvider>
      <HudProvider>
        <DefaultLayout>
          <PageDocument/>
        </DefaultLayout>
      </HudProvider>
    </ThemeProvider>
  );
}

export default App;
