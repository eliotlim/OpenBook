import {useEffect, useMemo, useState} from 'react';
import Head from 'next/head';
import {HttpDataClient, getServerUrlOverride} from '@open-book/sdk';
import {
  DataProvider,
  DefaultLayout,
  DocumentArea,
  NavigationProvider,
  PlatformLibraryProvider,
  type PlatformLibrary,
} from '@open-book/ui';
import SettingsDeepLink from '@/components/SettingsDeepLink';

// The web shell always talks to a server: the one it was built against, or an
// override configured via the Server settings.
const DEFAULT_SERVER_URL = process.env.NEXT_PUBLIC_OPENBOOK_SERVER ?? 'http://localhost:4319';

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
  const client = useMemo(() => new HttpDataClient(getServerUrlOverride() ?? DEFAULT_SERVER_URL), []);
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
        <DataProvider client={client}>
          <NavigationProvider>
            <SettingsDeepLink />
            <DefaultLayout>
              <DocumentArea />
            </DefaultLayout>
          </NavigationProvider>
        </DataProvider>
      </PlatformLibraryProvider>
    </>
  );
}
