import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {PageSnapshot} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';

// OB-164: PGlite has no background checkpointer/autovacuum, so the server runs
// maintenance itself and must not churn dead row versions on no-op saves.

let store: PageStore;
let dir: string;
let seq = 0;

beforeEach(async () => {
  seq += 1;
  // On-disk (not memory://) so CHECKPOINT/VACUUM exercise the real WAL path.
  dir = join(tmpdir(), `ob-maint-test-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

const snap = (text: string): PageSnapshot => ({
  editorjs: {blocks: [{id: 'b1', type: 'paragraph', data: {text}}]},
  values: [],
  names: [],
});

// `editorjs` is typed loosely (unknown) on PageSnapshot; read the first block's text.
const firstText = (s: PageSnapshot): string =>
  (s.editorjs as {blocks: {data: {text: string}}[]}).blocks[0].data.text;

describe('PGlite maintenance (OB-164)', () => {
  it('maintain() runs CHECKPOINT + VACUUM (ANALYZE) without error after churn', async () => {
    const page = await store.upsertPage({name: 'churn', data: snap('v0')});
    // 20 distinct re-saves leave ~20 dead tuples for the vacuum to reclaim.
    for (let i = 1; i <= 20; i += 1) await store.upsertPage({id: page.id, name: 'churn', data: snap(`v${i}`)});
    await expect(store.maintain()).resolves.toBeUndefined();
    await expect(store.checkpoint()).resolves.toBeUndefined();
    // The page survives maintenance intact.
    expect(firstText((await store.getPage(page.id))!.data)).toBe('v20');
  });

  it('upsertPage skips a byte-identical re-save (no new row version)', async () => {
    const first = await store.upsertPage({name: 'p', data: snap('hello')});
    const stored = await store.getPage(first.id);
    // Re-save the *exact* stored snapshot — the no-op an autosave loop generates.
    const again = await store.upsertPage({id: first.id, name: 'p', data: stored!.data});
    expect(again.id).toBe(first.id);
    // A skipped write leaves updated_at untouched (no phantom edit for the mirror).
    expect(again.updatedAt).toBe(first.updatedAt);
    expect(again.data).toEqual(first.data);
  });

  it('upsertPage still writes a genuine change', async () => {
    const first = await store.upsertPage({name: 'p', data: snap('hello')});
    await new Promise((r) => setTimeout(r, 5)); // let now() advance
    const changed = await store.upsertPage({id: first.id, name: 'p', data: snap('world')});
    expect(firstText(changed.data)).toBe('world');
    expect(changed.updatedAt >= first.updatedAt).toBe(true);
    expect(changed.updatedAt).not.toBe(first.updatedAt);
  });

  it('a name-only change is not skipped', async () => {
    const first = await store.upsertPage({name: 'before', data: snap('same')});
    const renamed = await store.upsertPage({id: first.id, name: 'after', data: first.data});
    expect(renamed.name).toBe('after');
  });
});
