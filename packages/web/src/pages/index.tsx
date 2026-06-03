import {useMemo} from 'react';
import Head from 'next/head';
import {HttpDataClient, getServerUrlOverride} from '@open-book/sdk';
import {
  ConnectedPageDocument,
  DataProvider,
  DefaultLayout,
  NavigationProvider,
  PlatformLibraryProvider,
  useNavigation,
} from '@open-book/ui';
import SettingsDeepLink from '@/components/SettingsDeepLink';

// The web shell always talks to a server: the one it was built against, or an
// override configured via the Server settings.
const DEFAULT_SERVER_URL = process.env.NEXT_PUBLIC_OPENBOOK_SERVER ?? 'http://localhost:4319';

function DocumentRoute() {
  const {currentPageId, loading} = useNavigation();
  if (loading || !currentPageId) return null;
  return <ConnectedPageDocument pageId={currentPageId} />;
}

export default function Home() {
  const client = useMemo(() => new HttpDataClient(getServerUrlOverride() ?? DEFAULT_SERVER_URL), []);

  return (
    <>
      <Head>
        <title>OpenBook</title>
        <meta name="description" content="OpenBook" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <PlatformLibraryProvider>
        <DataProvider client={client}>
          <NavigationProvider>
            <SettingsDeepLink />
            <DefaultLayout>
              <DocumentRoute />
            </DefaultLayout>
          </NavigationProvider>
        </DataProvider>
      </PlatformLibraryProvider>
    </>
  );
}
