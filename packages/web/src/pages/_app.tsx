import '@/styles/globals.css';
import '@open-book/ui/style.css';
import type {AppProps} from 'next/app';
import {ErrorBoundary} from 'next/dist/client/components/error-boundary';
import {
  HudProvider,
  ThemeProvider,
  WorkspaceProvider,
} from '@open-book/ui';


export default function App({Component, pageProps}: AppProps) {
  return (
    <>
      <ErrorBoundary errorComponent={(err) => <div>Something went wrong {JSON.stringify(err.error)}</div>}>
        <ThemeProvider>
          <WorkspaceProvider>
            <HudProvider>
              <Component {...pageProps} />
            </HudProvider>
          </WorkspaceProvider>
        </ThemeProvider>
      </ErrorBoundary>
    </>
  );
}
