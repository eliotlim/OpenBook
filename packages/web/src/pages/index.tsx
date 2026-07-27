import {useEffect, useMemo, useState} from 'react';
import type {GetServerSideProps} from 'next';
import Head from 'next/head';
import {HttpDataClient, getServerUrlOverride, getServerTokenOverride, getIdentityCredential, onIdentityChange, onServerOverrideChange, type DataClient} from '@book.dev/sdk';
import {
  DataProvider,
  DefaultLayout,
  DocumentArea,
  NavigationProvider,
  PlatformCapabilitiesProvider,
  type PlatformCapabilities,
} from '@book.dev/ui';
import SettingsDeepLink from '@/components/SettingsDeepLink';

// By default the web app runs the data layer *in the browser* — embedded PGlite
// on IndexedDB, durable across reloads — so app.book.pub needs no backend. A
// remote server is used only when one is explicitly configured: the Server
// settings override (`openbook.serverUrl`, also how e2e points at its fixture
// server) or a build-time `NEXT_PUBLIC_OPENBOOK_SERVER`.
const REMOTE_SERVER_URL = process.env.NEXT_PUBLIC_OPENBOOK_SERVER;

// STAB-7 (LAN-hosted web UI): when the app is built as the sidecar-served static
// export (`NEXT_PUBLIC_OPENBOOK_SAMEORIGIN=1`), the data layer is the sidecar's
// OWN `/api` at this exact origin — the page was served BY the sidecar. Force the
// same-origin `HttpDataClient('')` transport (like a forwarded site), overriding
// the in-browser PGlite default, so a LAN browser reads/writes the shared library
// rather than a private per-browser store.
const SAME_ORIGIN_UI = process.env.NEXT_PUBLIC_OPENBOOK_SAMEORIGIN === '1';

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

function useWebClient(forwardedPrefix: string | null): {client: DataClient | null; browserLocal: boolean; connKey: string} {
  // `browserLocal` marks the third branch below — the embedded PGlite store that
  // lives only in this browser profile. The sharing surfaces use it to say
  // honestly that nothing outside this browser can reach the workspace (P0-4).
  // `connKey` identifies the active connection; the caller keys the DataProvider
  // subtree on it so a no-reload library switch remounts the nav providers fresh.
  const [state, setState] = useState<{client: DataClient | null; browserLocal: boolean; connKey: string}>({
    client: null,
    browserLocal: false,
    connKey: 'local',
  });
  // A no-reload library switch re-points the shared server override; re-run the
  // builder so the client swaps in place (no `window.location.reload`).
  const [overrideTick, setOverrideTick] = useState(0);
  useEffect(() => onServerOverrideChange(() => setOverrideTick((t) => t + 1)), []);
  useEffect(() => {
    // Served as a forwarded `<prefix>.book.pub` site (the edge tagged the app-shell
    // request with the site prefix): the workspace lives on the owner's instance,
    // reachable at *this* origin's /api — the edge routes it through the tunnel.
    // Same-origin (empty base), no token: the edge injects the signed viewer
    // principal. Takes precedence over a local override and the in-browser store.
    //
    // STAB-7: the sidecar-served LAN export takes the SAME same-origin branch —
    // the sidecar served this page, so its `/api` is right here. No edge injects a
    // principal on the LAN; the sidecar applies its `guestAccess` policy directly.
    // STAB-8 note: when guest writes start requiring a custom client header, it
    // plumbs into THIS `HttpDataClient`'s fetch wrapper (a `fetchImpl` that stamps
    // e.g. `X-OpenBook-Client`), not the server's static handler.
    if (forwardedPrefix || SAME_ORIGIN_UI) {
      const client = new HttpDataClient('', undefined, {getIdentity: getIdentityCredential, subscribeIdentity: onIdentityChange});
      setState({client, browserLocal: false, connKey: forwardedPrefix ? `fwd:${forwardedPrefix}` : 'same-origin'});
      return () => client.dispose();
    }
    const override = getServerUrlOverride() ?? REMOTE_SERVER_URL;
    if (override) {
      // A published server requires its access token on every request; pass the
      // configured one (Connection settings) so a token-gated remote works.
      // `subscribeIdentity` rebuilds the live nav stream when the account identity
      // refreshes / lapses, so the streamed list can't out-rank content fetches
      // (cross-server "titles show, content blank").
      const client = new HttpDataClient(override, getServerTokenOverride() ?? undefined, {
        getIdentity: getIdentityCredential,
        subscribeIdentity: onIdentityChange,
      });
      setState({client, browserLocal: false, connKey: `remote:${override}`});
      return () => client.dispose();
    }
    let cancelled = false;
    openLocalClient()
      .then((c) => {
        if (!cancelled) setState({client: c, browserLocal: true, connKey: 'local'});
      })
      .catch((e) => console.error('OpenBook: failed to open the local store', e));
    return () => {
      cancelled = true;
    };
  }, [forwardedPrefix, overrideTick]);
  return state;
}

/**
 * Preview / test seam: `?shell=desktop` makes the browser render the *desktop*
 * chrome — in-window tabs plus the titlebar workspace switcher and sidebar
 * toggle — that the real Tauri shell normally owns. It lets Chromatic snapshot
 * the desktop titlebar (which `inWindowTabs` otherwise hides on the web). Read
 * after mount so the initial render still matches the server-rendered HTML.
 */
function useDesktopShellPreview(): PlatformCapabilities | undefined {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('shell') !== 'desktop') return;
    setDesktop(true);
    const root = document.documentElement;
    root.style.setProperty('--ob-titlebar-height', '38px');
    root.style.setProperty('--ob-titlebar-pad-left', '8px');
    // Mirror the real Tauri shell (App.tsx): on the desktop the titlebar is the
    // book cover's top edge, so the sheets sit flush beneath it with no top
    // inset. Without this the preview keeps the web inset and the active tab
    // floats a gap above the page instead of merging into it.
    root.style.setProperty('--ob-inset-top', '0px');
    return () => {
      root.style.removeProperty('--ob-titlebar-height');
      root.style.removeProperty('--ob-titlebar-pad-left');
      root.style.removeProperty('--ob-inset-top');
    };
  }, []);
  return useMemo<PlatformCapabilities | undefined>(
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
function useUpdatesPreview(): PlatformCapabilities['updates'] | undefined {
  const [mode, setMode] = useState<string | null>(null);
  useEffect(() => {
    setMode(new URLSearchParams(window.location.search).get('updates'));
  }, []);
  return useMemo<PlatformCapabilities['updates']>(() => {
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
      // they count their calls so the scheduler e2e can observe them. Report a
      // staged update (true) so the scheduler's "ready → relaunch" path runs.
      downloadAndInstall: async () => {
        count('__updateInstallCalls');
        return true;
      },
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

type HomeProps = {forwardedPrefix: string | null; forwardedHost: string | null};

const forwardedPrefixGssp: GetServerSideProps<HomeProps> = async ({req}) => {
  const raw = req.headers[PREFIX_HEADER];
  const forwardedPrefix = (Array.isArray(raw) ? raw[0] : raw) || null;
  // On a forwarded site the request host is the `<prefix>.book.cloud` origin the
  // viewer is on — the label the workspace switcher shows for the connection.
  const forwardedHost = forwardedPrefix ? req.headers.host || null : null;
  return {props: {forwardedPrefix, forwardedHost}};
};

// STAB-7: a static export (`output: 'export'`) can't run `getServerSideProps`, so
// it's dropped in the LAN same-origin build — Next treats a non-function export as
// absent. The forwarded-prefix header only exists behind the *.book.cloud edge,
// which the LAN never has, so there is nothing to read there anyway. Home defaults
// both props to null and takes its same-origin path from `SAME_ORIGIN_UI` instead.
export const getServerSideProps = SAME_ORIGIN_UI ? undefined : forwardedPrefixGssp;

export default function Home({forwardedPrefix = null, forwardedHost = null}: Partial<HomeProps> = {}) {
  const {client, browserLocal, connKey} = useWebClient(forwardedPrefix);
  const shellPreview = useDesktopShellPreview();
  const updatesPreview = useUpdatesPreview();
  // Tell the UI when the workspace is the in-browser store (nothing outside this
  // browser can reach it) so the sharing surfaces annotate themselves honestly.
  // Merged over the desktop-shell preview: even under `?shell=desktop` the data
  // is still browser-local, so the truth flag stays. On a forwarded site pass the
  // host so the workspace switcher names the connection after it (P-fwd), rather
  // than the generic local default.
  const platform = useMemo<PlatformCapabilities | undefined>(() => {
    const base = browserLocal ? {...shellPreview, browserLocalLibrary: true} : shellPreview;
    const withHost = forwardedHost ? {...(base ?? {}), forwardedHost} : base;
    // STAB-9: the sidecar-served LAN build (`NEXT_PUBLIC_OPENBOOK_SAMEORIGIN=1`)
    // renders for a network guest, not the owner — tell the UI so it hides the
    // sign-in chrome (unsupported over plain-LAN) and relabels the library. A
    // build-time constant, so it never changes across renders.
    const withServed = SAME_ORIGIN_UI ? {...(withHost ?? {}), servedSameOrigin: true} : withHost;
    if (!updatesPreview) return withServed;
    return {...(withServed ?? {}), updates: updatesPreview};
  }, [browserLocal, shellPreview, forwardedHost, updatesPreview]);

  return (
    <>
      <Head>
        <title>OpenBook</title>
        <meta name="description" content="OpenBook — a local-first block library" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* SVG mark first (modern browsers); .ico stays as the fallback. */}
        <link rel="icon" type="image/svg+xml" href="/icon.svg" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <PlatformCapabilitiesProvider value={platform}>
        {client && (
          // Key the data subtree on the active connection so a no-reload library
          // switch (a re-pointed server override) remounts the nav providers fresh
          // against the new client — its one-shot init re-lists the new library.
          <DataProvider key={connKey} client={client}>
            <NavigationProvider>
              <SettingsDeepLink />
              <DefaultLayout>
                <DocumentArea />
              </DefaultLayout>
            </NavigationProvider>
          </DataProvider>
        )}
      </PlatformCapabilitiesProvider>
    </>
  );
}
