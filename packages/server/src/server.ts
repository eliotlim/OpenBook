import {serve} from '@hono/node-server';
import type {PGliteOptions} from '@electric-sql/pglite';
import {createApp} from './app';
import {type Db, createPgliteDb, PostgresDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {BookMirror} from './mirror';
import {AiService} from './ai/service';
import {writeFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
  /**
   * How long a soft-deleted page stays in the trash before the cleanup job
   * purges it, in milliseconds. Defaults to 30 days. `0` purges on the next
   * sweep (no retention).
   */
  trashRetentionMs?: number;
  /**
   * How often the trash cleanup job runs, in milliseconds. Defaults to 1 hour.
   * `<= 0` disables the job (trash is kept until emptied manually).
   */
  trashCleanupIntervalMs?: number;
  /**
   * When set, mirror the workspace to a folder of HTML book files at this path
   * (one folder per book) in near-realtime, watch it for external edits, and
   * re-import changes (DB-wins on conflict). Off when unset. See {@link BookMirror}.
   */
  bookDir?: string;
  /**
   * When set, require this access token on every `/api/*` request (header or
   * `?token=`). Used when the desktop publishes its server on the LAN so the
   * unauthenticated workspace isn't open to anyone who can reach the port.
   */
  accessToken?: string;
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
const DEFAULT_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_TRASH_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

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
    db = await createPgliteDb(opts.dataDir, opts.pgliteAssets);
  }

  const store = new PageStore(db);
  await store.migrate();

  // Trash cleanup job: periodically purge pages whose `deleted_at` is older than
  // the retention window. Runs once on boot to catch up after downtime, then on
  // an interval. The timer is `unref`'d so it never keeps the process alive.
  const retentionMs = opts.trashRetentionMs ?? DEFAULT_TRASH_RETENTION_MS;
  const cleanupIntervalMs = opts.trashCleanupIntervalMs ?? DEFAULT_TRASH_CLEANUP_INTERVAL_MS;
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;
  const sweepTrash = async (): Promise<void> => {
    try {
      const purged = await store.purgeExpired(retentionMs);
      if (purged > 0) console.log(`OpenBook trash cleanup: purged ${purged} expired page(s)`);
    } catch (err) {
      console.error('OpenBook trash cleanup failed:', err);
    }
  };
  if (cleanupIntervalMs > 0) {
    await sweepTrash();
    cleanupTimer = setInterval(() => void sweepTrash(), cleanupIntervalMs);
    cleanupTimer.unref?.();
  }

  // Local-AI models live next to the data (desktop) or under the home dir
  // (server mode). The subsystem is inert until configured via /api/ai.
  const modelsDir = process.env.OPENBOOK_MODELS_DIR
    || (opts.dataDir ? path.join(opts.dataDir, 'models') : path.join(os.homedir(), '.openbook', 'models'));
  const ai = new AiService(db, modelsDir);

  // One hub is shared between the HTTP/SSE app and the disk mirror, so a
  // re-imported page fans out to every connected client too.
  const hub = new PageHub();
  const app = createApp(store, ai, hub, {accessToken: opts.accessToken});
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;

  let server!: NodeServer;
  const info = await new Promise<{port: number}>((resolve) => {
    server = serve({fetch: app.fetch, hostname: host, port}, (addr) => resolve(addr));
  });

  const clientHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${clientHost}:${info.port}`;

  // Advertise the bound address (+ this process) for discovery and stale-lock
  // detection. Written under the data dir (embedded mode only) and removed on a
  // clean exit; a leftover file whose `pid` is dead marks a crashed prior run.
  const infoFile = opts.dataDir ? path.join(opts.dataDir, 'server.json') : null;
  if (infoFile) {
    try {
      writeFileSync(infoFile, JSON.stringify({url, port: info.port, pid: process.pid, startedAt: new Date().toISOString()}));
    } catch (err) {
      console.error('OpenBook: could not write server.json discovery file:', err);
    }
  }

  // On-disk book-file mirror: write-through + watch + re-import (OB-134/135/136).
  let mirror: BookMirror | null = null;
  let mirrorUnsub: (() => void) | null = null;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  if (opts.bookDir) {
    mirror = await BookMirror.create({
      store,
      dir: opts.bookDir,
      // A re-imported page must reach open clients, so publish it on the hub.
      onImported: async (page) => {
        hub.publishPage(page);
        hub.publishList(await store.listPages());
      },
      log: (m) => console.log(`[book-mirror] ${m}`),
    });
    const scheduleReconcile = (): void => {
      if (reconcileTimer) return;
      reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        void mirror?.reconcileAll();
      }, 2000);
      reconcileTimer.unref?.();
    };
    // Fast path: a saved page is mirrored immediately. Structural changes
    // (deletes, moves, renames, row-property edits) ride a debounced reconcile,
    // which diffs every page's updatedAt against what's on disk.
    mirrorUnsub = hub.subscribeLive((event) => {
      if (event.type === 'page') mirror!.enqueueWrite(event.page.id);
      else if (event.type === 'deleted') {
        mirror!.enqueueDelete(event.id);
        scheduleReconcile();
      } else if (event.type === 'list') scheduleReconcile();
    });
  }

  return {
    url,
    address: `${host}:${info.port}`,
    close: async () => {
      await ai.dispose();
      if (cleanupTimer) clearInterval(cleanupTimer);
      if (reconcileTimer) clearTimeout(reconcileTimer);
      // Stop accepting requests first so no new writes arrive mid-shutdown.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Flush-on-exit (OB-132): drain the mirror journal before the store closes,
      // so no committed write is lost. The mirror still needs the store to render.
      mirrorUnsub?.();
      if (mirror) await mirror.close();
      await store.close();
      if (infoFile) rmSync(infoFile, {force: true});
    },
  };
}
