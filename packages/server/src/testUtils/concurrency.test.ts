import {describe, expect, it} from 'vitest';
import type {Db} from '../dbCore';
import {createBarrier, runConcurrently, withQueryBarrier} from './concurrency';

describe('concurrency test primitives', () => {
  it('releases a barrier only after every participant arrives', async () => {
    const barrier = createBarrier(2);
    const order: string[] = [];

    const first = barrier.arriveAndWait().then(() => order.push('first released'));
    await Promise.resolve();
    expect(barrier.arrived).toBe(1);
    expect(order).toEqual([]);

    const second = barrier.arriveAndWait().then(() => order.push('second released'));
    await Promise.all([first, second]);
    expect(barrier.arrived).toBe(2);
    expect(order).toHaveLength(2);
  });

  it('starts every concurrent call behind the same gate', async () => {
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
    ]);

    expect(started).toEqual([1, 2]);
    expect(results).toEqual(['a', 'b']);
  });

  it('drains every concurrent call before reporting a participant failure', async () => {
    let releaseSlow: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let slowFinished = false;
    const pending = runConcurrently([
      async () => {
        throw new Error('first participant failed');
      },
      async () => {
        await slow;
        slowFinished = true;
      },
    ]);

    let rejected = false;
    void pending.catch(() => {
      rejected = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(rejected).toBe(false);
    releaseSlow?.();
    await expect(pending).rejects.toThrow('first participant failed');
    expect(slowFinished).toBe(true);
  });

  it('gates matching transaction queries once and leaves later reads alone', async () => {
    let reads = 0;
    const db: Db = {
      async query<T>(): Promise<T[]> {
        reads += 1;
        return [];
      },
      begin: <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(db),
      close: async () => undefined,
    };
    const gated = withQueryBarrier(db, {parties: 2, matches: (sql) => sql === 'stale read'});

    const pending = runConcurrently([
      () => gated.begin((tx) => tx.query('stale read')),
      () => gated.begin((tx) => tx.query('stale read')),
    ]);
    await expect(pending).resolves.toEqual([[], []]);
    await expect(gated.query('stale read')).resolves.toEqual([]);
    expect(reads).toBe(3);
  });
});
