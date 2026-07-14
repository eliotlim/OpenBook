import {rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import type {PageSnapshot, Principal} from '@book.dev/sdk';
import {PgliteDb} from './db';
import type {Db} from './dbCore';
import {
  PageStore,
  PAGE_VERSION_COALESCE_SECONDS,
  PAGE_VERSION_KEEP_MIN,
} from './store';

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

// PVH-2 (OB-27) — retention/pruning. The periodic sweep bounds each page's
// captured history by keep-N AND max-age, with a floor that always keeps the
// newest few even past the age cutoff. Runs off the hot save path. Directly seeds
// version rows (backdated) so a test isn't bound by the 45s capture-coalesce.

// Insert `count` version rows for `pageId`, aged `startAgeSec` down to
// `startAgeSec - count + 1` seconds old (oldest first), bypassing capture.
async function seedVersions(db: Db, pageId: string, count: number, startAgeSec: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const ageSec = startAgeSec - i;
    await db.query(
      `INSERT INTO page_versions (id, page_id, data, created_at)
       VALUES ($1, $2, $3::jsonb, now() - ($4::int * interval '1 second'))`,
      [randomUUID(), pageId, JSON.stringify(snapshot(`old-${i}`)), ageSec],
    );
  }
}

async function countVersions(db: Db, pageId: string): Promise<number> {
  const rows = await db.query<{n: string}>('SELECT count(*)::text AS n FROM page_versions WHERE page_id = $1', [pageId]);
  return Number(rows[0].n);
}

describe('PVH-2 — page version retention/pruning', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('keep-N prunes the oldest versions beyond the newest N (even when recent)', async () => {
    const {store, db} = await freshStore();
    const id = randomUUID();
    await store.upsertPage({id, name: 'p', data: snapshot('live')}, principal('alice'));
    // 20 recent versions (all < 1h old, so max-age never fires); keep newest 5.
    await seedVersions(db, id, 20, 3600);
    expect(await countVersions(db, id)).toBe(20);

    const pruned = await store.prunePageVersions(5, 90 * DAY_MS);
    expect(pruned).toBe(15);
    const kept = await store.listPageVersions(id);
    expect(kept).toHaveLength(5);
    // The survivors are the 5 NEWEST (smallest age). Newest-first, ages 3581..3585s
    // → payloads old-19..old-15 by the seeding scheme (age = 3600 - i).
    expect(JSON.stringify(await store.getPageVersion(id, kept[0].id))).toContain('old-19');
  });

  it('max-age prunes versions older than the cutoff, keeping the newest-few floor', async () => {
    const {store, db} = await freshStore();
    const id = randomUUID();
    await store.upsertPage({id, name: 'p', data: snapshot('live')}, principal('alice'));
    // 10 versions ALL older than 90 days (aged 100d..109d). keep-N large so only
    // the age cut is in play. The floor keeps the newest PAGE_VERSION_KEEP_MIN.
    const dayS = 24 * 60 * 60;
    await seedVersions(db, id, 10, 109 * dayS); // ages 109d (oldest) down to 100d
    expect(await countVersions(db, id)).toBe(10);

    const pruned = await store.prunePageVersions(1000, 90 * DAY_MS);
    // All 10 breach 90d, but the newest KEEP_MIN survive the floor.
    expect(pruned).toBe(10 - PAGE_VERSION_KEEP_MIN);
    expect(await countVersions(db, id)).toBe(PAGE_VERSION_KEEP_MIN);
  });

  it('a page within both limits is left untouched', async () => {
    const {store, db} = await freshStore();
    const id = randomUUID();
    await store.upsertPage({id, name: 'p', data: snapshot('live')}, principal('alice'));
    await seedVersions(db, id, 5, 3600); // 5 versions, all recent
    const pruned = await store.prunePageVersions(50, 90 * DAY_MS);
    expect(pruned).toBe(0);
    expect(await countVersions(db, id)).toBe(5);
  });

  it('prunes per page independently (one page over limit does not touch another)', async () => {
    const {store, db} = await freshStore();
    const a = randomUUID();
    const b = randomUUID();
    await store.upsertPage({id: a, name: 'a', data: snapshot('a')}, principal('alice'));
    await store.upsertPage({id: b, name: 'b', data: snapshot('b')}, principal('alice'));
    await seedVersions(db, a, 12, 3600);
    await seedVersions(db, b, 3, 3600);
    await store.prunePageVersions(5, 90 * DAY_MS);
    expect(await countVersions(db, a)).toBe(5); // trimmed to N
    expect(await countVersions(db, b)).toBe(3); // under N → untouched
  });

  it('maxAgeMs <= 0 disables the age cut (keep-N still applies)', async () => {
    const {store, db} = await freshStore();
    const id = randomUUID();
    await store.upsertPage({id, name: 'p', data: snapshot('live')}, principal('alice'));
    // All ancient (aged ~200 days) but keep-N should still retain the newest N.
    const veryOld = 200 * 24 * 60 * 60;
    await seedVersions(db, id, 8, veryOld);
    const pruned = await store.prunePageVersions(5, 0);
    expect(pruned).toBe(3);
    expect(await countVersions(db, id)).toBe(5);
  });

  it('cascade: hard-deleting the page removes its page_versions (FK ON DELETE CASCADE)', async () => {
    const {store, db} = await freshStore();
    const id = randomUUID();
    const alice = principal('alice');
    await store.upsertPage({id, name: 'p', data: snapshot('first')}, alice);
    await store.upsertPage({id, name: 'p', data: snapshot('second')}, alice); // captures a version
    expect(await countVersions(db, id)).toBeGreaterThan(0);

    // HARD delete the page row (the retention sweep's purge does this) — the
    // versions must go with it, not orphan.
    await db.query('DELETE FROM pages WHERE id = $1', [id]);
    expect(await countVersions(db, id)).toBe(0);
  });
});
