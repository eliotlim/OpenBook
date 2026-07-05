/**
 * BookMirror × the folder-level viewer runtime (`_openbook/viewer.js`).
 *
 * Owner decision 2026-07-04: the sync folder must NOT vendor the viewer bundle
 * into every `.book.html` (mirror bloat / write-amp) — each page carries only a
 * byte-constant relative reference, and the folder holds ONE bundle copy. These
 * tests pin the write-economy contract of that design:
 *
 *  - the bundle is written once at open, and page-save churn NEVER rewrites it;
 *  - a bundle content change (app upgrade) rewrites ONLY the bundle — the N page
 *    files keep their exact bytes (the reference has no version/hash variance);
 *  - GAINING/LOSING the runtime is the one deliberate whole-folder rewrite
 *    (upgrade-class), tracked by the persisted `runtimeHash` format marker;
 *  - a converged folder reopens with ZERO disk writes (steady state);
 *  - the watcher/importer treats `_openbook/` as inert (never re-imported), and
 *    an externally-diverged bundle is restored at the next open;
 *  - the own-write hash index stays coherent throughout (own writes skipped).
 */

import {existsSync} from 'node:fs';
import {readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {BOOK_RUNTIME_DIR, BOOK_RUNTIME_FILE, type PageSnapshot} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {BookMirror} from './mirror';

const RT1 = 'var OpenBookViewer = {mount: function () {}}; /* bundle v1 */';
const RT2 = 'var OpenBookViewer = {mount: function () {}}; /* bundle v2 — upgraded */';

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
  dbDir = join(tmpdir(), `ob-mirror-rt-db-${process.pid}-${seq}`);
  bookDir = join(tmpdir(), `ob-mirror-rt-out-${process.pid}-${seq}`);
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

const bundlePath = (): string => join(bookDir, BOOK_RUNTIME_FILE);

/** Every page .html under the book dir (skipping the runtime dir). */
async function htmlFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(bookDir, {withFileTypes: true})) {
    if (!entry.isDirectory() || entry.name === BOOK_RUNTIME_DIR || entry.name.startsWith('.')) continue;
    for (const f of await readdir(join(bookDir, entry.name))) {
      if (f.endsWith('.html')) out.push(join(bookDir, entry.name, f));
    }
  }
  return out.sort();
}

describe('BookMirror runtime bundle — write economy', () => {
  it('writes the bundle once at open; page-save churn NEVER rewrites it', async () => {
    const page = await store.upsertPage({name: 'Churny', data: snap('v0')});
    const mirror = await BookMirror.create({store, dir: bookDir, watch: false, runtimeBundle: RT1});

    expect(await readFile(bundlePath(), 'utf8')).toBe(RT1);
    const before = await stat(bundlePath());
    const writesAfterOpen = mirror.metrics().writeCount;

    // A burst of page saves (the churn the design protects against).
    for (let i = 1; i <= 5; i += 1) {
      await store.upsertPage({id: page.id, name: 'Churny', data: snap(`v${i}`)});
      mirror.enqueueWrite(page.id);
      await mirror.flush();
    }

    const after = await stat(bundlePath());
    expect(after.mtimeMs).toBe(before.mtimeMs); // untouched by page churn
    expect(await readFile(bundlePath(), 'utf8')).toBe(RT1);
    // The churn wrote page + state files only; sanity that writes did happen.
    expect(mirror.metrics().writeCount).toBeGreaterThan(writesAfterOpen);
    await mirror.close();
  });

  it('every page file references the runtime relatively (and hydration is opt-out-safe)', async () => {
    await store.upsertPage({name: 'Reader', data: snap('hello')});
    const mirror = await BookMirror.create({store, dir: bookDir, watch: false, runtimeBundle: RT1});
    const [file] = await htmlFiles();
    const html = await readFile(file, 'utf8');
    expect(html).toContain('<script src="../_openbook/viewer.js" defer data-openbook-runtime></script>');
    expect(html).toContain('data-openbook-runtime-boot');
    await mirror.close();
  });

  it('reopening with the SAME bundle writes nothing (converged steady state)', async () => {
    await store.upsertPage({name: 'Steady', data: snap('same')});
    const first = await BookMirror.create({store, dir: bookDir, watch: false, runtimeBundle: RT1});
    await first.close();

    const bundleBefore = await stat(bundlePath());
    const [pageFile] = await htmlFiles();
    const pageBefore = await stat(pageFile);

    const second = await BookMirror.create({store, dir: bookDir, watch: false, runtimeBundle: RT1});
    expect((await stat(bundlePath())).mtimeMs).toBe(bundleBefore.mtimeMs);
    expect((await stat(pageFile)).mtimeMs).toBe(pageBefore.mtimeMs);
    await second.close();
  });

  it('a bundle CONTENT change rewrites only the bundle — page files keep their exact bytes', async () => {
    await store.upsertPage({name: 'Upgrade', data: snap('stable content')});
    const v1 = await BookMirror.create({store, dir: bookDir, watch: false, runtimeBundle: RT1});
    await v1.close();

    const [pageFile] = await htmlFiles();
    const pageBytesBefore = await readFile(pageFile, 'utf8');
    const pageStatBefore = await stat(pageFile);

    // The app upgraded: same folder, new bundle bytes.
    const v2 = await BookMirror.create({store, dir: bookDir, watch: false, runtimeBundle: RT2});
    expect(await readFile(bundlePath(), 'utf8')).toBe(RT2); // bundle upgraded…
    expect(await readFile(pageFile, 'utf8')).toBe(pageBytesBefore); // …pages byte-identical
    expect((await stat(pageFile)).mtimeMs).toBe(pageStatBefore.mtimeMs); // and never rewritten
    await v2.close();
  });
});

describe('BookMirror runtime bundle — format flips (upgrade-class rewrite)', () => {
  it('GAINING the runtime rewrites every page once with the reference', async () => {
    await store.upsertPage({name: 'Legacy A', data: snap('a')});
    await store.upsertPage({name: 'Legacy B', data: snap('b')});
    const legacy = await BookMirror.create({store, dir: bookDir, watch: false});
    await legacy.close();
    for (const f of await htmlFiles()) expect(await readFile(f, 'utf8')).not.toContain('_openbook');
    expect(existsSync(bundlePath())).toBe(false);

    // The app upgraded to a runtime-carrying version: one-time whole-folder rewrite.
    const upgraded = await BookMirror.create({store, dir: bookDir, watch: false, runtimeBundle: RT1});
    expect(await readFile(bundlePath(), 'utf8')).toBe(RT1);
    const files = await htmlFiles();
    expect(files).toHaveLength(2);
    for (const f of files) expect(await readFile(f, 'utf8')).toContain('data-openbook-runtime');
    await upgraded.close();

    // …and it IS one-time: the next open over the converged folder writes nothing.
    const statsBefore = await Promise.all(files.map((f) => stat(f)));
    const steady = await BookMirror.create({store, dir: bookDir, watch: false, runtimeBundle: RT1});
    const statsAfter = await Promise.all(files.map((f) => stat(f)));
    statsAfter.forEach((s, i) => expect(s.mtimeMs).toBe(statsBefore[i].mtimeMs));
    await steady.close();
  });

  it('LOSING the runtime strips the reference and removes _openbook/', async () => {
    await store.upsertPage({name: 'Downgrade', data: snap('x')});
    const withRt = await BookMirror.create({store, dir: bookDir, watch: false, runtimeBundle: RT1});
    await withRt.close();
    expect(existsSync(bundlePath())).toBe(true);

    const without = await BookMirror.create({store, dir: bookDir, watch: false});
    expect(existsSync(bundlePath())).toBe(false);
    expect(existsSync(join(bookDir, BOOK_RUNTIME_DIR))).toBe(false);
    const [file] = await htmlFiles();
    expect(await readFile(file, 'utf8')).not.toContain('_openbook');
    await without.close();
  });
});

describe('BookMirror runtime bundle — the importer/watcher treat _openbook as inert', () => {
  it('importFile on the bundle is a no-op and an external bundle edit never re-imports', async () => {
    const page = await store.upsertPage({name: 'Watched', data: snap('original')});
    const mirror = await BookMirror.create({
      store,
      dir: bookDir,
      watch: true,
      importDebounceMs: 30,
      runtimeBundle: RT1,
    });

    // Direct import of the runtime: skipped (not a book page).
    expect(await mirror.importFile(bundlePath())).toBe('skipped');

    // An external tool scribbles on the bundle. The watcher must not route it
    // anywhere near the importer (it ignores `_openbook/` wholesale) — the DB
    // content stays untouched either way.
    await writeFile(bundlePath(), 'window.evil = true;', 'utf8');
    await new Promise((r) => setTimeout(r, 250)); // > importDebounceMs
    const dbPage = await store.getPage(page.id);
    expect(JSON.stringify(dbPage?.data)).toContain('original');
    expect((await store.listPages()).length).toBe(1); // no conflict copies minted
    await mirror.close();

    // The mirror repairs the diverged bundle at the next open (canonical wins).
    const reopened = await BookMirror.create({store, dir: bookDir, watch: false, runtimeBundle: RT1});
    expect(await readFile(bundlePath(), 'utf8')).toBe(RT1);
    await reopened.close();
  });
});
