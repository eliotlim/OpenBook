import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {type PageSnapshot} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';

// OB-241 follow-up: the owner saw a *nested* conflict copy in the wild and asked
// whether the convergence fix holds. The real DB dump showed 502 pages / 493
// conflict copies of base name "Hello World", but those 491+ copies collapse to
// only 2 DISTINCT `data` contents (45 of one, 447 of the other) differing by a
// single embedded timestamp ~0.75s apart — i.e. the SAME content minted hundreds
// of times = the storm; plus 11 copies nested to depth 2
// (`X (conflicted copy T1) (conflicted copy T2)`). These tests pin the properties
// that make that dump converge, and prove the suffix-strip caps the chain at one
// level so a conflict-of-conflict can't deep-chain.

let seq = 0;
const dirs: string[] = [];
const stores: PageStore[] = [];

async function freshStore(): Promise<PageStore> {
  seq += 1;
  const dir = join(tmpdir(), `ob-conflict-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  dirs.push(dir);
  const store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  stores.push(store);
  return store;
}

afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true});
});

const snap = (text: string): PageSnapshot => ({
  editorjs: {blocks: [{id: 'b1', type: 'paragraph', data: {text}}]},
  values: [],
  names: [],
});

/** Count "(conflicted copy" markers in a name → its nesting depth. */
const depth = (name: string | null | undefined): number => (name?.match(/\(conflicted copy/g) ?? []).length;

const conflictCopies = async (store: PageStore) =>
  (await store.listPages()).filter((p) => p.name?.includes('(conflicted copy'));

/**
 * Drive a page into the conflict branch: create it, capture its base, then advance
 * the DB (a real app edit) so the DB row is strictly newer than the file's base.
 * The returned `base` is what a stale-base mirror file would carry.
 */
async function divergedPage(store: PageStore, name: string) {
  const page = await store.upsertPage({name, data: snap('v0')});
  const base = page.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  await store.upsertPage({id: page.id, name, data: snap('app edit (DB wins)')});
  return {id: page.id, base};
}

describe('OB-241 — conflict-copy storm convergence', () => {
  it('storm: re-applying ONE divergent file N=100 times mints exactly ONE copy, counter advances once', async () => {
    // The dump's storm: a sync daemon (Dropbox/iCloud/Syncthing) re-applies the
    // SAME stale-base divergent file forever. The mirror keeps restoring canonical
    // bytes, so the file diverges again every round. Pre-fix: a fresh copy each
    // round. Now: exactly one copy, and copiesMinted (ER-2 metric) advances once.
    const store = await freshStore();
    const {id, base} = await divergedPage(store, 'Hello World');
    const divergent = snap('v1 from disk');

    const before = store.copiesMinted;
    for (let i = 0; i < 100; i += 1) {
      const r = await store.importBookPage({id, name: 'Hello World', data: divergent}, base);
      expect(r.action).toBe('conflict');
    }

    expect(await conflictCopies(store)).toHaveLength(1); // one external divergence ⇒ one copy, not 100
    expect(store.copiesMinted - before).toBe(1); // counted once, not per re-apply

    // Data safety preserved: the divergent disk content survived.
    const [copy] = await conflictCopies(store);
    const full = await store.getPage(copy.id);
    expect(JSON.stringify(full?.data.editorjs)).toContain('v1 from disk');
  });

  it('two genuine divergent versions → exactly TWO copies (no over-collapse of distinct edits)', async () => {
    // The dump's reality: 2 genuine save events (distinct embedded timestamps,
    // stable once written) → 2 distinct contents. Re-applying each many times must
    // settle at exactly 2 — convergence must NOT collapse two real edits into one.
    const store = await freshStore();
    const {id, base} = await divergedPage(store, 'Hello World');
    const versionA = snap('saved 2026-06-28T05:00:05.352Z');
    const versionB = snap('saved 2026-06-28T05:00:06.105Z'); // ~0.75s apart, the dump's split

    const before = store.copiesMinted;
    for (let i = 0; i < 50; i += 1) {
      expect((await store.importBookPage({id, name: 'Hello World', data: versionA}, base)).action).toBe('conflict');
      expect((await store.importBookPage({id, name: 'Hello World', data: versionB}, base)).action).toBe('conflict');
    }

    const copies = await conflictCopies(store);
    expect(copies).toHaveLength(2); // two genuine edits ⇒ two copies
    expect(store.copiesMinted - before).toBe(2); // counted exactly twice
    const full = await Promise.all(copies.map((p) => store.getPage(p.id)));
    const contents = new Set(full.map((p) => JSON.stringify(p?.data.editorjs)));
    expect(contents.size).toBe(2); // both genuine versions preserved, distinct
  });

  it('mtime-stability: the conflict path stores record.data byte-for-byte (no stampSnapshotMtimes)', async () => {
    // This is the property that makes the dump converge: the conflict branch stores
    // record.data verbatim, so the `data = $2::jsonb` reuse equality holds across
    // re-applies. If it re-stamped mtimes with nowIso (as the apply path does), the
    // bytes would drift every cycle, reuse could never match, and the storm would
    // re-open. Pin it so a future edit can't silently break convergence.
    const store = await freshStore();
    const {id, base} = await divergedPage(store, 'Doc');
    const divergent: PageSnapshot = {...snap('disk edit'), mtimes: [['b1', '2020-01-01T00:00:00.000Z']]};

    const r = await store.importBookPage({id, name: 'Doc', data: divergent}, base);
    expect(r.action).toBe('conflict');

    // The conflict path writes JSON.stringify(record.data) verbatim (no stamping).
    // Read-back through PGlite jsonb normalizes key ORDER but not content, so assert
    // deep equality — and crucially the embedded mtimes are unchanged, not nowIso.
    // (jsonb equality is order-independent, so the `data = $2::jsonb` reuse below
    // still matches across re-applies regardless of key order.)
    const stored = await store.getPage(r.page.id);
    expect(stored?.data).toEqual(divergent); // content preserved verbatim
    expect(stored?.data.mtimes).toEqual([['b1', '2020-01-01T00:00:00.000Z']]); // NOT re-stamped to nowIso

    // And because the bytes are stable, a re-apply of the same file reuses the copy.
    const r2 = await store.importBookPage({id, name: 'Doc', data: divergent}, base);
    expect(r2.page.id).toBe(r.page.id);
    expect(await conflictCopies(store)).toHaveLength(1);
  });
});

describe('OB-241 — nested (conflict-of-conflict) convergence + name capping', () => {
  it("a conflict copy's OWN mirror file converges and does NOT grow a (…)(…)(…) chain", async () => {
    // The owner's in-the-wild case: a page whose NAME is already a conflict copy
    // ("Hello World (conflicted copy T1)") has its own mirror file diverge. Pre-fix
    // each re-apply would mint a deeper-nested name. It must converge to one copy
    // and cap the name at depth 1.
    const store = await freshStore();
    const nestedName = 'Hello World (conflicted copy 2026-06-28T05:00:05.352Z)';
    const {id, base} = await divergedPage(store, nestedName);
    const divergent = snap('nested disk edit');

    const before = store.copiesMinted;
    for (let i = 0; i < 100; i += 1) {
      const r = await store.importBookPage({id, name: nestedName, data: divergent}, base);
      expect(r.action).toBe('conflict');
    }

    // The original nested-named page itself contains the marker; the MINTED copy is
    // the one with a different id.
    const minted = (await conflictCopies(store)).filter((p) => p.id !== id);
    expect(minted).toHaveLength(1); // converged: one copy, not 100
    expect(store.copiesMinted - before).toBe(1);
    expect(depth(minted[0].name)).toBe(1); // capped at one level — no deep chain
    expect(minted[0].name).toMatch(/^Hello World \(conflicted copy [^()]+\)$/);
  });

  it('minting from a depth-1 conflict file yields a depth-1 (not depth-2) name', async () => {
    // Focused suffix-strip assertion: the existing suffix is stripped and exactly
    // one level is re-added. Pre-strip this minted "… (conflicted copy T1) (conflicted copy now)".
    const store = await freshStore();
    const depth1Name = 'Hello World (conflicted copy 2026-06-28T05:00:05.352Z)';
    const {id, base} = await divergedPage(store, depth1Name);

    const r = await store.importBookPage({id, name: depth1Name, data: snap('disk edit')}, base);
    expect(r.action).toBe('conflict');
    expect(depth(r.page.name)).toBe(1);
    expect(r.page.name).not.toContain(') (conflicted copy'); // no chaining
  });

  it('a depth-2 name collapses back to depth-1 on mint (caps even an already-deep chain)', async () => {
    const store = await freshStore();
    const depth2Name = 'Hello World (conflicted copy T1) (conflicted copy T2)';
    const {id, base} = await divergedPage(store, depth2Name);

    const r = await store.importBookPage({id, name: depth2Name, data: snap('disk edit')}, base);
    expect(r.action).toBe('conflict');
    expect(depth(r.page.name)).toBe(1); // both existing levels stripped, one re-added
    expect(r.page.name).toMatch(/^Hello World \(conflicted copy [^()]+\)$/);
  });

  it('an unrelated parenthetical in the title is never mistaken for a conflict suffix', async () => {
    const store = await freshStore();
    const name = 'Budget (Q3) Notes';
    const {id, base} = await divergedPage(store, name);

    const r = await store.importBookPage({id, name, data: snap('disk edit')}, base);
    expect(r.action).toBe('conflict');
    expect(r.page.name).toMatch(/^Budget \(Q3\) Notes \(conflicted copy [^()]+\)$/); // (Q3) preserved
  });
});
