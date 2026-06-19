import {mkdirSync} from 'node:fs';
import postgres from 'postgres';
import {PGlite, type PGliteOptions} from '@electric-sql/pglite';

/**
 * A FIFO async mutex: chains acquirers onto a single promise so each runs to
 * completion before the next begins. Used to make the embedded single-connection
 * PGlite layer the sole, serialized owner of its store — concurrent writers (a
 * second window, a local browser tab, the disk-mirror re-importer) can't
 * interleave a read-modify-write or slip a query between a transaction's
 * statements. Real Postgres has its own MVCC + pool, so it doesn't need this.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** Run `fn` once all previously-queued work has settled. Serializes callers. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    // Keep the chain alive regardless of whether `fn` resolved or rejected, so
    // one failed operation never wedges every subsequent caller.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Minimal database interface used by the store and migrations. Queries use
 * `$1`-style positional parameters; both backends speak the same Postgres SQL,
 * so there is exactly one set of queries regardless of deployment.
 *
 * Two implementations:
 *  - {@link PostgresDb}  — a real Postgres over the wire (headless server, remote).
 *  - {@link PgliteDb}    — embedded Postgres-as-WASM, in-process (desktop).
 */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Run `fn` inside a transaction. */
  begin<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

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

/** A PGlite instance or transaction — both expose `query`. */
type PgliteQueryable = Pick<PGlite, 'query'>;

class PgliteQueryableDb implements Db {
  constructor(protected readonly q: PgliteQueryable) {}

  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.q.query<T>(text, params);
    return result.rows;
  }

  // Inside an existing PGlite transaction, just run statements inline.
  async begin<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {
    /* transactions are closed by their owning PgliteDb */
  }
}

/** Embedded Postgres compiled to WASM, running in-process. */
export class PgliteDb extends PgliteQueryableDb {
  // One process owns this store; every top-level query and transaction passes
  // through here so the single PGlite connection is never re-entered mid-write.
  private readonly lock = new Mutex();

  private constructor(private readonly pg: PGlite) {
    super(pg);
  }

  /**
   * Open (or create) an embedded database under `dataDir`. `assets` overrides
   * PGlite's WASM/data modules — supplied by the compiled desktop sidecar, which
   * embeds them; under Node they are left undefined and PGlite loads them itself.
   */
  static async create(dataDir: string, assets?: Partial<PGliteOptions>): Promise<PgliteDb> {
    // PGlite's own mkdir is not recursive; ensure the full path exists first.
    mkdirSync(dataDir, {recursive: true});
    const pg = await PGlite.create({dataDir, ...assets});
    return new PgliteDb(pg);
  }

  // Serialize standalone queries against each other and against transactions, so
  // a write can't interleave with another client's read-modify-write.
  override async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    return this.lock.run(() => super.query<T>(text, params));
  }

  override async begin<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // Hold the lock for the whole transaction so no other top-level query slips
    // between its statements. Queries issued *inside* the callback go through the
    // transaction's own `PgliteQueryableDb` (not this lock), so there's no
    // re-entrant deadlock.
    return this.lock.run(() =>
      this.pg.transaction((tx) => fn(new PgliteQueryableDb(tx as unknown as PgliteQueryable))),
    );
  }

  override async close(): Promise<void> {
    // Let any in-flight work drain before tearing the connection down.
    await this.lock.run(async () => undefined);
    await this.pg.close();
  }
}
