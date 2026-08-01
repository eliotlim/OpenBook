import {describe, expect, it, vi} from 'vitest';
import type {DataClient, DatabaseRow, LedgerInfo, LedgerTransaction, StoredDatabase} from '@book.dev/sdk';
import {LedgerError, parseAmount} from '@book.dev/sdk';
import {buildPluginApi, hostModulesFor} from '../api';

/**
 * The typed data surfaces added in LGR-4: `api.databases.*` and `api.assets.*`
 * are thin, typed delegates over the ambient-credentialed DataClient — no new
 * privilege, just types — and every live subscription is a plugin disposable.
 */

const manifest = {id: 'acme.data', name: 'Data', version: '1.0.0'};

const db: StoredDatabase = {
  id: 'db1',
  pageId: 'page1',
  name: 'Ledger',
  schema: {properties: [], views: []},
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const rows: DatabaseRow[] = [
  {id: 'r1', name: 'Row one', properties: {p: 1}, exports: {}, parentId: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()},
];

describe('plugin api databases', () => {
  it('get/getByPage/listRows delegate to the client with typed results', async () => {
    const client = {
      getDatabase: vi.fn(async (id: string) => (id === 'db1' ? db : null)),
      getPageDatabase: vi.fn(async (pageId: string) => (pageId === 'page1' ? db : null)),
      listRows: vi.fn(async () => rows),
    } as unknown as DataClient;
    const api = buildPluginApi(manifest, client, () => {});

    await expect(api.databases.get('db1')).resolves.toEqual(db);
    await expect(api.databases.get('nope')).resolves.toBeNull();
    await expect(api.databases.getByPage('page1')).resolves.toEqual(db);
    const listed = await api.databases.listRows('db1');
    expect(listed).toEqual(rows);
    // Typed projection, not `any`: schema and row fields are visible types.
    expect((await api.databases.get('db1'))?.schema.properties).toEqual([]);
    expect(listed[0].properties.p).toBe(1);
    expect(client.listRows).toHaveBeenCalledWith('db1');
  });

  it('subscribeRows delivers rows, and unsubscribing is idempotent', () => {
    const stop = vi.fn();
    let deliver: ((rows: DatabaseRow[]) => void) | undefined;
    const client = {
      subscribeRows: vi.fn((_id: string, onRows: (rows: DatabaseRow[]) => void) => {
        deliver = onRows;
        return stop;
      }),
    } as unknown as DataClient;
    const disposables: Array<() => void> = [];
    const api = buildPluginApi(manifest, client, (d) => disposables.push(d));

    const seen: DatabaseRow[][] = [];
    const unsubscribe = api.databases.subscribeRows('db1', (r) => seen.push(r));
    expect(client.subscribeRows).toHaveBeenCalledWith('db1', expect.any(Function));
    deliver?.(rows);
    expect(seen).toEqual([rows]);

    // The subscription is tracked as a plugin disposable…
    expect(disposables).toContain(unsubscribe);
    // …and manual unsubscribe + later host disposal never double-tears-down.
    unsubscribe();
    disposables.forEach((d) => d());
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('host disposal alone tears the subscription down (no manual unsubscribe)', () => {
    const stop = vi.fn();
    const client = {subscribeRows: vi.fn(() => stop)} as unknown as DataClient;
    const disposables: Array<() => void> = [];
    const api = buildPluginApi(manifest, client, (d) => disposables.push(d));

    api.databases.subscribeRows('db1', () => {});
    expect(stop).not.toHaveBeenCalled();
    disposables.forEach((d) => d());
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('plugin api ledger (LGR-5 stitch)', () => {
  const info: LedgerInfo = {exists: true, hostPageId: 'host', databases: {accounts: 'da', transactions: 'dt', postings: 'dp', reconciliations: 'dr'}};

  it('delegates every op to the client, args and results intact', async () => {
    const tx = {id: 't1', state: 'draft'} as unknown as LedgerTransaction;
    const client = {
      ledgerInfo: vi.fn(async () => info),
      ledgerInit: vi.fn(async () => info),
      ledgerListAccounts: vi.fn(async () => []),
      ledgerCreateAccount: vi.fn(async (input: unknown) => input),
      ledgerGetAccount: vi.fn(async () => null),
      ledgerUpdateAccount: vi.fn(async () => ({})),
      ledgerListTransactions: vi.fn(async () => [tx]),
      ledgerGetTransaction: vi.fn(async () => tx),
      ledgerCreateDraft: vi.fn(async () => tx),
      ledgerUpdateDraft: vi.fn(async () => tx),
      ledgerDeleteDraft: vi.fn(async () => true),
      ledgerPostTransaction: vi.fn(async () => ({...tx, state: 'posted'})),
      ledgerReverseTransaction: vi.fn(async () => tx),
      ledgerSetPostingCleared: vi.fn(async () => ({id: 'p1'})),
    } as unknown as DataClient;
    const api = buildPluginApi(manifest, client, () => {});

    await expect(api.ledger.info()).resolves.toEqual(info);
    await expect(api.ledger.init()).resolves.toEqual(info);
    await expect(api.ledger.listAccounts()).resolves.toEqual([]);
    await api.ledger.createAccount({name: 'Assets:Cash', type: 'asset'});
    expect(client.ledgerCreateAccount).toHaveBeenCalledWith({name: 'Assets:Cash', type: 'asset'});
    await expect(api.ledger.getAccount('a1')).resolves.toBeNull();
    await api.ledger.updateAccount('a1', {status: 'closed'});
    expect(client.ledgerUpdateAccount).toHaveBeenCalledWith('a1', {status: 'closed'});
    await api.ledger.listTransactions({state: 'draft', limit: 5});
    expect(client.ledgerListTransactions).toHaveBeenCalledWith({state: 'draft', limit: 5});
    await expect(api.ledger.getTransaction('t1')).resolves.toEqual(tx);
    // Amounts on the wire are signed INTEGER minor units, straight through.
    await api.ledger.createDraft({date: '2026-08-02', postings: [{accountId: 'a1', amountMinor: 250000}]});
    expect(client.ledgerCreateDraft).toHaveBeenCalledWith({date: '2026-08-02', postings: [{accountId: 'a1', amountMinor: 250000}]});
    await api.ledger.updateDraft('t1', {postings: [{accountId: 'a1', amountMinor: -250000}]});
    expect(client.ledgerUpdateDraft).toHaveBeenCalledWith('t1', {postings: [{accountId: 'a1', amountMinor: -250000}]});
    await expect(api.ledger.deleteDraft('t1')).resolves.toBe(true);
    await expect(api.ledger.post('t1')).resolves.toMatchObject({state: 'posted'});
    await api.ledger.reverse('t1', {date: '2026-08-02'});
    expect(client.ledgerReverseTransaction).toHaveBeenCalledWith('t1', {date: '2026-08-02'});
    await api.ledger.setPostingCleared('p1', 'cleared');
    expect(client.ledgerSetPostingCleared).toHaveBeenCalledWith('p1', 'cleared');
  });

  it('lets the typed LedgerError pass through untouched', async () => {
    const client = {
      ledgerPostTransaction: vi.fn(async () => {
        throw new LedgerError('unbalanced', 'postings must sum to zero, got 500 minor units');
      }),
    } as unknown as DataClient;
    const api = buildPluginApi(manifest, client, () => {});
    const err = await api.ledger.post('t1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).code).toBe('unbalanced');
  });

  it('registers nothing itself: live account updates ride databases.subscribeRows, which stays disposable-tracked', () => {
    const stop = vi.fn();
    const client = {subscribeRows: vi.fn(() => stop)} as unknown as DataClient;
    const disposables: Array<() => void> = [];
    const api = buildPluginApi(manifest, client, (d) => disposables.push(d));

    // The pattern the journal block uses: subscribe to the seeded accounts db.
    api.databases.subscribeRows(info.databases!.accounts, () => {});
    expect(disposables).toHaveLength(1);
    disposables.forEach((d) => d());
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('exposes the money core + LedgerError to plugin code via @book.dev/plugin-sdk', () => {
    const api = buildPluginApi(manifest, {} as DataClient, () => {});
    const sdk = hostModulesFor(api)['@book.dev/plugin-sdk'] as Record<string, unknown>;
    expect(sdk.api).toBe(api);
    // The HOST instances — a plugin parses amounts with the same money core
    // and instanceof-matches the same error class the client throws.
    expect(sdk.parseAmount).toBe(parseAmount);
    expect(sdk.LedgerError).toBe(LedgerError);
    expect(typeof sdk.formatAmount).toBe('function');
    expect(typeof sdk.sumAmounts).toBe('function');
  });
});

describe('plugin api assets', () => {
  it('get/put delegate to the content-addressed store', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const client = {
      getAsset: vi.fn(async (id: string) => (id === 'hash' ? {bytes, mime: 'image/png'} : null)),
      putAsset: vi.fn(async () => ({id: 'hash'})),
    } as unknown as DataClient;
    const api = buildPluginApi(manifest, client, () => {});

    // The id IS the content hash — a put's id round-trips into get.
    await expect(api.assets.put(bytes, 'image/png', 'page1')).resolves.toEqual({id: 'hash'});
    expect(client.putAsset).toHaveBeenCalledWith(bytes, 'image/png', 'page1');
    await expect(api.assets.get('hash')).resolves.toEqual({bytes, mime: 'image/png'});
    // Missing and unreadable answer alike: null.
    await expect(api.assets.get('absent')).resolves.toBeNull();
  });
});
