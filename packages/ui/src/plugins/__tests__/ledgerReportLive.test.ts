import {afterEach, describe, expect, it} from 'vitest';
import {renderHook, waitFor, cleanup, act} from '@testing-library/react';
import {LEDGER_MAX_TRANSACTION_LIMIT, type DataClient, type DatabaseRow, type LedgerAccount, type LedgerTransaction} from '@book.dev/sdk';
import {loadLedgerPlugin} from './ledgerPluginFixture';

/**
 * LGR-8 — the report blocks' LIVE data hook, driven directly against the real
 * plugin source through the real loader.
 *
 * This is correctness, not presentation. Overlapping loads are NORMAL here:
 * posting one entry mutates the transactions AND the postings database, so a
 * single user action fires two subscription callbacks, and each fires a fresh
 * read. If the last response to SETTLE wins rather than the newest one ISSUED,
 * the report comes to rest on an older book while still captioned "In balance
 * ✓" — a confidently rendered wrong number, which is the worst failure a ledger
 * report has. And a subscription registered after teardown is a stream that
 * re-reads the whole book on every ledger mutation for the rest of the session.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

const account = (id: string): LedgerAccount => ({
  id,
  name: `Assets:${id}`,
  type: 'asset',
  status: 'open',
  currency: 'USD',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});

const transaction = (id: string): LedgerTransaction => ({
  id,
  date: '2026-01-01',
  description: id,
  state: 'posted',
  postedAt: new Date(0).toISOString(),
  postedBy: 'tester',
  reverses: null,
  entryNo: 1,
  evidence: [],
  postings: [],
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});

/** A DataClient whose ledger reads and row subscriptions are fully controllable. */
function harness() {
  const pendingTx: Array<Deferred<LedgerTransaction[]>> = [];
  const rowListeners: Array<{databaseId: string; fire: () => void; stopped: boolean}> = [];
  let infoDeferred: Deferred<void> | null = null;

  const client = {
    ledgerInfo: async () => {
      if (infoDeferred) await infoDeferred.promise;
      return {exists: true, hostPageId: 'host', databases: {accounts: 'db_a', transactions: 'db_t', postings: 'db_p', reconciliations: 'db_r'}};
    },
    ledgerListAccounts: async () => [account('a1')],
    // LGR-11: the hook reads reconciliations alongside the accounts so a
    // `reconciled` posting can name the statement that froze it. It settles
    // immediately here — the token/staleness behaviour under test is driven
    // through the transaction read, which is the one that can outlive its
    // effect generation.
    ledgerListReconciliations: async () => [],
    ledgerListTransactions: (opts?: {limit?: number}) => {
      requestedLimits.push(opts?.limit);
      const d = deferred<LedgerTransaction[]>();
      pendingTx.push(d);
      return d.promise;
    },
    subscribeRows: (databaseId: string, onRows: (rows: DatabaseRow[]) => void) => {
      const entry = {databaseId, fire: () => onRows([]), stopped: false};
      rowListeners.push(entry);
      return () => {
        entry.stopped = true;
      };
    },
  } as unknown as DataClient;

  const requestedLimits: Array<number | undefined> = [];

  return {
    client,
    requestedLimits,
    /** Resolve the Nth outstanding transaction read (0-based) with `ids`. */
    settle: (index: number, ids: string[]): void => {
      pendingTx[index].resolve(ids.map(transaction));
    },
    /** Reject the Nth outstanding transaction read (0-based) — a read that failed. */
    reject: (index: number, message: string): void => {
      pendingTx[index].reject(new Error(message));
    },
    pendingCount: () => pendingTx.length,
    subscriptions: rowListeners,
    liveSubscriptions: () => rowListeners.filter((l) => !l.stopped),
    fireAll: () => rowListeners.filter((l) => !l.stopped).forEach((l) => l.fire()),
    holdInfo: () => (infoDeferred = deferred<void>()),
    releaseInfo: () => infoDeferred?.resolve(),
  };
}

type UseLedgerReport = () => {
  state: string;
  transactions: Array<{id: string}>;
  truncated: boolean;
  error: string | null;
  reload: () => void;
};

/** The hook, from the shipped plugin source, with `api` bound to our client. */
function hookFrom(client: DataClient, track: (d: () => void) => void = () => {}): UseLedgerReport {
  return loadLedgerPlugin(client, track).exports.useLedgerReport as UseLedgerReport;
}

afterEach(() => cleanup());

describe('LGR-8 — useLedgerReport (real plugin source, real loader)', () => {
  it('drops a stale in-flight response instead of letting it overwrite a newer one', async () => {
    const h = harness();
    const useLedgerReport = hookFrom(h.client);
    const {result} = renderHook(() => useLedgerReport());

    // Initial load settles: the report shows book A.
    await waitFor(() => expect(h.pendingCount()).toBe(1));
    await act(async () => h.settle(0, ['A']));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.transactions.map((t) => t.id)).toEqual(['A']);

    // One posted entry touches two databases, so two loads go out at once —
    // the ordinary case, not a contrived one.
    await act(async () => {
      h.fireAll();
    });
    await waitFor(() => expect(h.pendingCount()).toBeGreaterThanOrEqual(3));
    const newest = h.pendingCount() - 1;

    // The NEWEST request answers first, then an older one answers late with a
    // book from before the write. Last-to-settle must NOT win.
    await act(async () => {
      h.settle(newest, ['A', 'B', 'FRESH']);
    });
    await waitFor(() => expect(result.current.transactions).toHaveLength(3));
    await act(async () => {
      h.settle(1, ['STALE']);
    });

    // Still the fresh book: the late answer was dropped, not rendered.
    expect(result.current.transactions.map((t) => t.id)).toEqual(['A', 'B', 'FRESH']);
  });

  it('drops a superseded load that FAILS, instead of painting an error over the fresh report', async () => {
    const h = harness();
    const useLedgerReport = hookFrom(h.client);
    const {result} = renderHook(() => useLedgerReport());

    await waitFor(() => expect(h.pendingCount()).toBe(1));
    await act(async () => h.settle(0, ['A']));
    await waitFor(() => expect(result.current.state).toBe('ready'));

    await act(async () => {
      h.fireAll();
    });
    await waitFor(() => expect(h.pendingCount()).toBeGreaterThanOrEqual(3));
    const newest = h.pendingCount() - 1;

    // The newest load answers and the report is correct on screen…
    await act(async () => {
      h.settle(newest, ['A', 'B', 'FRESH']);
    });
    await waitFor(() => expect(result.current.transactions).toHaveLength(3));

    // …and then a SUPERSEDED older load rejects. A rejection is an answer too,
    // and the token rule has to cover it: without the guard this flips the hook
    // to `error`, painting the red "could not be loaded" box + Retry over a
    // report that is right, and leaving it there until the next success.
    await act(async () => {
      h.reject(1, 'network went away');
    });

    expect(result.current.state).toBe('ready');
    expect(result.current.error).toBeNull();
    expect(result.current.transactions.map((t) => t.id)).toEqual(['A', 'B', 'FRESH']);
  });

  it('drops a stale load that settles FIRST — the newest ISSUED wins, not the last to answer', async () => {
    const h = harness();
    const useLedgerReport = hookFrom(h.client);
    const {result} = renderHook(() => useLedgerReport());

    await waitFor(() => expect(h.pendingCount()).toBe(1));
    await act(async () => h.settle(0, ['A']));
    await waitFor(() => expect(result.current.state).toBe('ready'));

    await act(async () => {
      h.fireAll();
    });
    await waitFor(() => expect(h.pendingCount()).toBeGreaterThanOrEqual(3));
    const newest = h.pendingCount() - 1;

    // The other ordering: the OLDEST outstanding read answers first. It is still
    // stale — it was issued before the newest one — so it must not paint even
    // though nothing newer has answered yet. A subscription burst can answer in
    // any order, and only the issue order says which book is current.
    await act(async () => {
      h.settle(1, ['STALE']);
    });
    expect(result.current.transactions.map((t) => t.id)).toEqual(['A']);

    await act(async () => {
      h.settle(newest, ['A', 'B', 'FRESH']);
    });
    await waitFor(() => expect(result.current.transactions).toHaveLength(3));
    expect(result.current.transactions.map((t) => t.id)).toEqual(['A', 'B', 'FRESH']);
  });

  it('a load in flight across a reload cannot write into the new generation', async () => {
    const h = harness();
    const useLedgerReport = hookFrom(h.client);
    const {result} = renderHook(() => useLedgerReport());
    await waitFor(() => expect(h.pendingCount()).toBe(1));

    // Retry while the first read is still in flight (the reported repro).
    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(h.pendingCount()).toBe(2));

    // The NEW generation answers…
    await act(async () => h.settle(1, ['FRESH']));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    // …and then the orphaned first read answers with a stale book.
    await act(async () => h.settle(0, ['STALE']));

    expect(result.current.transactions.map((t) => t.id)).toEqual(['FRESH']);
  });

  it('tears down every subscription — including ones created after unmount', async () => {
    const h = harness();
    const disposables: Array<() => void> = [];
    const useLedgerReport = hookFrom(h.client, (d) => disposables.push(d));
    const {unmount} = renderHook(() => useLedgerReport());

    await waitFor(() => expect(h.pendingCount()).toBe(1));
    // Unmount while the INITIAL load is still in flight: the continuation will
    // run after the cleanup has already drained its list.
    unmount();
    await act(async () => h.settle(0, ['A']));
    await act(async () => Promise.resolve());

    // Whatever was created is stopped. Before the fix this was created=3,
    // stopped=0 — three live streams re-reading the whole book forever.
    expect(h.liveSubscriptions()).toHaveLength(0);
  });

  it('subscribes to all three ledger databases and stops them on unmount', async () => {
    const h = harness();
    const useLedgerReport = hookFrom(h.client);
    const {result, unmount} = renderHook(() => useLedgerReport());

    await waitFor(() => expect(h.pendingCount()).toBe(1));
    await act(async () => h.settle(0, ['A']));
    await waitFor(() => expect(result.current.state).toBe('ready'));

    // Accounts, transactions, postings AND reconciliations. Each one earns its
    // place: a cleared-state flip only touches the postings database, and
    // finishing or reopening a statement (LGR-11) only touches the
    // reconciliations database — yet both change what the register shows.
    expect(h.subscriptions.map((s) => s.databaseId).sort()).toEqual(['db_a', 'db_p', 'db_r', 'db_t']);
    expect(h.liveSubscriptions()).toHaveLength(4);
    unmount();
    expect(h.liveSubscriptions()).toHaveLength(0);
  });

  it('asks for exactly the SERVER cap and flags a full page as truncated', async () => {
    const h = harness();
    const useLedgerReport = hookFrom(h.client);
    const {result} = renderHook(() => useLedgerReport());
    await waitFor(() => expect(h.pendingCount()).toBe(1));

    // The request size is the shared SDK constant, not a plugin-local literal —
    // this is what makes "a full page means there may be more" sound.
    expect(h.requestedLimits[0]).toBe(LEDGER_MAX_TRANSACTION_LIMIT);

    const full = Array.from({length: LEDGER_MAX_TRANSACTION_LIMIT}, (_, i) => `t${i}`);
    await act(async () => h.settle(0, full));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.truncated).toBe(true);
  });

  it('a short page is not truncated', async () => {
    const h = harness();
    const useLedgerReport = hookFrom(h.client);
    const {result} = renderHook(() => useLedgerReport());
    await waitFor(() => expect(h.pendingCount()).toBe(1));
    await act(async () => h.settle(0, ['A', 'B']));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.truncated).toBe(false);
  });
});
