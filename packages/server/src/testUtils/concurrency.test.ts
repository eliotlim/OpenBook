import {describe, expect, it, vi} from 'vitest';
import type {Db} from '../dbCore';
import {createBarrier, runConcurrently, withQueryBarrier} from './concurrency';

describe('concurrency test primitives', () => {
  it('releases a barrier only after every participant arrives', async () => {
    const barrier = createBarrier(2);
    const order: string[] = [];
    const firstParticipant = {};

    const first = barrier.arriveAndWait(firstParticipant).then(() => order.push('first released'));
    const duplicate = barrier.arriveAndWait(firstParticipant).then(() => order.push('duplicate released'));
    await Promise.resolve();
    expect(barrier.arrived).toBe(1);
    expect(order).toEqual([]);

    const second = barrier.arriveAndWait().then(() => order.push('second released'));
    await Promise.all([first, duplicate, second]);
    expect(barrier.arrived).toBe(2);
    expect(order).toHaveLength(3);
  });

  it('starts every concurrent call behind the same gate', async () => {
    const harnessFaults: unknown[] = [];
    const started: number[] = [];
    const results = await runConcurrently([
      async () => {
        started.push(1);
        return 'a';
      },
      async () => {
        started.push(2);
        return 'b';
      },
    ], harnessFaults);

    expect(started).toEqual([1, 2]);
    expect(results).toEqual(['a', 'b']);
    expect(harnessFaults).toEqual([]);
  });

  it('drains every concurrent call before reporting a participant failure', async () => {
    const harnessFaults: unknown[] = [];
    const failure = new Error('first participant failed');
    let releaseSlow: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let slowFinished = false;
    const pending = runConcurrently([
      async () => {
        throw failure;
      },
      async () => {
        await slow;
        slowFinished = true;
      },
    ], harnessFaults);

    let rejected = false;
    void pending.catch(() => {
      rejected = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(rejected).toBe(false);
    expect(harnessFaults).toEqual([failure]);
    releaseSlow?.();
    await expect(pending).rejects.toThrow('first participant failed');
    expect(slowFinished).toBe(true);
    expect(harnessFaults).toEqual([failure]);
  });

  it('does not report an assertion rejection as an infrastructure fault', async () => {
    const harnessFaults: unknown[] = [];
    const pending = runConcurrently([
      async () => expect('actual').toBe('expected'),
    ], harnessFaults);

    await expect(pending).rejects.toMatchObject({name: 'AssertionError'});
    expect(harnessFaults).toEqual([]);
  });

  it('gates matching transaction queries once and leaves later reads alone', async () => {
    const harnessFaults: unknown[] = [];
    let reads = 0;
    const db: Db = {
      async query<T>(): Promise<T[]> {
        reads += 1;
        return [];
      },
      begin: <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(db),
      close: async () => undefined,
    };
    const barrier = createBarrier(2);
    const gated = withQueryBarrier(db, {
      barrier,
      matches: (sql) => sql === 'stale read',
      rendezvous: 'after-query',
      rendezvousTimeoutMs: 5_000,
      harnessFaults,
    });

    const pending = runConcurrently([
      () => gated.begin((tx) => tx.query('stale read')),
      () => gated.begin((tx) => tx.query('stale read')),
    ], harnessFaults);
    await expect(pending).resolves.toEqual([[], []]);
    await expect(gated.query('stale read')).resolves.toEqual([]);
    expect(barrier.arrived).toBe(barrier.parties);
    expect(reads).toBe(3);
    expect(harnessFaults).toEqual([]);
  });

  it('can rendezvous before executing matching locking reads', async () => {
    const harnessFaults: unknown[] = [];
    const barrier = createBarrier(2);
    let reads = 0;
    const db: Db = {
      async query<T>(): Promise<T[]> {
        reads += 1;
        return [];
      },
      begin: <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(db),
      close: async () => undefined,
    };
    const gated = withQueryBarrier(db, {
      barrier,
      matches: (sql) => sql === 'locking read',
      rendezvous: 'before-query',
      rendezvousTimeoutMs: 5_000,
      harnessFaults,
    });

    const first = gated.begin((tx) => tx.query('locking read'));
    expect(barrier.arrived).toBe(1);
    expect(reads).toBe(0);
    const second = gated.begin((tx) => tx.query('locking read'));
    await Promise.all([first, second]);
    expect(barrier.arrived).toBe(barrier.parties);
    expect(reads).toBe(2);
    expect(harnessFaults).toEqual([]);
  });

  it('counts repeated matches in one transaction as one participant', async () => {
    const harnessFaults: unknown[] = [];
    const db: Db = {
      query: async <T>(): Promise<T[]> => [],
      begin: <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(db),
      close: async () => undefined,
    };
    const gated = withQueryBarrier(db, {
      barrier: createBarrier(2),
      matches: () => true,
      rendezvous: 'after-query',
      rendezvousTimeoutMs: 5_000,
      harnessFaults,
    });
    let firstTransactionFinished = false;
    const firstTransaction = gated.begin(async (tx) => {
      await Promise.all([tx.query('first match'), tx.query('duplicate match')]);
      firstTransactionFinished = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(firstTransactionFinished).toBe(false);
    const secondTransaction = gated.begin((tx) => tx.query('second participant'));
    await Promise.all([firstTransaction, secondTransaction]);
    expect(harnessFaults).toEqual([]);
  });

  it('reports and rejects a rendezvous deadline expiry', async () => {
    vi.useFakeTimers();
    try {
      const harnessFaults: unknown[] = [];
      const db: Db = {
        query: async <T>(): Promise<T[]> => [],
        begin: <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(db),
        close: async () => undefined,
      };
      const gated = withQueryBarrier(db, {
        barrier: createBarrier(2),
        matches: () => true,
        rendezvous: 'after-query',
        rendezvousTimeoutMs: 5_000,
        harnessFaults,
      });

      const pending = gated.query('only arrival');
      const rejection = expect(pending).rejects.toThrow(
        'query barrier rendezvous timed out after 5000ms (1/2 distinct participants arrived)',
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
      expect(harnessFaults).toHaveLength(1);
      expect(harnessFaults[0]).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });
});
