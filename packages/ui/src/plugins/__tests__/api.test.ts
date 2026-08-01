import {describe, expect, it, vi} from 'vitest';
import type {DataClient, DatabaseRow, StoredDatabase} from '@book.dev/sdk';
import {buildPluginApi} from '../api';

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
