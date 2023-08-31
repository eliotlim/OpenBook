import '@/styles/globals.css'
import type { AppProps } from 'next/app'
import {ErrorBoundary} from "next/dist/client/components/error-boundary";
import {Theme} from "@radix-ui/themes";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <ErrorBoundary errorComponent={(err) => <div>Something went wrong {JSON.stringify(err.error)  }</div>}>
        <Theme>
          <Component {...pageProps} />
        </Theme>
      </ErrorBoundary>
    </>
  );
}
