import {PgliteDb} from './dbCore';
import {PageStore} from './store';
import {LocalDataClient} from './localClient';

/**
 * `@book.dev/server/browser` — the embedded data layer that runs *inside* the
 * app/web webview. It carries no Node imports (no `node:fs`, no `postgres`), so
 * a browser bundler can ship it: an embedded PGlite store + an in-process
 * {@link LocalDataClient} speaking the same {@link DataClient} contract the
 * HTTP client does. The desktop runs this by default (no local port); the web
 * app runs it at `app.book.pub`. A real local port is opened only when a desktop
 * user chooses to publish/forward their instance.
 */

export interface BrowserStoreOptions {
  /**
   * PGlite `dataDir`. Defaults to `idb://openbook` — durable IndexedDB storage
   * that survives reloads and relaunches. Pass `memory://` for an ephemeral
   * store (tests, throwaway sessions).
   */
  dataDir?: string;
}

const DEFAULT_DATA_DIR = 'idb://openbook';

/**
 * Open the embedded browser store and run migrations. Resolves a ready
 * {@link PageStore} backed by PGlite-on-IndexedDB (or whatever `dataDir` names).
 */
export async function createBrowserStore(opts: BrowserStoreOptions = {}): Promise<PageStore> {
  const db = await PgliteDb.create(opts.dataDir ?? DEFAULT_DATA_DIR);
  const store = new PageStore(db);
  await store.migrate();
  return store;
}

/**
 * One-call factory for the in-webview data client: open the embedded store,
 * migrate it, and wrap it in a {@link LocalDataClient}. This is the desktop/web
 * default — no server, no port.
 */
export async function createLocalDataClient(opts: BrowserStoreOptions = {}): Promise<LocalDataClient> {
  const store = await createBrowserStore(opts);
  return new LocalDataClient(store);
}

export {LocalDataClient} from './localClient';
export {PageStore} from './store';
export {PageHub} from './hub';
export {PgliteDb, PgliteQueryableDb, Mutex, type Db} from './dbCore';
