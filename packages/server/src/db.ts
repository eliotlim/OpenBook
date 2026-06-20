import {mkdirSync} from 'node:fs';
import postgres from 'postgres';
import type {PGliteOptions} from '@electric-sql/pglite';
import {PgliteDb, type Db} from './dbCore';

// The isomorphic core (Mutex, the `Db` interface, the PGlite-backed `PgliteDb`)
// lives in `./dbCore` so it carries no Node imports and can run inside the
// app/web webview. This Node-only module re-exports it and adds the pieces that
// genuinely need Node: the real-Postgres backend and a filesystem `dataDir`
// helper.
export {Mutex, PgliteQueryableDb, PgliteDb, type Db} from './dbCore';

type Sql = ReturnType<typeof postgres>;

/** Real Postgres via the `postgres` (porsager) driver. */
export class PostgresDb implements Db {
  private readonly sql: Sql;

  constructor(databaseUrl: string, opts?: {sql?: Sql; max?: number}) {
    this.sql = opts?.sql ?? postgres(databaseUrl, {max: opts?.max ?? 10, onnotice: () => undefined});
  }

  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const rows = await this.sql.unsafe(text, params as never[]);
    return rows as unknown as T[];
  }

  async begin<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.sql.begin((tx) => fn(new PostgresDb('', {sql: tx as unknown as Sql}))) as Promise<T>;
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}

/**
 * Open an embedded PGlite database under a filesystem `dataDir`, creating the
 * full path first (PGlite's own mkdir is not recursive). The Node entry point
 * for {@link PgliteDb}; the browser entry passes an `idb://`/`memory://` URL
 * straight to `PgliteDb.create`, which needs no filesystem.
 */
export async function createPgliteDb(dataDir: string, assets?: Partial<PGliteOptions>): Promise<PgliteDb> {
  mkdirSync(dataDir, {recursive: true});
  return PgliteDb.create(dataDir, assets);
}
