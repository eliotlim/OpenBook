import '@/styles/globals.css';
import '@hyper-hq/hyper-ui/style.css';
import type { AppProps } from 'next/app';
import {ErrorBoundary} from 'next/dist/client/components/error-boundary';
import {
  HudProvider,
  ThemeProvider
} from '@hyper-hq/hyper-ui';


export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <ErrorBoundary errorComponent={(err) => <div>Something went wrong {JSON.stringify(err.error)  }</div>}>
        <ThemeProvider>
          <HudProvider>
            <Component {...pageProps} />
          </HudProvider>
        </ThemeProvider>
      </ErrorBoundary>
    </>
  );
}
