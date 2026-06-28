import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {PageSnapshot} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';

const snap = (text: string): PageSnapshot => ({
  editorjs: {blocks: [{id: 'b1', type: 'paragraph', data: {text}}]},
  values: [],
  names: [],
});

// ER-9: reorderRows / movePage renumber their full sibling list, but the
// `position IS DISTINCT FROM $` guard must skip rows that don't actually move so a
// reorder leaves no dead MVCC tuples (PGlite has no autovacuum, OB-164). We detect a
// row rewrite via its `xmin` system column — the id of the transaction that produced
// the current tuple, which only changes when the row is actually written.

let db: PgliteDb;
let store: PageStore;
let dir: string;
let seq = 0;

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-reorder-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  db = await PgliteDb.create(dir);
  store = new PageStore(db);
  await store.migrate();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

/** The current tuple's writing-transaction id per page — changes iff the row is written. */
async function xmins(ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    const rows = await db.query<{x: string}>('SELECT xmin::text AS x FROM pages WHERE id = $1', [id]);
    out.push(rows[0].x);
  }
  return out;
}

describe('PageStore reorder/move no-op skip (ER-9)', () => {
  it('reorderRows rewrites only the rows whose position actually changes', async () => {
    const host = await store.upsertPage({name: 'Board', data: snap('board')});
    const database = await store.createDatabase({pageId: host.id, name: 'Tasks'});
    const a = await store.createRow(database.id, {name: 'A'}); // position 0
    const b = await store.createRow(database.id, {name: 'B'}); // position 1
    const c = await store.createRow(database.id, {name: 'C'}); // position 2

    const before = await xmins([a.id, b.id, c.id]);

    // Same order → every UPDATE's position is unchanged → zero rows written.
    await store.reorderRows(database.id, [a.id, b.id, c.id]);
    expect(await xmins([a.id, b.id, c.id])).toEqual(before);

    // Swap a and b; c stays at index 2 → only a and b are rewritten.
    await store.reorderRows(database.id, [b.id, a.id, c.id]);
    const after = await xmins([a.id, b.id, c.id]);
    expect(after[0]).not.toBe(before[0]); // a: 0 → 1
    expect(after[1]).not.toBe(before[1]); // b: 1 → 0
    expect(after[2]).toBe(before[2]); // c: 2 → 2, skipped
  });

  it('movePage renumber rewrites only the siblings whose position changes', async () => {
    const x = await store.upsertPage({name: 'X', data: snap('x')}); // top-level position 0
    const y = await store.upsertPage({name: 'Y', data: snap('y')}); // position 1
    const z = await store.upsertPage({name: 'Z', data: snap('z')}); // position 2

    const before = await xmins([x.id, y.id, z.id]);

    // Re-assert the SAME order (z stays under root at index 2): the renumber loop must
    // touch nothing. (z's own reparent row is always rewritten, so it isn't asserted.)
    await store.movePage(z.id, null, [x.id, y.id, z.id]);
    const after = await xmins([x.id, y.id, z.id]);
    expect(after[0]).toBe(before[0]); // x not renumbered
    expect(after[1]).toBe(before[1]); // y not renumbered

    // Reverse the order: x and z move, but y stays at index 1 → y is NOT renumbered.
    const before2 = await xmins([x.id, y.id, z.id]);
    await store.movePage(z.id, null, [z.id, y.id, x.id]);
    const after2 = await xmins([x.id, y.id, z.id]);
    expect(after2[0]).not.toBe(before2[0]); // x: 0 → 2
    expect(after2[1]).toBe(before2[1]); // y: 1 → 1, skipped by the renumber
    expect(after2[2]).not.toBe(before2[2]); // z: 2 → 0
  });
});
