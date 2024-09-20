import Head from 'next/head';
import {
  DefaultLayout,
  PageDocument
} from '@open-book/ui';

export default function Home() {

  return (
    <>
      <Head>
        <title>hyper-web</title>
        <meta name="description" content="hyper-web"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <link rel="icon" href="/favicon.ico"/>
      </Head>
      <DefaultLayout>
        <PageDocument/>
      </DefaultLayout>
    </>
  );
}
