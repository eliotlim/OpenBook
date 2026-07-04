import {useEffect, useMemo, useState} from 'react';
import type {GetServerSideProps, InferGetServerSidePropsType} from 'next';
import Head from 'next/head';
import {HttpDataClient, getServerUrlOverride, getServerTokenOverride, getIdentityCredential, type DataClient} from '@book.dev/sdk';
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

function useWebClient(forwardedPrefix: string | null): {client: DataClient | null; browserLocal: boolean} {
  // `browserLocal` marks the third branch below — the embedded PGlite store that
  // lives only in this browser profile. The sharing surfaces use it to say
  // honestly that nothing outside this browser can reach the workspace (P0-4).
  const [state, setState] = useState<{client: DataClient | null; browserLocal: boolean}>({
    client: null,
    browserLocal: false,
  });
  useEffect(() => {
    // Served as a forwarded `<prefix>.book.pub` site (the edge tagged the app-shell
    // request with the site prefix): the workspace lives on the owner's instance,
    // reachable at *this* origin's /api — the edge routes it through the tunnel.
    // Same-origin (empty base), no token: the edge injects the signed viewer
    // principal. Takes precedence over a local override and the in-browser store.
    if (forwardedPrefix) {
      setState({client: new HttpDataClient('', undefined, {getIdentity: getIdentityCredential}), browserLocal: false});
      return;
    }
    const override = getServerUrlOverride() ?? REMOTE_SERVER_URL;
    if (override) {
      // A published server requires its access token on every request; pass the
      // configured one (Connection settings) so a token-gated remote works.
      setState({
        client: new HttpDataClient(override, getServerTokenOverride() ?? undefined, {getIdentity: getIdentityCredential}),
        browserLocal: false,
      });
      return;
    }
    let cancelled = false;
    openLocalClient()
      .then((c) => {
        if (!cancelled) setState({client: c, browserLocal: true});
      })
      .catch((e) => console.error('OpenBook: failed to open the local store', e));
    return () => {
      cancelled = true;
    };
  }, [forwardedPrefix]);
  return state;
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

/**
 * Preview / test seam for the desktop-only updates section. The real self-update
 * capability is supplied by the Tauri shell; the web app can't self-update, so
 * the section is normally absent here. `?updates=<outcome>` injects a *mock*
 * `updates` capability so the section can be exercised in the browser (Chromatic
 * / e2e): `available` → an update is offered, `security` → a security update,
 * `major` → the current line is current but a newer major exists, `error` → the
 * check fails, anything else → up to date. Read after mount so the
 * initial render still matches the server-rendered HTML. Never active without
 * the query flag, so production stays update-free on the web.
 */
function useUpdatesPreview(): PlatformLibrary['updates'] | undefined {
  const [mode, setMode] = useState<string | null>(null);
  useEffect(() => {
    setMode(new URLSearchParams(window.location.search).get('updates'));
  }, []);
  return useMemo<PlatformLibrary['updates']>(() => {
    if (!mode) return undefined;
    // e2e observability: the scheduler's background activity has no DOM of its
    // own, so the mock counts its calls on `window` for the specs to assert on
    // (e.g. "cadence never → zero checks"). Harmless outside tests — the seam
    // only exists behind the explicit `?updates=` flag.
    const count = (key: string): void => {
      const w = window as unknown as Record<string, unknown>;
      w[key] = ((w[key] as number | undefined) ?? 0) + 1;
    };
    return {
      getAppVersion: async () => '1.69.1',
      checkForUpdate: async () => {
        count('__updateCheckCalls');
        if (mode === 'available') return {status: 'update-available', latestVersion: '1.72.0', latestForCurrentMajor: '1.72.0'};
        if (mode === 'security')
          return {
            status: 'update-available',
            latestVersion: '1.72.0',
            latestForCurrentMajor: '1.72.0',
            security: {updateAvailable: true, fixedIn: '1.72.0'},
          };
        if (mode === 'major')
          // How the check API shapes a major-only bump: the current line is
          // current (→ up-to-date) with the newer major riding along.
          return {
            status: 'up-to-date',
            latestVersion: '1.69.1',
            latestForCurrentMajor: '1.69.1',
            latestMajor: '2.3.0',
          };
        if (mode === 'error') return {status: 'error', error: 'mock'};
        return {status: 'up-to-date'};
      },
      // Install/relaunch are inert in the browser preview — there's no Tauri
      // updater to drive (the real ones only run in the desktop shell) — but
      // they count their calls so the scheduler e2e can observe them.
      downloadAndInstall: async () => count('__updateInstallCalls'),
      relaunch: async () => count('__updateRelaunchCalls'),
    };
  }, [mode]);
}

// The forwarding edge tags a `<prefix>.book.pub` app-shell request with the site
// prefix (open.book.pub's edge `PREFIX_HEADER`). It's a request header, so it's only
// visible server-side — read it here and hand it to the client, which uses it to pick
// the same-origin /api transport (the owner's instance via the tunnel) over the
// in-browser store. Absent on the canonical app.book.pub, so that stays local-first.
const PREFIX_HEADER = 'x-openbook-prefix';

export const getServerSideProps: GetServerSideProps<{
  forwardedPrefix: string | null;
  forwardedHost: string | null;
}> = async ({req}) => {
  const raw = req.headers[PREFIX_HEADER];
  const forwardedPrefix = (Array.isArray(raw) ? raw[0] : raw) || null;
  // On a forwarded site the request host is the `<prefix>.book.cloud` origin the
  // viewer is on — the label the workspace switcher shows for the connection.
  const forwardedHost = forwardedPrefix ? req.headers.host || null : null;
  return {props: {forwardedPrefix, forwardedHost}};
};

export default function Home({forwardedPrefix, forwardedHost}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const {client, browserLocal} = useWebClient(forwardedPrefix);
  const shellPreview = useDesktopShellPreview();
  const updatesPreview = useUpdatesPreview();
  // Tell the UI when the workspace is the in-browser store (nothing outside this
  // browser can reach it) so the sharing surfaces annotate themselves honestly.
  // Merged over the desktop-shell preview: even under `?shell=desktop` the data
  // is still browser-local, so the truth flag stays. On a forwarded site pass the
  // host so the workspace switcher names the connection after it (P-fwd), rather
  // than the generic local default.
  const platform = useMemo<PlatformLibrary | undefined>(() => {
    const base = browserLocal ? {...shellPreview, browserLocalWorkspace: true} : shellPreview;
    const withHost = forwardedHost ? {...(base ?? {}), forwardedHost} : base;
    if (!updatesPreview) return withHost;
    return {...(withHost ?? {}), updates: updatesPreview};
  }, [browserLocal, shellPreview, forwardedHost, updatesPreview]);

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
