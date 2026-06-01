import {useMemo} from 'react';
import Head from 'next/head';
import {HttpDataClient} from '@open-book/sdk';
import {ConnectedPageDocument, DataProvider, DefaultLayout, useCurrentPageId} from '@open-book/ui';

// The web shell has no local storage of its own — it always talks to an
// OpenBook server (a headless deployment, or a desktop install acting as a
// server). Configure via NEXT_PUBLIC_OPENBOOK_SERVER.
const SERVER_URL = process.env.NEXT_PUBLIC_OPENBOOK_SERVER ?? 'http://localhost:4319';

export default function Home() {
  const client = useMemo(() => new HttpDataClient(SERVER_URL), []);
  const pageId = useCurrentPageId();

  return (
    <>
      <Head>
        <title>OpenBook</title>
        <meta name="description" content="OpenBook" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <DataProvider client={client}>
        <DefaultLayout>{pageId ? <ConnectedPageDocument pageId={pageId} /> : null}</DefaultLayout>
      </DataProvider>
    </>
  );
}
