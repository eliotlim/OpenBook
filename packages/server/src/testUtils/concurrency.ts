import type {Db} from '../dbCore';

/**
 * A one-shot rendezvous for deterministic concurrency tests. Every participant
 * pauses at {@link arriveAndWait} until `parties` distinct identities arrive.
 */
export interface Barrier {
  readonly parties: number;
  readonly arrived: number;
  arriveAndWait(participant?: object): Promise<void>;
}

/** Create a one-shot barrier. A late call after release is a test bug. */
export function createBarrier(parties: number): Barrier {
  if (!Number.isInteger(parties) || parties < 1) {
    throw new Error(`barrier parties must be a positive integer, received ${parties}`);
  }

  const participants = new Set<object>();
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    parties,
    get arrived() {
      return participants.size;
    },
    async arriveAndWait(participant = {}): Promise<void> {
      if (!participants.has(participant)) {
        if (participants.size >= parties) throw new Error(`barrier already released after ${parties} arrivals`);
        participants.add(participant);
        if (participants.size === parties) release?.();
      }
      await released;
    },
  };
}

const isAssertionError = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && 'name' in value && value.name === 'AssertionError';

/**
 * Launch store calls behind one start gate. Their synchronous setup completes
 * first; opening the gate then makes every call runnable in the same turn.
 */
export async function runConcurrently<T>(
  calls: ReadonlyArray<() => Promise<T>>,
  harnessFaults: unknown[],
): Promise<T[]> {
  let start: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const pending = calls.map(async (call) => {
    try {
      await started;
      return await call();
    } catch (error) {
      if (!isAssertionError(error) && !harnessFaults.includes(error)) harnessFaults.push(error);
      throw error;
    }
  });
  start?.();
  // Promise.all rejects as soon as one participant fails, even though its
  // siblings keep running. Integration-test teardown can then close/drop the
  // database underneath those orphaned calls, replacing the useful first
  // failure with ECONNRESET noise. Drain the whole cohort before propagating.
  const settled = await Promise.allSettled(pending);
  const failures = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `${failures.length} concurrent calls failed`);
  return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
}

export interface QueryBarrierOptions {
  /** Externally observable rendezvous shared by the matching participants. */
  barrier: Barrier;
  /** Match only the read that defines the intended stale-snapshot phase. */
  matches(sql: string): boolean;
  /** Locking reads rendezvous before execution; stale reads rendezvous after. */
  rendezvous: 'before-query' | 'after-query';
  /** Maximum time from the first arrival until every participant arrives. */
  rendezvousTimeoutMs: number;
  /** Fault sink checked by a non-`test.fails` harness assertion. */
  harnessFaults: unknown[];
}

/**
 * Test-only `Db` decorator that pauses the first N distinct matching query
 * participants either before a locking read is attempted or after an unlocked
 * read completes. Every transaction gets one stable identity, while each
 * standalone query is its own participant. Transactions are recursively
 * decorated, and all later participants pass through normally, including
 * final-state assertions.
 */
export function withQueryBarrier(db: Db, options: QueryBarrierOptions): Db {
  if (!Number.isFinite(options.rendezvousTimeoutMs) || options.rendezvousTimeoutMs <= 0) {
    throw new Error(`query barrier rendezvous timeout must be positive, received ${options.rendezvousTimeoutMs}`);
  }
  const {barrier} = options;
  const selectedParticipants = new Set<object>();
  let expiry: Promise<never> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  const waitForRendezvous = async (participant: object): Promise<void> => {
    expiry ??= new Promise<never>((_resolve, reject) => {
      expiryTimer = setTimeout(() => {
        const fault = new Error(
          `query barrier rendezvous timed out after ${options.rendezvousTimeoutMs}ms ` +
            `(${barrier.arrived}/${barrier.parties} distinct participants arrived)`,
        );
        options.harnessFaults.push(fault);
        reject(fault);
      }, options.rendezvousTimeoutMs);
    });
    try {
      await Promise.race([barrier.arriveAndWait(participant), expiry]);
    } finally {
      if (barrier.arrived === barrier.parties && expiryTimer !== undefined) clearTimeout(expiryTimer);
    }
  };

  const decorate = (inner: Db, transactionParticipant?: object): Db => ({
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
      const participant = transactionParticipant ?? {};
      const selected =
        options.matches(text) &&
        (selectedParticipants.has(participant) || selectedParticipants.size < barrier.parties);
      if (selected) {
        selectedParticipants.add(participant);
        if (options.rendezvous === 'before-query') await waitForRendezvous(participant);
      }
      const rows = await inner.query<T>(text, params);
      if (selected && options.rendezvous === 'after-query') {
        await waitForRendezvous(participant);
      }
      return rows;
    },
    begin: <T>(fn: (tx: Db) => Promise<T>): Promise<T> =>
      inner.begin((tx) => fn(decorate(tx, {}))),
    close: (): Promise<void> => inner.close(),
  });

  return decorate(db);
}
