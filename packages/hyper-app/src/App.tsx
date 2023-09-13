import React from 'react';
import {DefaultLayout, PageDocument, SideNavProvider} from '@hyper-hq/hyper-ui';
import {CssBaseline, CssVarsProvider} from '@mui/joy';

function App() {

  return (
    <CssVarsProvider defaultMode="system">
      <CssBaseline/>
      <SideNavProvider>
        <DefaultLayout>
          <PageDocument/>
        </DefaultLayout>
      </SideNavProvider>
    </CssVarsProvider>
  );
}

export default App;
