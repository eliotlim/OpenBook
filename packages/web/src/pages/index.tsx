import {useEffect, useMemo, useState} from 'react';
import Head from 'next/head';
import {HttpDataClient, getServerUrlOverride, getServerTokenOverride, type DataClient} from '@open-book/sdk';
import {
  DataProvider,
  DefaultLayout,
  DocumentArea,
  NavigationProvider,
  PlatformLibraryProvider,
  type PlatformLibrary,
} from '@open-book/ui';
import SettingsDeepLink from '@/components/SettingsDeepLink';

// By default the web app runs the data layer *in the browser* — embedded PGlite
// on IndexedDB, durable across reloads — so app.book.pub needs no backend. A
// remote server is used only when one is explicitly configured: the Server
// settings override (`openbook.serverUrl`, also how e2e points at its fixture
// server) or a build-time `NEXT_PUBLIC_OPENBOOK_SERVER`.
const REMOTE_SERVER_URL = process.env.NEXT_PUBLIC_OPENBOOK_SERVER;

// The embedded store is browser-only (PGlite WASM + IndexedDB). Open it lazily,
// once per tab: a module-level promise means React StrictMode's double-mounted
// effect (dev) can't open two PGlite instances against the same IndexedDB.
let localClientPromise: Promise<DataClient> | null = null;
function openLocalClient(): Promise<DataClient> {
  if (!localClientPromise) {
    localClientPromise = import('@open-book/server/browser').then(({createLocalDataClient}) =>
      createLocalDataClient(),
    );
  }
  return localClientPromise;
}

function useWebClient(): DataClient | null {
  const [client, setClient] = useState<DataClient | null>(null);
  useEffect(() => {
    const override = getServerUrlOverride() ?? REMOTE_SERVER_URL;
    if (override) {
      // A published server requires its access token on every request; pass the
      // configured one (Connection settings) so a token-gated remote works.
      setClient(new HttpDataClient(override, getServerTokenOverride() ?? undefined));
      return;
    }
    let cancelled = false;
    openLocalClient()
      .then((c) => {
        if (!cancelled) setClient(c);
      })
      .catch((e) => console.error('OpenBook: failed to open the local store', e));
    return () => {
      cancelled = true;
    };
  }, []);
  return client;
}

/**
 * Preview / test seam: `?shell=desktop` makes the browser render the *desktop*
 * chrome — in-window tabs plus the titlebar workspace switcher and sidebar
 * toggle — that the real Tauri shell normally owns. It lets Chromatic snapshot
 * the desktop titlebar (which `inWindowTabs` otherwise hides on the web). Read
 * after mount so the initial render still matches the server-rendered HTML.
 */
function useDesktopShellPreview(): PlatformLibrary | undefined {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('shell') !== 'desktop') return;
    setDesktop(true);
    const root = document.documentElement;
    root.style.setProperty('--ob-titlebar-height', '38px');
    root.style.setProperty('--ob-titlebar-pad-left', '8px');
    return () => {
      root.style.removeProperty('--ob-titlebar-height');
      root.style.removeProperty('--ob-titlebar-pad-left');
    };
  }, []);
  return useMemo<PlatformLibrary | undefined>(
    () =>
      desktop
        ? {tabs: {inWindow: true, openWindow: (id) => void window.open(`?page=${encodeURIComponent(id)}`, '_blank')}}
        : undefined,
    [desktop],
  );
}

export default function Home() {
  const client = useWebClient();
  const platform = useDesktopShellPreview();

  return (
    <>
      <Head>
        <title>OpenBook</title>
        <meta name="description" content="OpenBook — a local-first block workspace" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* SVG mark first (modern browsers); .ico stays as the fallback. */}
        <link rel="icon" type="image/svg+xml" href="/icon.svg" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <PlatformLibraryProvider value={platform}>
        {client && (
          <DataProvider client={client}>
            <NavigationProvider>
              <SettingsDeepLink />
              <DefaultLayout>
                <DocumentArea />
              </DefaultLayout>
            </NavigationProvider>
          </DataProvider>
        )}
      </PlatformLibraryProvider>
    </>
  );
}
