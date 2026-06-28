import {readdir, writeFile, stat} from 'node:fs/promises';
import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {pageToBookHtml, type PageSnapshot} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {BookMirror, MirrorLockedError, WriteBudgetError} from './mirror';

// Soak / smoke suite for the OB-241 mirror hardening (ER-1..ER-4). Auto-collected
// by vitest (src/**/*.test.ts). Each scenario drives the mirror with
// `watch:false` + explicit importFile/enqueueWrite/flush (no FS-event timing), so
// it is deterministic and fast. Scales are kept modest (≤ a few hundred rounds)
// so the whole file runs in well under a second of actual work.

const snap = (text: string): PageSnapshot => ({
  editorjs: {blocks: [{id: 'b1', type: 'paragraph', data: {text}}]},
  values: [],
  names: [],
});

let store: PageStore;
let dbDir: string;
let bookDir: string;
let seq = 0;

beforeEach(async () => {
  seq += 1;
  dbDir = join(tmpdir(), `ob-soak-db-${process.pid}-${seq}`);
  bookDir = join(tmpdir(), `ob-soak-out-${process.pid}-${seq}`);
  rmSync(dbDir, {recursive: true, force: true});
  rmSync(bookDir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dbDir));
  await store.migrate();
});

afterEach(async () => {
  await store.close();
  rmSync(dbDir, {recursive: true, force: true});
  rmSync(bookDir, {recursive: true, force: true});
});

/** Every `.html` file across all book folders (excludes the dot state/lock files). */
async function htmlFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const book of await readdir(bookDir, {withFileTypes: true})) {
    if (!book.isDirectory()) continue;
    const folder = join(bookDir, book.name);
    for (const f of await readdir(folder)) if (f.endsWith('.html')) out.push(join(folder, f));
  }
  return out;
}

/** Total on-disk size of every book HTML file (the durable footprint). */
async function footprint(): Promise<number> {
  let total = 0;
  for (const f of await htmlFiles()) total += (await stat(f)).size;
  return total;
}

/** Any orphaned atomic-write temp files anywhere under the mirror dir. */
async function tmpSurvivors(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, {withFileTypes: true})) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.includes('.tmp')) out.push(p);
    }
  };
  await walk(bookDir);
  return out;
}

const conflictCopies = async (): Promise<string[]> =>
  (await store.listPages()).filter((p) => p.name?.includes('(conflicted copy')).map((p) => p.id);

describe('BookMirror soak — OB-241 hardening (ER-1..ER-4)', () => {
  it('S1: scaled re-apply storm converges — constant footprint + bounded amplification', async () => {
    const N = 200;
    const page = await store.upsertPage({name: 'Hello World', data: snap('v0')});
    const base = page.updatedAt;
    const mirror = await BookMirror.create({store, dir: bookDir, watch: false});

    // A real app edit advances the DB strictly past the file's base → every
    // re-apply of the stale-base file below is a genuine DB-wins conflict.
    await new Promise((r) => setTimeout(r, 5));
    await store.upsertPage({id: page.id, name: 'Hello World', data: snap('v1 from app')});
    mirror.enqueueWrite(page.id);
    await mirror.flush();

    const canonicalFile = (await htmlFiles())[0];
    const diverged = pageToBookHtml({id: page.id, name: 'Hello World', icon: null, updatedAt: base, data: snap('v1 from disk')});
    const renderedBytes = Buffer.byteLength(diverged, 'utf8');

    const round = async (): Promise<void> => {
      await writeFile(canonicalFile, diverged, 'utf8'); // the sync daemon re-applies the remote
      expect(await mirror.importFile(canonicalFile)).toBe('conflict');
      await mirror.flush(); // restore canonical + (idempotently) mirror the copy
    };

    for (let i = 0; i < N; i += 1) await round();
    const footprintN = await footprint();
    const filesN = (await htmlFiles()).length;
    expect((await conflictCopies()).length).toBe(1);

    for (let i = N; i < 2 * N; i += 1) await round();
    const footprint2N = await footprint();

    // Constant footprint: doubling the re-apply work adds NO disk (one canonical +
    // one copy, forever) — the storm is dead.
    expect(footprint2N).toBe(footprintN);
    // One file per live page (canonical + the single conflict copy), nothing extra.
    expect((await htmlFiles()).length).toBe(filesN);
    expect((await htmlFiles()).length).toBe((await store.listPages()).length);
    // Exactly one conflict copy for the single external divergence.
    expect((await conflictCopies()).length).toBe(1);
    expect(store.copiesMinted).toBe(1);

    // Bounded write-amplification (ER-2): total bytes / rounds stays a small
    // constant. Pre-OB-241 this grew without bound (a fresh copy + a growing
    // state journal every round). AMP allows the per-round canonical restore plus
    // generous journal/temp overhead; a regression to per-round copies blows it.
    const rounds = 2 * N;
    const amplification = mirror.metrics().bytesWritten / rounds;
    const AMP = renderedBytes * 6;
    expect(amplification).toBeLessThanOrEqual(AMP);

    expect(await tmpSurvivors()).toEqual([]);
    await mirror.close();
  });

  it('S2: a second owner of the same dir is refused (MirrorLockedError)', async () => {
    const owner = await BookMirror.create({store, dir: bookDir, watch: false}); // owner #1 holds the lock

    // Simulate a *second machine* already owning the (network-synced) folder:
    // its liveness is unknowable, so a fresh open must decline rather than start a
    // mutual write-through war.
    await writeFile(
      join(bookDir, '.openbook-mirror.lock'),
      JSON.stringify({pid: process.pid, host: 'second-machine', startedAt: new Date().toISOString()}),
      'utf8',
    );
    await expect(BookMirror.create({store, dir: bookDir, watch: false})).rejects.toBeInstanceOf(MirrorLockedError);

    await owner.close();
  });

  it('S3: edit↔external interleave — canonical == last app edit; one copy per distinct divergence', async () => {
    const page = await store.upsertPage({name: 'Doc', data: snap('v0')});
    const mirror = await BookMirror.create({store, dir: bookDir, watch: false});
    const file = (await htmlFiles())[0];

    // A mix of identical re-applies (must reuse) and distinct divergent contents
    // (must each earn their own copy). Distinct set = {A, B, C} → 3 copies.
    const steps: Array<{content: string}> = [
      {content: 'disk-A'},
      {content: 'disk-A'}, // identical re-apply → reuse, no new copy
      {content: 'disk-B'},
      {content: 'disk-B'},
      {content: 'disk-C'},
      {content: 'disk-A'}, // back to A → still the existing A copy
    ];

    let appEdit = '';
    for (let i = 0; i < steps.length; i += 1) {
      const current = (await store.getPage(page.id))!;
      const fileBase = current.updatedAt; // file carries the *stale* base
      await new Promise((r) => setTimeout(r, 5));
      appEdit = `app edit ${i}`;
      await store.upsertPage({id: page.id, name: 'Doc', data: snap(appEdit)}); // DB advances past fileBase
      const diverged = pageToBookHtml({id: page.id, name: 'Doc', icon: null, updatedAt: fileBase, data: snap(steps[i].content)});
      await writeFile(file, diverged, 'utf8');
      expect(await mirror.importFile(file)).toBe('conflict');
      await mirror.flush();
    }

    // DB wins: the canonical page holds the most recent app edit.
    expect(JSON.stringify((await store.getPage(page.id))?.data.editorjs)).toContain(appEdit);
    // One copy per distinct divergent content (A, B, C) — identical re-applies reused.
    const distinct = new Set(steps.map((s) => s.content)).size;
    expect((await conflictCopies()).length).toBe(distinct);
    expect(store.copiesMinted).toBe(distinct);
    expect(await tmpSurvivors()).toEqual([]);
    await mirror.close();
  });

  it('S4: large-book reconcile — a no-change reconcile does ZERO disk writes (ER-1)', async () => {
    const N = 200;
    const book = await store.upsertPage({name: 'Big Book', data: snap('cover')});
    for (let i = 0; i < N; i += 1) {
      await store.upsertPage({name: `Page ${i}`, data: snap(`body ${i}`), parentId: book.id});
    }
    const mirror = await BookMirror.create({store, dir: bookDir, watch: false});
    expect((await htmlFiles()).length).toBe(N + 1); // root + N children

    // 2nd, no-change reconcile + flush must touch disk zero times.
    const before = mirror.metrics().writeCount;
    await mirror.reconcileAll();
    await mirror.flush();
    expect(mirror.metrics().writeCount - before).toBe(0);

    // Directly exercise ER-1's writePageFile skip: force-enqueue every page (each
    // enters writePageFile) and flush; not one HTML file is rewritten — proven by
    // unchanged mtimes (atomicWrite would mint a new file via rename).
    const mtimes = new Map<string, number>();
    for (const f of await htmlFiles()) mtimes.set(f, (await stat(f)).mtimeMs);
    for (const p of await store.listPages()) mirror.enqueueWrite(p.id);
    await mirror.flush();
    for (const [f, m] of mtimes) expect((await stat(f)).mtimeMs).toBe(m);

    expect(await tmpSurvivors()).toEqual([]);
    await mirror.close();
  });

  it('ER-2: an active write budget warns AND throws on runaway writes', async () => {
    const page = await store.upsertPage({name: 'Budget', data: snap('v0')});
    // Generous enough to open (lock + initial mirror), tight enough that a churn
    // loop trips it. Long window so the test is timing-independent.
    const mirror = await BookMirror.create({store, dir: bookDir, watch: false, writeBudget: {writes: 20, intervalMs: 60_000}});

    await expect(
      (async () => {
        for (let i = 0; i < 100; i += 1) {
          await store.upsertPage({id: page.id, name: 'Budget', data: snap(`v${i}`)});
          mirror.enqueueWrite(page.id);
          await mirror.flush();
        }
      })(),
    ).rejects.toBeInstanceOf(WriteBudgetError);

    await mirror.close();
  });

  it('ER-4: a per-page-id copy cap trips before a distinct-content storm runs away', async () => {
    const page = await store.upsertPage({name: 'Capped', data: snap('v0')});
    const mirror = await BookMirror.create({store, dir: bookDir, watch: false, writeBudget: {copies: 2, copyWindowMs: 60_000}});
    const file = (await htmlFiles())[0];

    const mint = async (content: string): Promise<void> => {
      const current = (await store.getPage(page.id))!;
      const fileBase = current.updatedAt;
      await new Promise((r) => setTimeout(r, 5));
      await store.upsertPage({id: page.id, name: 'Capped', data: snap(`app ${content}`)});
      const diverged = pageToBookHtml({id: page.id, name: 'Capped', icon: null, updatedAt: fileBase, data: snap(content)});
      await writeFile(file, diverged, 'utf8');
      await mirror.importFile(file);
      await mirror.flush();
    };

    await mint('distinct-1'); // copy #1 — ok
    await mint('distinct-2'); // copy #2 — ok (== cap)
    await expect(mint('distinct-3')).rejects.toBeInstanceOf(WriteBudgetError); // #3 trips the cap

    await mirror.close();
  });
});
