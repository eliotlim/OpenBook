import '@/styles/globals.css'
import type { AppProps } from 'next/app'
import {CssVarsProvider, CssBaseline} from '@mui/joy'
import {ErrorBoundary} from "next/dist/client/components/error-boundary";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <ErrorBoundary errorComponent={(err) => <div>Something went wrong {JSON.stringify(err.error)  }</div>}>
      <CssVarsProvider defaultMode="system">
        <CssBaseline/>
        <Component {...pageProps} />
      </CssVarsProvider>
      </ErrorBoundary>
    </>
  );
}
