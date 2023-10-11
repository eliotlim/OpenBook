import React from 'react';
import {
  DefaultLayout,
  PageDocument,
  SideNavProvider,
  ThemeProvider
} from '@hyper-hq/hyper-ui';

import '@hyper-hq/hyper-ui/style.css';

function App() {

  return (
    <ThemeProvider>
      <SideNavProvider>
        <DefaultLayout>
          <PageDocument/>
        </DefaultLayout>
      </SideNavProvider>
    </ThemeProvider>
  );
}

export default App;
