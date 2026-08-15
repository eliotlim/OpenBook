import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {PgliteDb, type Db, type TransactionOptions} from './db';
import {
  IdempotencyKeyReuseError,
  PageStore,
  type IdempotencyRequest,
} from './store';

const KEY = '018f90d8-4b62-7c31-9a2f-62c4d5ea3f17';
const request = (fingerprint = 'a'.repeat(64)): IdempotencyRequest => ({
  actorScope: 'https://account.book.pub#casey',
  key: KEY,
  fingerprint,
  method: 'POST',
  normalizedTarget: '/api/databases/db/rows',
});

let db: PgliteDb;
let store: PageStore;

class OnceInvisibleClaimDb implements Db {
  readonly transactionOptions: Array<TransactionOptions | undefined> = [];
  private hidePriorOnce = true;

  constructor(private readonly inner: Db) {}

  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
    return this.inner.query<T>(text, params);
  }

  begin<T>(fn: (tx: Db) => Promise<T>, options?: TransactionOptions): Promise<T> {
    this.transactionOptions.push(options);
    return this.inner.begin((tx) => fn(this.wrap(tx)), options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  private wrap(db: Db): Db {
    return {
      query: async <T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> => {
        if (this.hidePriorOnce && text.includes('SELECT fingerprint, status, response_body')) {
          this.hidePriorOnce = false;
          return [];
        }
        return db.query<T>(text, params);
      },
      begin: <T>(fn: (tx: Db) => Promise<T>, options?: TransactionOptions) =>
        db.begin((tx) => fn(this.wrap(tx)), options),
      close: () => db.close(),
    };
  }
}

beforeEach(async () => {
  db = await PgliteDb.create('memory://');
  store = new PageStore(db);
  await store.migrate();
});

afterEach(async () => {
  await store.close();
});

describe('response-capturing idempotency ledger', () => {
  it('captures one response and returns it verbatim without re-running the write', async () => {
    let executions = 0;
    const execute = async (txStore: PageStore) => {
      executions += 1;
      await txStore.setSetting('idempotency-test', {executions});
      return {
        status: 201,
        body: {id: 'row-1', value: 42},
        headers: {contentType: 'application/json; charset=UTF-8', location: '/api/pages/row-1'},
      };
    };

    const first = await store.idempotentWrite(request(), execute);
    const replay = await store.idempotentWrite(request(), execute);

    expect(first).toEqual({...replay, replayed: false});
    expect(replay).toMatchObject({
      status: 201,
      body: {id: 'row-1', value: 42},
      headers: {contentType: 'application/json; charset=UTF-8', location: '/api/pages/row-1'},
      replayed: true,
    });
    expect(executions).toBe(1);
    expect(await store.getSetting('idempotency-test')).toEqual({executions: 1});
  });

  it('rejects a different fingerprint without revealing or replacing the first response', async () => {
    await store.idempotentWrite(request(), async () => ({status: 200, body: {secret: 'first'}}));

    await expect(store.idempotentWrite(request('b'.repeat(64)), async () => ({
      status: 200,
      body: {secret: 'second'},
    }))).rejects.toBeInstanceOf(IdempotencyKeyReuseError);

    const replay = await store.idempotentWrite(request(), async () => ({status: 200, body: {secret: 'wrong'}}));
    expect(replay.body).toEqual({secret: 'first'});
  });

  it('retries once when a concurrent claimant is not visible and pins read committed', async () => {
    await store.idempotentWrite(request(), async () => ({status: 200, body: {ok: true}}));
    const onceInvisible = new OnceInvisibleClaimDb(db);
    const retryingStore = new PageStore(onceInvisible);
    let executions = 0;

    const replay = await retryingStore.idempotentWrite(request(), async () => {
      executions += 1;
      return {status: 200, body: {ok: false}};
    });

    expect(replay).toMatchObject({status: 200, body: {ok: true}, replayed: true});
    expect(executions).toBe(0);
    expect(onceInvisible.transactionOptions).toEqual([
      {isolationLevel: 'read committed'},
      {isolationLevel: 'read committed'},
    ]);
  });

  it('rolls back a mutation and claim when the process fails before response capture', async () => {
    await expect(store.idempotentWrite(request(), async (txStore) => {
      await txStore.setSetting('crash-before-response', {written: true});
      throw new Error('simulated crash before response');
    })).rejects.toThrow('simulated crash before response');

    expect(await store.getSetting('crash-before-response')).toBeNull();
    expect(await db.query('SELECT * FROM idempotency_responses')).toHaveLength(0);

    const retry = await store.idempotentWrite(request(), async (txStore) => {
      await txStore.setSetting('crash-before-response', {written: true});
      return {status: 201, body: {ok: true}};
    });
    expect(retry).toMatchObject({status: 201, body: {ok: true}, replayed: false});
  });

  it('retains no claim or mutation for a 409-shaped CAS miss', async () => {
    const conflict = await store.idempotentWrite(request(), async (txStore) => {
      await txStore.setSetting('should-roll-back', true);
      return {status: 409, body: {error: 'stale', code: 'rev-conflict', retryable: false}};
    });
    expect(conflict.status).toBe(409);
    expect(await store.getSetting('should-roll-back')).toBeNull();
    expect(await db.query('SELECT * FROM idempotency_responses')).toHaveLength(0);

    // Because the 409 consumed no row, even a new fingerprint may claim this key.
    const retry = await store.idempotentWrite(request('c'.repeat(64)), async () => ({
      status: 200,
      body: {ok: true},
    }));
    expect(retry.replayed).toBe(false);
  });

  it('garbage-collects by completion time and keeps every ledger forever at <= 0', async () => {
    await store.idempotentWrite(request(), async () => ({status: 200, body: {ok: true}}));
    await db.query('UPDATE idempotency_responses SET completed_at = now() - interval \'8 days\'');

    expect(await store.purgeOldIdempotencyKeys(0)).toBe(0);
    expect(await db.query('SELECT * FROM idempotency_responses')).toHaveLength(1);
    expect(await store.purgeOldIdempotencyKeys(7 * 24 * 60 * 60 * 1000)).toBe(1);
    expect(await db.query('SELECT * FROM idempotency_responses')).toHaveLength(0);
  });
});
