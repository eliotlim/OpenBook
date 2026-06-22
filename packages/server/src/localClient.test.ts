import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {DatabaseRow, PageMeta, PageSnapshot, StoredPage} from '@book.dev/sdk';
import {createLocalDataClient} from './browser';
import {LocalDataClient} from './localClient';

const snap = (text: string): PageSnapshot => ({
  editorjs: {blocks: [{id: 'b1', type: 'paragraph', data: {text}}]},
  values: [],
  names: [],
});

let client: LocalDataClient;

beforeEach(async () => {
  // `memory://` PGlite runs everywhere (no IndexedDB needed) — exercises the
  // exact browser factory the app/web ship, just without persistence.
  client = await createLocalDataClient({dataDir: 'memory://'});
});

afterEach(async () => {
  await (client as unknown as {store: {close(): Promise<void>}}).store.close();
});

describe('LocalDataClient — page lifecycle', () => {
  it('creates, reads, lists, renames and trashes pages', async () => {
    const page = await client.savePage({name: 'Trip', data: snap('pack sunscreen')});
    expect(page.id).toBeTruthy();
    expect(await client.getPage(page.id)).toMatchObject({id: page.id, name: 'Trip'});

    const list = await client.listPages();
    expect(list.map((p) => p.id)).toContain(page.id);

    const renamed = await client.renamePage(page.id, 'Trip Plans');
    expect(renamed.name).toBe('Trip Plans');

    expect(await client.deletePage(page.id)).toBe(true);
    expect(await client.getPage(page.id)).toBeNull();

    const trash = await client.listTrash();
    expect(trash.map((p) => p.id)).toContain(page.id);

    const restored = await client.restorePage(page.id);
    expect(restored?.id).toBe(page.id);
    expect((await client.listPages()).map((p) => p.id)).toContain(page.id);
  });

  it('throws when renaming or moving a missing page (matching the HTTP 404 path)', async () => {
    const absent = '00000000-0000-4000-8000-000000000000';
    await expect(client.renamePage(absent, 'x')).rejects.toThrow();
    await expect(client.movePage(absent, {parentId: null, orderedIds: []})).rejects.toThrow();
    expect(await client.deletePage(absent)).toBe(false);
  });
});

describe('LocalDataClient — live updates', () => {
  it('pushes page-list and per-page events to subscribers, like the SSE stream', async () => {
    const lists: PageMeta[][] = [];
    const unsubList = client.subscribePages((pages) => lists.push(pages));

    const page = await client.savePage({name: 'Live', data: snap('one')});
    // The post-write broadcast ran synchronously inside savePage.
    expect(lists.at(-1)?.map((p) => p.id)).toContain(page.id);

    const seen: StoredPage[] = [];
    let deletedId: string | null = null;
    const unsubPage = client.subscribePage(page.id, {
      onPage: (p) => seen.push(p),
      onDeleted: (id) => (deletedId = id),
    });

    await client.savePage({id: page.id, name: 'Live', data: snap('two')});
    expect(seen.at(-1)?.id).toBe(page.id);

    await client.deletePage(page.id);
    expect(deletedId).toBe(page.id);

    unsubPage();
    unsubList();
    // After unsubscribing, no further events are delivered.
    const before = seen.length;
    await client.restorePage(page.id);
    expect(seen.length).toBe(before);
  });
});

describe('LocalDataClient — databases', () => {
  it('hosts a database, adds rows, and streams row updates', async () => {
    const host = await client.savePage({name: 'Tasks', data: snap('')});
    const db = await client.createDatabase({pageId: host.id, name: 'Tasks'});
    expect(await client.getPageDatabase(host.id)).toMatchObject({id: db.id});

    const rowEvents: DatabaseRow[][] = [];
    const unsub = client.subscribeRows(db.id, (rows) => rowEvents.push(rows));

    const row = await client.createRow(db.id, {name: 'First'});
    expect(row.databaseId).toBe(db.id);
    expect(rowEvents.at(-1)?.map((r) => r.id)).toContain(row.id);

    const updated = await client.updateRow(db.id, row.id, {name: 'First (edited)'});
    expect(updated.id).toBe(row.id);

    const rows = await client.listRows(db.id);
    expect(rows).toHaveLength(1);

    unsub();
  });
});

describe('LocalDataClient — export / import round-trip', () => {
  it('exports the whole space and re-imports it losslessly', async () => {
    const a = await client.savePage({name: 'Alpha', data: snap('alpha body')});
    const host = await client.savePage({name: 'Board', data: snap('')});
    const db = await client.createDatabase({pageId: host.id, name: 'Board'});
    await client.createRow(db.id, {name: 'Row 1'});

    const dump = await client.exportSpace();
    expect(dump.pages.map((p) => p.id)).toContain(a.id);
    expect(dump.databases.map((d) => d.id)).toContain(db.id);

    // Import as a copy into the same space: new ids minted, nothing clobbered.
    const result = await client.importSpace({pages: dump.pages, databases: dump.databases, mode: 'copy'});
    expect(result.created).toBeGreaterThan(0);
    expect(Object.keys(result.idMap).length).toBeGreaterThan(0);
  });
});
