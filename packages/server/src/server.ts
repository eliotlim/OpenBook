import {serve} from '@hono/node-server';
import {createApp} from './app';
import {startEmbeddedPostgres, type EmbeddedHandle} from './embedded';
import {PageStore} from './store';

export interface StartOptions {
  /** Connection string for an external Postgres (server mode). */
  databaseUrl?: string;
  /** Data directory for embedded Postgres (desktop mode). Required if no `databaseUrl`. */
  dataDir?: string;
  /** Port for the embedded Postgres cluster. */
  embeddedPort?: number;
  /** HTTP listen host. Defaults to `127.0.0.1`. */
  host?: string;
  /** HTTP listen port. Defaults to `4319`. */
  port?: number;
}

export interface RunningServer {
  /** Base URL clients connect to. */
  url: string;
  /** Bound `host:port`. */
  address: string;
  /** Stop the HTTP server, close the pool, and stop embedded Postgres. */
  close: () => Promise<void>;
}

type NodeServer = ReturnType<typeof serve>;

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4319;

/**
 * Start the OpenBook server. This is the single entry both deployment modes use:
 *
 *  - **embedded** (desktop): no `databaseUrl` → boot embedded Postgres under
 *    `dataDir` and use its URL.
 *  - **server** (headless): `databaseUrl` is provided → connect to it.
 *
 * Either way the same store, migrations, and HTTP API run.
 */
export async function startServer(opts: StartOptions): Promise<RunningServer> {
  let databaseUrl = opts.databaseUrl;
  let embedded: EmbeddedHandle | undefined;

  if (!databaseUrl) {
    if (!opts.dataDir) {
      throw new Error('startServer: provide either `databaseUrl` (server) or `dataDir` (embedded)');
    }
    embedded = await startEmbeddedPostgres(opts.dataDir, opts.embeddedPort);
    databaseUrl = embedded.url;
  }

  const store = new PageStore(databaseUrl);
  await store.migrate();

  const app = createApp(store);
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;

  // serve() starts listening asynchronously; resolve once the listener is up.
  let server!: NodeServer;
  const info = await new Promise<{port: number}>((resolve) => {
    server = serve({fetch: app.fetch, hostname: host, port}, (addr) => resolve(addr));
  });

  // 0.0.0.0 isn't a routable client address; report loopback for the local URL.
  const clientHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${clientHost}:${info.port}`;

  return {
    url,
    address: `${host}:${info.port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
      if (embedded) await embedded.stop();
    },
  };
}
