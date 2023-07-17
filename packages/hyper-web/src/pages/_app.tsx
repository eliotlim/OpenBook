import '@/styles/globals.css'
import type { AppProps } from 'next/app'
import {CssVarsProvider, CssBaseline} from '@mui/joy'

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <CssVarsProvider defaultMode="system">
        <CssBaseline/>
        <Component {...pageProps} />
      </CssVarsProvider>
    </>
  );
}
