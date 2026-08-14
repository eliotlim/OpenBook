import type {Db} from '../dbCore';

/**
 * A one-shot rendezvous for deterministic concurrency tests. Every participant
 * pauses at {@link arriveAndWait} until exactly `parties` calls have arrived.
 */
export interface Barrier {
  readonly parties: number;
  readonly arrived: number;
  arriveAndWait(): Promise<void>;
}

/** Create a one-shot barrier. A late call after release is a test bug. */
export function createBarrier(parties: number): Barrier {
  if (!Number.isInteger(parties) || parties < 1) {
    throw new Error(`barrier parties must be a positive integer, received ${parties}`);
  }

  let arrived = 0;
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    parties,
    get arrived() {
      return arrived;
    },
    async arriveAndWait(): Promise<void> {
      if (arrived >= parties) throw new Error(`barrier already released after ${parties} arrivals`);
      arrived += 1;
      if (arrived === parties) release?.();
      await released;
    },
  };
}

/**
 * Launch store calls behind one start gate. Their synchronous setup completes
 * first; opening the gate then makes every call runnable in the same turn.
 */
export async function runConcurrently<T>(calls: ReadonlyArray<() => Promise<T>>): Promise<T[]> {
  let start: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const pending = calls.map(async (call) => {
    await started;
    return call();
  });
  start?.();
  return Promise.all(pending);
}

export interface QueryBarrierOptions {
  /** Number of matching completed queries that must rendezvous. */
  parties: number;
  /** Match only the read that defines the intended stale-snapshot phase. */
  matches(sql: string): boolean;
}

/**
 * Test-only `Db` decorator that pauses the first N matching queries *after*
 * their rows are read. Transactions are recursively decorated, so concurrent
 * store read-modify-write calls can both take a snapshot before either writes.
 * All later queries pass through normally, including final-state assertions.
 */
export function withQueryBarrier(db: Db, options: QueryBarrierOptions): Db {
  const barrier = createBarrier(options.parties);
  let remaining = options.parties;

  const decorate = (inner: Db): Db => ({
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
      const rows = await inner.query<T>(text, params);
      if (remaining > 0 && options.matches(text)) {
        remaining -= 1;
        await barrier.arriveAndWait();
      }
      return rows;
    },
    begin: <T>(fn: (tx: Db) => Promise<T>): Promise<T> => inner.begin((tx) => fn(decorate(tx))),
    close: (): Promise<void> => inner.close(),
  });

  return decorate(db);
}
