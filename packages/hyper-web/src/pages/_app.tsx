import '@radix-ui/themes/styles.css';
import type {AppProps} from 'next/app'
import {ErrorBoundary} from "next/dist/client/components/error-boundary";
import {Theme} from "@radix-ui/themes";
import {ThemeProvider} from "next-themes";

export default function App({Component, pageProps}: AppProps) {
  return (
    <>
      <ErrorBoundary errorComponent={(err) => <div>Something went wrong {JSON.stringify(err.error)}</div>}>
        <ThemeProvider attribute="class">
          <Theme>
            <Component {...pageProps} />
          </Theme>
        </ThemeProvider>
      </ErrorBoundary>
    </>
  );
}
