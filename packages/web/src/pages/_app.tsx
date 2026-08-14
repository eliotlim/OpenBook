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
  LibraryProvider,
  t,
} from '@book.dev/ui';


export default function App({Component, pageProps}: AppProps) {
  // The account sign-in callback is a transient popup/redirect that only hands a
  // token back to the running app — render it bare, outside the provider stack,
  // so it doesn't spin up a second AccountProvider that races the real one.
  const router = useRouter();
  if (router.pathname === '/account/callback') return <Component {...pageProps} />;
  if (!(pageProps as {publicForm?: unknown}).publicForm && !router.isReady) return null;

  // The public database-form query is a pre-auth shell route. Keep it outside
  // Library/Account/Hud providers so opening a fill capability cannot initialize
  // navigation, search, page lists, or sign-in chrome before rendering the form.
  const publicForm = Boolean(
    (pageProps as {publicForm?: unknown}).publicForm
    || (typeof router.query.form === 'string' && typeof router.query.view === 'string')
    || (typeof window !== 'undefined' && (() => {
      const params = new URLSearchParams(window.location.search);
      return Boolean(params.get('form') && params.get('view'));
    })()),
  );
  if (publicForm) {
    return (
      <ErrorBoundary
        errorComponent={() => <div role="alert">{t('database.publicForm.unavailableDescription')}</div>}
      >
        <ThemeProvider>
          <I18nProvider>
            <Component {...pageProps} />
          </I18nProvider>
        </ThemeProvider>
      </ErrorBoundary>
    );
  }

  return (
    <>
      <ErrorBoundary
        errorComponent={() => (
          <div role="alert">
            <strong>{t('errorBoundary.title')}</strong>
            <p>{t('errorBoundary.message')}</p>
          </div>
        )}
      >
        <ThemeProvider>
          <I18nProvider>
            <PreferencesProvider>
              <LibraryProvider>
                <AccountProvider>
                  <HudProvider>
                    <Component {...pageProps} />
                  </HudProvider>
                </AccountProvider>
              </LibraryProvider>
            </PreferencesProvider>
          </I18nProvider>
        </ThemeProvider>
      </ErrorBoundary>
    </>
  );
}
