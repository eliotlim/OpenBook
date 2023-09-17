import '@/styles/globals.css';
import '@hyper-hq/hyper-ui/dist/style.css';
import type { AppProps } from 'next/app';
import {ErrorBoundary} from 'next/dist/client/components/error-boundary';
import {
  SideNavProvider,
  ThemeProvider
} from '@hyper-hq/hyper-ui';


export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <ErrorBoundary errorComponent={(err) => <div>Something went wrong {JSON.stringify(err.error)  }</div>}>
        <ThemeProvider>
          <SideNavProvider>
            <Component {...pageProps} />
          </SideNavProvider>
        </ThemeProvider>
      </ErrorBoundary>
    </>
  );
}
