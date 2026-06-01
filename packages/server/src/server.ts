import {serve} from '@hono/node-server';
import type {PGliteOptions} from '@electric-sql/pglite';
import {createApp} from './app';
import {type Db, PgliteDb, PostgresDb} from './db';
import {PageStore} from './store';

export interface StartOptions {
  /** Connection string for an external Postgres (server mode). */
  databaseUrl?: string;
  /** Data directory for embedded PGlite (desktop mode). Required if no `databaseUrl`. */
  dataDir?: string;
  /**
   * PGlite WASM/data overrides. The compiled desktop sidecar passes embedded
   * assets here; under Node this is omitted and PGlite loads its own.
   */
  pgliteAssets?: Partial<PGliteOptions>;
  /** HTTP listen host. Defaults to `127.0.0.1`. */
  host?: string;
  /** HTTP listen port. Defaults to `4319`. */
  port?: number;
  /** Max Postgres connections (server mode only). Defaults to 10. */
  poolMax?: number;
}

export interface RunningServer {
  /** Base URL clients connect to. */
  url: string;
  /** Bound `host:port`. */
  address: string;
  /** Stop the HTTP server and release the database. */
  close: () => Promise<void>;
}

type NodeServer = ReturnType<typeof serve>;

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4319;

/**
 * Start the OpenBook server. The single entry both modes use:
 *  - **embedded** (desktop): no `databaseUrl` → open embedded PGlite under `dataDir`.
 *  - **server** (headless): `databaseUrl` → connect to external Postgres.
 *
 * Same store, migrations, and HTTP API either way.
 */
export async function startServer(opts: StartOptions): Promise<RunningServer> {
  let db: Db;
  if (opts.databaseUrl) {
    db = new PostgresDb(opts.databaseUrl, {max: opts.poolMax});
  } else {
    if (!opts.dataDir) {
      throw new Error('startServer: provide either `databaseUrl` (server) or `dataDir` (embedded)');
    }
    db = await PgliteDb.create(opts.dataDir, opts.pgliteAssets);
  }

  const store = new PageStore(db);
  await store.migrate();

  const app = createApp(store);
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;

  let server!: NodeServer;
  const info = await new Promise<{port: number}>((resolve) => {
    server = serve({fetch: app.fetch, hostname: host, port}, (addr) => resolve(addr));
  });

  const clientHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${clientHost}:${info.port}`;

  return {
    url,
    address: `${host}:${info.port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
    },
  };
}
