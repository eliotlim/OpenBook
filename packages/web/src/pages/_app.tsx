import '@/styles/globals.css';
import '@book.dev/ui/style.css';
import type {AppProps} from 'next/app';
import {useRouter} from 'next/router';
import {ErrorBoundary} from 'next/dist/client/components/error-boundary';
import {
  AccountProvider,
  HudProvider,
  I18nProvider,
  PreferencesProvider,
  ThemeProvider,
  WorkspaceProvider,
} from '@book.dev/ui';


export default function App({Component, pageProps}: AppProps) {
  // The account sign-in callback is a transient popup/redirect that only hands a
  // token back to the running app — render it bare, outside the provider stack,
  // so it doesn't spin up a second AccountProvider that races the real one.
  const router = useRouter();
  if (router.pathname === '/account/callback') return <Component {...pageProps} />;

  return (
    <>
      <ErrorBoundary errorComponent={(err) => <div>Something went wrong {JSON.stringify(err.error)}</div>}>
        <ThemeProvider>
          <I18nProvider>
            <PreferencesProvider>
              <WorkspaceProvider>
                <AccountProvider>
                  <HudProvider>
                    <Component {...pageProps} />
                  </HudProvider>
                </AccountProvider>
              </WorkspaceProvider>
            </PreferencesProvider>
          </I18nProvider>
        </ThemeProvider>
      </ErrorBoundary>
    </>
  );
}
