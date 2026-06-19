import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {Mutex, PgliteDb} from './db';

describe('Mutex', () => {
  it('runs queued work strictly in FIFO order, one at a time', async () => {
    const lock = new Mutex();
    const log: string[] = [];
    const task = (label: string, delay: number) =>
      lock.run(async () => {
        log.push(`${label}:start`);
        await new Promise((r) => setTimeout(r, delay));
        log.push(`${label}:end`);
      });

    // Start three tasks "simultaneously"; the first sleeps longest. Without the
    // mutex their start/end would interleave — with it they fully serialize.
    await Promise.all([task('a', 30), task('b', 1), task('c', 1)]);
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('keeps serving callers after one rejects', async () => {
    const lock = new Mutex();
    const order: string[] = [];
    const failing = lock.run(async () => {
      throw new Error('boom');
    });
    const after = lock.run(async () => {
      order.push('after');
    });
    await expect(failing).rejects.toThrow('boom');
    await after;
    expect(order).toEqual(['after']);
  });
});

describe('PgliteDb serialization', () => {
  const dir = join(tmpdir(), `openbook-db-test-${process.pid}`);
  afterAll(() => rmSync(dir, {recursive: true, force: true}));

  it('serializes concurrent transactional read-modify-write so no increment is lost', async () => {
    const db = await PgliteDb.create(dir);
    await db.query('CREATE TABLE counter (id INT PRIMARY KEY, n INT NOT NULL)');
    await db.query('INSERT INTO counter (id, n) VALUES (1, 0)');

    // 50 concurrent non-atomic increments (read n, then write n+1) wrapped in a
    // transaction — exactly the shape the store's RMW paths use (setPageProperties,
    // movePage, the mtime stamp). The mutex holds the lock for the whole
    // transaction, so no other writer slips between its SELECT and UPDATE; every
    // increment survives.
    const bump = (): Promise<void> =>
      db.begin(async (tx) => {
        const rows = await tx.query<{n: number}>('SELECT n FROM counter WHERE id = 1');
        await tx.query('UPDATE counter SET n = $1 WHERE id = 1', [rows[0].n + 1]);
      });
    await Promise.all(Array.from({length: 50}, bump));

    const [{n}] = await db.query<{n: number}>('SELECT n FROM counter WHERE id = 1');
    expect(n).toBe(50);
    await db.close();
  });

  it('does not interleave a standalone query between a transaction\'s statements', async () => {
    const db = await PgliteDb.create(dir);
    await db.query('CREATE TABLE flags (id INT PRIMARY KEY, state TEXT NOT NULL)');
    await db.query('INSERT INTO flags (id, state) VALUES (1, \'init\')');

    // A transaction sets the flag to 'mid', awaits, then to 'done'. A standalone
    // read fired concurrently must observe either the pre-transaction value or
    // the committed value — never the uncommitted 'mid' (the lock keeps the read
    // from running until the transaction commits).
    const tx = db.begin(async (t) => {
      await t.query('UPDATE flags SET state = \'mid\' WHERE id = 1');
      await new Promise((r) => setTimeout(r, 20));
      await t.query('UPDATE flags SET state = \'done\' WHERE id = 1');
    });
    const read = db.query<{state: string}>('SELECT state FROM flags WHERE id = 1');
    const [, rows] = await Promise.all([tx, read]);
    expect(['init', 'done']).toContain(rows[0].state);
    await db.close();
  });
});
