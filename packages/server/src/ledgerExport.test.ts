/**
 * Canonical postings CSV export surfaces (LGR-7).
 *
 * Pins:
 *  - BYTE-STABLE: two exports of the same fixture book are `Buffer.equal`,
 *    including across a restart-shaped store reopen (same data dir, fresh
 *    PGlite handle + PageStore);
 *  - transport parity: `HttpDataClient` (over `app.request`) and
 *    `LocalDataClient` (no HTTP) return IDENTICAL bytes for the same store;
 *  - the route is read-gated exactly like the other ledger reads (same
 *    status as `GET /api/ledger/accounts` for a denied caller, never 200);
 *  - unseeded ledger → typed `not-initialized` over both transports.
 */

import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {API, HttpDataClient, LEDGER_CSV_COLUMNS, LedgerError, type DataClient} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {LocalDataClient} from './localClient';

const JSON_HEADERS = {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'};

let cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

async function memoryStore(): Promise<PageStore> {
  const db = await PgliteDb.create('memory://');
  const store = new PageStore(db);
  await store.migrate();
  cleanups.push(() => store.close());
  return store;
}

/** Seed a small but representative book: accounts, two posted entries (one with
 *  CSV-hostile text), a reversal, a cleared posting, and a lingering draft. */
async function seedFixture(client: DataClient): Promise<void> {
  await client.ledgerInit();
  const cash = await client.ledgerCreateAccount({name: 'Assets:Bank:Checking', type: 'asset'});
  const income = await client.ledgerCreateAccount({name: 'Revenue:Sales', type: 'revenue'});
  const expense = await client.ledgerCreateAccount({name: 'Expenses:Food', type: 'expense'});

  const sale = await client.ledgerCreateDraft({
    date: '2026-08-01',
    description: 'Invoice 1',
    postings: [
      {accountId: cash.id, amountMinor: 123_456},
      {accountId: income.id, amountMinor: -123_456},
    ],
  });
  const posted = await client.ledgerPostTransaction(sale.id);
  await client.ledgerSetPostingCleared(posted.postings[0].id, 'cleared');

  const groceries = await client.ledgerCreateDraft({
    date: '2026-08-02',
    description: 'Groceries, "weekly"\nrun',
    postings: [
      {accountId: expense.id, amountMinor: 5_000},
      {accountId: cash.id, amountMinor: -5_000},
    ],
  });
  const postedGroceries = await client.ledgerPostTransaction(groceries.id);
  await client.ledgerReverseTransaction(postedGroceries.id);

  await client.ledgerCreateDraft({date: '2026-08-03', description: 'pending draft'});
}

describe('LGR-7 — canonical CSV export surfaces', () => {
  it('two exports of the same fixture are Buffer.equal, including after a restart-shaped reopen', async () => {
    const dir = join(tmpdir(), `ob-lgr7-export-${process.pid}-${Date.now()}`);
    rmSync(dir, {recursive: true, force: true});
    cleanups.push(() => rmSync(dir, {recursive: true, force: true}));

    const store = new PageStore(await PgliteDb.create(dir));
    await store.migrate();
    const client = new LocalDataClient(store);
    await seedFixture(client);

    const first = Buffer.from(await client.ledgerExportCsv(), 'utf8');
    const second = Buffer.from(await client.ledgerExportCsv(), 'utf8');
    expect(second.equals(first)).toBe(true);
    expect(first.toString('utf8').startsWith(`${LEDGER_CSV_COLUMNS.join(',')}\n`)).toBe(true);
    // 6 logical rows (2+2 postings for the posted pair, 2 for the reversal, 0
    // for the empty draft) — but 10 physical lines: the "Groceries…\nrun"
    // description embeds a QUOTED newline in each of its 4 rows (RFC-4180),
    // so physical lines = 1 header + 6 rows + 4 embedded newlines.
    expect(first.toString('utf8').trimEnd().split('\n').length).toBe(1 + 6 + 4);
    await store.close();

    // Restart-shaped: a fresh PGlite handle + PageStore over the SAME data dir.
    const reopened = new PageStore(await PgliteDb.create(dir));
    cleanups.push(() => reopened.close());
    const third = Buffer.from(await new LocalDataClient(reopened).ledgerExportCsv(), 'utf8');
    expect(third.equals(first)).toBe(true);
  });

  it('HTTP route and LocalDataClient return identical bytes for the same store', async () => {
    const store = await memoryStore();
    const app = createApp(store, undefined, new PageHub());
    const local = new LocalDataClient(store);
    const http = new HttpDataClient('', undefined, {
      fetchImpl: async (input, init) => app.request(input, init),
    });
    await seedFixture(local);

    const viaLocal = Buffer.from(await local.ledgerExportCsv(), 'utf8');
    const viaHttp = Buffer.from(await http.ledgerExportCsv(), 'utf8');
    expect(viaHttp.equals(viaLocal)).toBe(true);

    // The raw route serves text/csv (UTF-8, attachment).
    const res = await app.request(API.ledgerExportCsv, {headers: JSON_HEADERS});
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(Buffer.from(await res.text(), 'utf8').equals(viaLocal)).toBe(true);
  });

  it('is read-gated exactly like the other ledger reads', async () => {
    const store = await memoryStore();
    const app = createApp(store, undefined, new PageHub());
    await seedFixture(new LocalDataClient(store));
    // Claim the instance: the restricted ledger host page stops resolving for an
    // anonymous guest, exactly as for every other ledger read.
    await store.claimOwnership('https://account.book.pub#owner');

    const exportRes = await app.request(API.ledgerExportCsv, {headers: JSON_HEADERS});
    const accountsRes = await app.request(API.ledgerAccounts, {headers: JSON_HEADERS});
    expect(exportRes.status).toBe(accountsRes.status); // same gate as other ledger reads
    expect(exportRes.status).not.toBe(200);
  });

  it('unseeded ledger → typed not-initialized over both transports', async () => {
    const store = await memoryStore();
    const app = createApp(store, undefined, new PageHub());
    const local = new LocalDataClient(store);
    const http = new HttpDataClient('', undefined, {
      fetchImpl: async (input, init) => app.request(input, init),
    });
    for (const client of [local, http]) {
      const code = await client.ledgerExportCsv().then(
        () => 'NO-ERROR',
        (err) => (err instanceof LedgerError ? err.code : 'WRONG-ERROR'),
      );
      expect(code).toBe('not-initialized');
    }
  });
});
