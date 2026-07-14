import {rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import type {PageSnapshot, Principal} from '@book.dev/sdk';
import {PgliteDb} from './db';
import type {Db} from './dbCore';
import {PageStore, PAGE_VERSION_COALESCE_SECONDS} from './store';

// PVH-1 (OB-26) — snapshot-on-save page version history. A save that CHANGES the
// page's `data` captures the PRIOR state (the version you can roll back TO); a
// no-op / name-only save captures nothing; a burst of saves within the coalesce
// window collapses to a single version; the saving principal is stamped.

let seq = 0;
const dirs: string[] = [];
const stores: PageStore[] = [];

async function freshStore(): Promise<{store: PageStore; db: Db}> {
  seq += 1;
  const dir = join(tmpdir(), `ob-pvh-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  dirs.push(dir);
  const db = await PgliteDb.create(dir);
  const store = new PageStore(db);
  await store.migrate();
  stores.push(store);
  return {store, db};
}

afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true});
});

const ISS = 'https://account.book.pub';
const principal = (sub: string): Principal => ({kind: 'user', subject: `${ISS}#${sub}`, issuer: ISS, name: sub, verifiedVia: 'jws'});

const snapshot = (text: string): PageSnapshot => ({
  editorjs: {blocks: [{id: 'b1', type: 'paragraph', data: {text}}]},
  values: [],
  names: [],
});

describe('PVH-1 — page version capture on save', () => {
  it('a changing save captures ONE version holding the PRIOR (rolled-back-to) state', async () => {
    const {store} = await freshStore();
    const id = randomUUID();
    const alice = principal('alice');

    await store.upsertPage({id, name: 'p', data: snapshot('first')}, alice); // create — no prior state
    expect(await store.listPageVersions(id)).toHaveLength(0);

    await store.upsertPage({id, name: 'p', data: snapshot('second')}, alice); // change → captures prior
    const versions = await store.listPageVersions(id);
    expect(versions).toHaveLength(1);

    // The captured payload is the state being REPLACED ("first"), not the new one.
    const full = await store.getPageVersion(id, versions[0].id);
    expect(full).not.toBeNull();
    expect(JSON.stringify(full!.data)).toContain('first');
    expect(JSON.stringify(full!.data)).not.toContain('second');
  });

  it('a no-op save (identical data) captures NO version', async () => {
    const {store} = await freshStore();
    const id = randomUUID();
    const alice = principal('alice');
    await store.upsertPage({id, name: 'p', data: snapshot('same')}, alice);
    await store.upsertPage({id, name: 'p', data: snapshot('same')}, alice); // byte-identical → no-op
    expect(await store.listPageVersions(id)).toHaveLength(0);
  });

  it('a name-only change (data unchanged) captures NO version', async () => {
    const {store} = await freshStore();
    const id = randomUUID();
    const alice = principal('alice');
    await store.upsertPage({id, name: 'p', data: snapshot('body')}, alice);
    await store.upsertPage({id, name: 'renamed', data: snapshot('body')}, alice); // only name differs
    expect(await store.listPageVersions(id)).toHaveLength(0);
  });

  it('rapid changing saves within the coalesce window collapse to AT MOST one version', async () => {
    const {store} = await freshStore();
    const id = randomUUID();
    const alice = principal('alice');
    await store.upsertPage({id, name: 'p', data: snapshot('v0')}, alice); // create

    // Several distinct changes back-to-back (each its own tx, all within seconds).
    for (const text of ['v1', 'v2', 'v3', 'v4']) {
      await store.upsertPage({id, name: 'p', data: snapshot(text)}, alice);
    }
    const versions = await store.listPageVersions(id);
    expect(versions.length).toBeLessThanOrEqual(1);
    expect(versions).toHaveLength(1); // the first change captured; the rest coalesced
  });

  it('a change OUTSIDE the coalesce window captures a second version', async () => {
    const {store, db} = await freshStore();
    const id = randomUUID();
    const alice = principal('alice');
    await store.upsertPage({id, name: 'p', data: snapshot('v0')}, alice);
    await store.upsertPage({id, name: 'p', data: snapshot('v1')}, alice); // captures prior v0
    expect(await store.listPageVersions(id)).toHaveLength(1);

    // Backdate the sole version beyond the coalesce window so the next change is
    // no longer coalesced (simulates saves spread far apart in real time).
    await db.query(
      'UPDATE page_versions SET created_at = now() - ($1::int * interval \'1 second\')',
      [PAGE_VERSION_COALESCE_SECONDS + 5],
    );

    await store.upsertPage({id, name: 'p', data: snapshot('v2')}, alice); // captures prior v1
    expect(await store.listPageVersions(id)).toHaveLength(2);
  });

  it('stamps the saving principal on the captured version', async () => {
    const {store} = await freshStore();
    const id = randomUUID();
    const bob = principal('bob');
    await store.upsertPage({id, name: 'p', data: snapshot('first')}, bob);
    await store.upsertPage({id, name: 'p', data: snapshot('second')}, bob);

    const [v] = await store.listPageVersions(id);
    expect(v.authorSubject).toBe(`${ISS}#bob`);
    expect(v.authorIssuer).toBe(ISS);
    expect(v.authorName).toBe('bob');
  });
});
