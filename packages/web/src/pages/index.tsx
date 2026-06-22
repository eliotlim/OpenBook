import {useEffect, useMemo, useState} from 'react';
import type {GetServerSideProps, InferGetServerSidePropsType} from 'next';
import Head from 'next/head';
import {HttpDataClient, getServerUrlOverride, getServerTokenOverride, type DataClient} from '@book.dev/sdk';
import {
  DataProvider,
  DefaultLayout,
  DocumentArea,
  NavigationProvider,
  PlatformLibraryProvider,
  type PlatformLibrary,
} from '@book.dev/ui';
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
    localClientPromise = import('@book.dev/server/browser').then(({createLocalDataClient}) =>
      createLocalDataClient(),
    );
  }
  return localClientPromise;
}

function useWebClient(forwardedPrefix: string | null): DataClient | null {
  const [client, setClient] = useState<DataClient | null>(null);
  useEffect(() => {
    // Served as a forwarded `<prefix>.book.pub` site (the edge tagged the app-shell
    // request with the site prefix): the workspace lives on the owner's instance,
    // reachable at *this* origin's /api — the edge routes it through the tunnel.
    // Same-origin (empty base), no token: the edge injects the signed viewer
    // principal. Takes precedence over a local override and the in-browser store.
    if (forwardedPrefix) {
      setClient(new HttpDataClient(''));
      return;
    }
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
  }, [forwardedPrefix]);
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

// The forwarding edge tags a `<prefix>.book.pub` app-shell request with the site
// prefix (open.book.pub's edge `PREFIX_HEADER`). It's a request header, so it's only
// visible server-side — read it here and hand it to the client, which uses it to pick
// the same-origin /api transport (the owner's instance via the tunnel) over the
// in-browser store. Absent on the canonical app.book.pub, so that stays local-first.
const PREFIX_HEADER = 'x-openbook-prefix';

export const getServerSideProps: GetServerSideProps<{forwardedPrefix: string | null}> = async ({req}) => {
  const raw = req.headers[PREFIX_HEADER];
  const forwardedPrefix = (Array.isArray(raw) ? raw[0] : raw) || null;
  return {props: {forwardedPrefix}};
};

export default function Home({forwardedPrefix}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const client = useWebClient(forwardedPrefix);
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
