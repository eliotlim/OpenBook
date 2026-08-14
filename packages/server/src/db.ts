import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import postgres from 'postgres';
import type {PGliteOptions} from '@electric-sql/pglite';
import {PgliteDb, type Db, withSavepoint} from './dbCore';
import {DirLock, DirLockedError} from './dirLock';

// The isomorphic core (Mutex, the `Db` interface, the PGlite-backed `PgliteDb`)
// lives in `./dbCore` so it carries no Node imports and can run inside the
// app/web webview. This Node-only module re-exports it and adds the pieces that
// genuinely need Node: the real-Postgres backend and a filesystem `dataDir`
// helper.
export {Mutex, PgliteQueryableDb, PgliteDb, type Db} from './dbCore';

type Sql = ReturnType<typeof postgres>;

/**
 * JSON/JSONB parameter serializer for the porsager driver (LGR-15).
 *
 * THE BUG THIS FIXES: every jsonb write in this codebase binds
 * `JSON.stringify(value)` — a STRING — as the parameter (`$n::jsonb`), which
 * PGlite parses into the intended object. The wire driver, however, learns the
 * parameter's type from the server's ParameterDescription and then runs its
 * default json serializer — `JSON.stringify` — over the ALREADY-STRINGIFIED
 * value, storing a jsonb STRING scalar (`"{\"a\":1}"`), not an object. Reads
 * through `parseJson` still worked (it re-parses strings — which is why this
 * survived undetected until the LGR-15 durability CI ran the ledger on real
 * Postgres), but every SQL-level extraction (`properties->>'…'`, the ledger's
 * posting reader, the icon projection) silently returned NULL.
 *
 * Fix: a string bound to a json/jsonb parameter IS ALREADY JSON text — pass it
 * through verbatim; anything else serializes once. This matches PGlite's
 * behavior exactly, which is the property the whole store relies on
 * ("byte-identical SQL on both backends").
 *
 * LEGACY POSTURE — deliberately NO repair migration (LGR-15, Quinn Q1). Rows
 * written through this driver before the fix hold jsonb STRING scalars. They
 * cannot be repaired mechanically: a stored string that PARSES as JSON is
 * indistinguishable from a value that legitimately IS a JSON string scalar —
 * "un-double-encode everything parseable" would corrupt any genuine
 * string-typed value. So legacy rows stay as written, with these consequences:
 *  - application READS keep working: every read path goes through `parseJson`,
 *    whose string branch re-parses exactly this shape;
 *  - SQL-level extraction (`properties->>'…'`) on a legacy row returns NULL —
 *    visible as e.g. missing icons in list projections for pages written
 *    pre-fix on an external-Postgres deployment. New writes are correct, and
 *    any full row UPDATE through the app rewrites the value properly;
 *  - the LGR-15 durability CI runs the ledger suite against real Postgres, so
 *    a regression of this serializer is caught, not re-hidden.
 * Operators who want a clean store can export + restore into a fresh library
 * (docs/ledger/backup-restore.md), which rewrites every row through the fixed
 * driver.
 */
const jsonParamPassthrough = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

/** Real Postgres via the `postgres` (porsager) driver. */
export class PostgresDb implements Db {
  private readonly sql: Sql;
  private readonly inTransaction: boolean;

  constructor(databaseUrl: string, opts?: {sql?: Sql; max?: number; inTransaction?: boolean}) {
    this.inTransaction = opts?.inTransaction === true;
    this.sql =
      opts?.sql ??
      postgres(databaseUrl, {
        max: opts?.max ?? 10,
        onnotice: () => undefined,
        types: {
          json: {to: 114, from: [114, 3802], serialize: jsonParamPassthrough, parse: (raw: string) => JSON.parse(raw) as unknown},
        },
      });
  }

  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const rows = await this.sql.unsafe(text, params as never[]);
    return rows as unknown as T[];
  }

  async begin<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.inTransaction) return withSavepoint(this, fn);
    return this.sql.begin((tx) => fn(new PostgresDb('', {
      sql: tx as unknown as Sql,
      inTransaction: true,
    }))) as Promise<T>;
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}

/** Single-owner lock file kept inside an embedded PGlite `dataDir`. */
const PGLITE_LOCK_FILE = '.openbook-pglite.lock';

/**
 * Thrown when a **live** process already owns an embedded PGlite `dataDir`. Unlike
 * the book mirror (which degrades to running without a mirror), this is **fatal**:
 * PGlite is single-process WASM Postgres with no shared inter-process locking, so a
 * second instance opening the same `dataDir` corrupts the store. Refuse to start.
 */
export class PgliteDataDirLockedError extends Error {
  constructor(
    readonly dataDir: string,
    readonly holder: {pid: number; host: string; startedAt: string},
  ) {
    super(
      `embedded PGlite dataDir ${dataDir} is already owned by pid ${holder.pid} on ${holder.host} ` +
        `(since ${holder.startedAt}). A second PGlite instance on one dataDir corrupts it — refusing to start. ` +
        'Stop the other openbook-server, or point this one at a different --data-dir.',
    );
    this.name = 'PgliteDataDirLockedError';
  }
}

/**
 * Open an embedded PGlite database under a filesystem `dataDir`, creating the
 * full path first (PGlite's own mkdir is not recursive). The Node entry point
 * for {@link PgliteDb}; the browser entry passes an `idb://`/`memory://` URL
 * straight to `PgliteDb.create`, which needs no filesystem.
 *
 * Acquires a single-owner {@link DirLock} on the `dataDir` **before** opening so a
 * second process can't open the same store concurrently. A live foreign holder is
 * **fatal** ({@link PgliteDataDirLockedError}) — two PGlite instances on one dir
 * corrupt it, which is far worse than refusing to boot. The lock is released when
 * the returned db is closed (and is taken over on the next boot if a crash left it
 * behind, via the holder-pid liveness probe).
 */
export async function createPgliteDb(dataDir: string, assets?: Partial<PGliteOptions>): Promise<PgliteDb> {
  mkdirSync(dataDir, {recursive: true});
  let lock: DirLock;
  try {
    lock = await DirLock.acquire(join(dataDir, PGLITE_LOCK_FILE));
  } catch (err) {
    if (err instanceof DirLockedError) throw new PgliteDataDirLockedError(dataDir, err.holder);
    throw err;
  }
  let db: PgliteDb;
  try {
    db = await PgliteDb.create(dataDir, assets);
  } catch (err) {
    await lock.release(); // failed to open — don't strand the lock.
    throw err;
  }
  // Release the dataDir lock when the store closes. `close` lives on the
  // Node-free `dbCore` PgliteDb (so it can't import DirLock); wrap it here, in the
  // Node module that owns the lock, instead.
  const closeStore = db.close.bind(db);
  db.close = async (): Promise<void> => {
    try {
      await closeStore();
    } finally {
      await lock.release();
    }
  };
  return db;
}
