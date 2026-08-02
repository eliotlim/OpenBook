/**
 * Beancount export surfaces (LGR-13).
 *
 * Pins:
 *  - BYTE-STABLE, three ways: two exports of the same store are `Buffer.equal`;
 *    a restart-shaped reopen (same data dir, fresh PGlite + PageStore) matches;
 *    and — the regression that matters — an UNRELATED mutation elsewhere in the
 *    book (a page write, a draft created and edited) leaves the bytes
 *    IDENTICAL, while an actual post CHANGES them (so the identity assertions
 *    can demonstrably fail);
 *  - transport parity: `HttpDataClient` and `LocalDataClient` return identical
 *    bytes; the raw route serves `text/plain` as an attachment;
 *  - read gate parity with the other ledger reads; unseeded ledger → typed
 *    `not-initialized` over both transports;
 *  - `ledgerVerify()` reports over both transports (same report), and stays
 *    admin-gated over HTTP for a non-admin caller;
 *  - the exported journal reflects the real store: the closed period emits its
 *    `balance` assertions and the draft never appears.
 */

import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {API, HttpDataClient, LedgerError, textSnapshot, type DataClient} from '@book.dev/sdk';
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

/** A representative book: mangling-hostile accounts, a reversal pair, a
 *  cleared posting, a CLOSED period (closing entry + assertions), a draft. */
async function seedFixture(client: DataClient): Promise<{cashId: string; salesId: string}> {
  await client.ledgerInit();
  const cash = await client.ledgerCreateAccount({name: 'Assets:Bank:Checking', type: 'asset'});
  const sales = await client.ledgerCreateAccount({name: 'Revenue:Sales', type: 'revenue'});
  const fees = await client.ledgerCreateAccount({name: 'Expenses:Bank Fees', type: 'expense'});
  await client.ledgerCreateAccount({name: 'Equity:RetainedEarnings', type: 'equity'});

  const sale = await client.ledgerCreateDraft({
    date: '2026-01-05',
    description: 'Invoice 1 "quoted" \\ hostile',
    postings: [
      {accountId: cash.id, amountMinor: 123_456, memo: 'gross "wages"'},
      {accountId: sales.id, amountMinor: -123_456},
    ],
  });
  const posted = await client.ledgerPostTransaction(sale.id);
  await client.ledgerSetPostingCleared(posted.postings[0].id, 'cleared');

  const fee = await client.ledgerCreateDraft({
    date: '2026-01-07',
    description: 'Wire fee (typo)',
    postings: [
      {accountId: fees.id, amountMinor: 2_500},
      {accountId: cash.id, amountMinor: -2_500},
    ],
  });
  const postedFee = await client.ledgerPostTransaction(fee.id);
  await client.ledgerReverseTransaction(postedFee.id, {date: '2026-01-08'});

  await client.ledgerClosePeriod({start: '2026-01-01', end: '2026-01-31'});
  await client.ledgerCreateDraft({date: '2026-02-02', description: 'lingering draft — must not export'});
  return {cashId: cash.id, salesId: sales.id};
}

describe('LGR-13 — Beancount export surfaces', () => {
  it('is byte-stable across runs, a restart-shaped reopen, and an unrelated mutation — and NOT across a real one', async () => {
    const dir = join(tmpdir(), `ob-lgr13-export-${process.pid}-${Date.now()}`);
    rmSync(dir, {recursive: true, force: true});
    cleanups.push(() => rmSync(dir, {recursive: true, force: true}));

    const store = new PageStore(await PgliteDb.create(dir));
    await store.migrate();
    const client = new LocalDataClient(store);
    const {cashId, salesId} = await seedFixture(client);

    const first = Buffer.from(await client.ledgerExportBeancount(), 'utf8');
    const second = Buffer.from(await client.ledgerExportBeancount(), 'utf8');
    expect(second.equals(first)).toBe(true);

    // UNRELATED mutations: a page write, and a draft created then edited —
    // none of it is on the books, so the export must not move by a byte.
    await client.savePage({name: 'Meeting notes', data: textSnapshot('nothing to do with the ledger', 'pl')});
    const draft = await client.ledgerCreateDraft({
      date: '2026-02-10',
      description: 'still a draft',
      postings: [
        {accountId: cashId, amountMinor: 999},
        {accountId: salesId, amountMinor: -999},
      ],
    });
    await client.ledgerUpdateDraft(draft.id, {description: 'still a draft, edited'});
    const third = Buffer.from(await client.ledgerExportBeancount(), 'utf8');
    expect(third.equals(first)).toBe(true);

    // …and the identity is FALSIFIABLE: posting that draft is a real mutation,
    // and the bytes must change (otherwise the three assertions above pass
    // vacuously for any constant-output exporter).
    await client.ledgerPostTransaction(draft.id);
    const afterPost = Buffer.from(await client.ledgerExportBeancount(), 'utf8');
    expect(afterPost.equals(first)).toBe(false);
    await store.close();

    // Restart-shaped: fresh PGlite handle + PageStore over the SAME data dir.
    const reopened = new PageStore(await PgliteDb.create(dir));
    cleanups.push(() => reopened.close());
    const fourth = Buffer.from(await new LocalDataClient(reopened).ledgerExportBeancount(), 'utf8');
    expect(fourth.equals(afterPost)).toBe(true);
  });

  it('HTTP route and LocalDataClient return identical bytes; the route serves text/plain', async () => {
    const store = await memoryStore();
    const app = createApp(store, undefined, new PageHub());
    const local = new LocalDataClient(store);
    const http = new HttpDataClient('', undefined, {
      fetchImpl: async (input, init) => app.request(input, init),
    });
    await seedFixture(local);

    const viaLocal = Buffer.from(await local.ledgerExportBeancount(), 'utf8');
    const viaHttp = Buffer.from(await http.ledgerExportBeancount(), 'utf8');
    expect(viaHttp.equals(viaLocal)).toBe(true);

    const res = await app.request(API.ledgerExportBeancount, {headers: JSON_HEADERS});
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(res.headers.get('Content-Disposition')).toContain('ledger.beancount');
    expect(Buffer.from(await res.text(), 'utf8').equals(viaLocal)).toBe(true);
  });

  it('the journal reflects the real store: closed-period assertions in, drafts out, names mangled', async () => {
    const store = await memoryStore();
    const local = new LocalDataClient(store);
    await seedFixture(local);
    const text = await local.ledgerExportBeancount();

    // Type-derived roots + charset mangling on real store-written accounts.
    expect(text).toContain('open Income:Revenue:Sales USD');
    expect(text).toContain('open Expenses:Bank-Fees USD');
    expect(text).toContain('lp-name: "Expenses:Bank Fees"');
    // The reversal pair: void original + posted reversal both export.
    expect(text).toContain('lp-state: "void"');
    expect(text).toMatch(/lp-reverses: "/);
    // The store's period close (closing entry + assertions the day after end).
    expect(text).toContain('lp-kind: "closing"');
    expect(text).toMatch(/^2026-02-01 balance Income:Revenue:Sales 0\.00 USD$/m);
    // Drafts are not on the books.
    expect(text).not.toContain('must not export');
  });

  it('is read-gated exactly like the other ledger reads', async () => {
    const store = await memoryStore();
    const app = createApp(store, undefined, new PageHub());
    await seedFixture(new LocalDataClient(store));
    await store.claimOwnership('https://account.book.pub#owner');

    const exportRes = await app.request(API.ledgerExportBeancount, {headers: JSON_HEADERS});
    const accountsRes = await app.request(API.ledgerAccounts, {headers: JSON_HEADERS});
    expect(exportRes.status).toBe(accountsRes.status);
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
      const code = await client.ledgerExportBeancount().then(
        () => 'NO-ERROR',
        (err) => (err instanceof LedgerError ? err.code : 'WRONG-ERROR'),
      );
      expect(code).toBe('not-initialized');
    }
  });

  it('ledgerVerify() answers over both transports and stays admin-gated over HTTP', async () => {
    const store = await memoryStore();
    const app = createApp(store, undefined, new PageHub());
    const local = new LocalDataClient(store);
    const http = new HttpDataClient('', undefined, {
      fetchImpl: async (input, init) => app.request(input, init),
    });
    await seedFixture(local);

    const viaLocal = await local.ledgerVerify();
    expect(viaLocal.initialized).toBe(true);
    expect(viaLocal.findings).toEqual([]);
    expect(viaLocal.checkedTransactions).toBeGreaterThan(0);

    // Unclaimed instance: the HTTP caller passes the create gate and gets the
    // same report the local transport computed.
    const viaHttp = await http.ledgerVerify();
    expect(viaHttp).toEqual(viaLocal);

    // Claimed instance: an anonymous caller is refused (admin-gated report),
    // with a non-2xx that surfaces as a thrown error — not a silent {}.
    await store.claimOwnership('https://account.book.pub#owner');
    await expect(http.ledgerVerify()).rejects.toThrow(/403|forbidden|owner|admin/i);
  });
});
