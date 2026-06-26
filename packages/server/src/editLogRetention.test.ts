import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {guestPrincipal} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';

let store: PageStore;
let dir: string;
let seq = 0;

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-editlog-test-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

describe('edit-log retention', () => {
  it('prunes entries older than the retention window, keeping fresh ones', async () => {
    const author = guestPrincipal('Caryl');
    for (let i = 0; i < 3; i += 1) await store.logEdit({pageId: null, author, kind: 'page.save'});
    await new Promise((r) => setTimeout(r, 60)); // let the rows age past a tiny window

    // A generous window keeps everything; disabled (<=0) is a no-op.
    expect(await store.purgeOldEdits(10_000)).toBe(0);
    expect(await store.purgeOldEdits(0)).toBe(0);
    expect((await store.listEdits()).length).toBe(3);

    // A window shorter than the rows' age prunes them all.
    expect(await store.purgeOldEdits(10)).toBe(3);
    expect((await store.listEdits()).length).toBe(0);
  });
});
