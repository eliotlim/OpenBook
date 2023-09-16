import '@/styles/globals.css';
import '@hyper-hq/hyper-ui/dist/style.css';
import type { AppProps } from 'next/app';
import {CssVarsProvider, CssBaseline} from '@mui/joy';
import {ErrorBoundary} from 'next/dist/client/components/error-boundary';
import {SideNavProvider} from '@hyper-hq/hyper-ui';

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <ErrorBoundary errorComponent={(err) => <div>Something went wrong {JSON.stringify(err.error)  }</div>}>
        <CssVarsProvider defaultMode="system">
          <CssBaseline/>
          <SideNavProvider>
            <Component {...pageProps} />
          </SideNavProvider>
        </CssVarsProvider>
      </ErrorBoundary>
    </>
  );
}
