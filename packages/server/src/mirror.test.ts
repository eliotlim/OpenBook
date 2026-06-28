import {existsSync, readdirSync} from 'node:fs';
import {readFile, writeFile, readdir, mkdir} from 'node:fs/promises';
import {rmSync} from 'node:fs';
import {hostname, tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {bookHtmlToPage, pageToBookHtml, type PageSnapshot} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {BookMirror, MirrorLockedError, WriteBudgetError} from './mirror';

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
  dbDir = join(tmpdir(), `ob-mirror-db-${process.pid}-${seq}`);
  bookDir = join(tmpdir(), `ob-mirror-out-${process.pid}-${seq}`);
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

/** Find the single .html file under the book dir (one book, one page). */
async function onlyHtmlFile(): Promise<string> {
  const books = (await readdir(bookDir, {withFileTypes: true})).filter((e) => e.isDirectory());
  expect(books).toHaveLength(1);
  const folder = join(bookDir, books[0].name);
  const files = (await readdir(folder)).filter((f) => f.endsWith('.html'));
  expect(files).toHaveLength(1);
  return join(folder, files[0]);
}

describe('BookMirror write-through', () => {
  it('mirrors a page to a folder-per-book HTML file that round-trips', async () => {
    const page = await store.upsertPage({name: 'Trip Plans', data: snap('pack sunscreen')});
    const mirror = await BookMirror.create({store, dir: bookDir, watch: false});

    const file = await onlyHtmlFile();
    const html = await readFile(file, 'utf8');
    expect(html).toContain('pack sunscreen');
    const parsed = bookHtmlToPage(html);
    expect(parsed?.id).toBe(page.id);
    expect(parsed?.name).toBe('Trip Plans');
    // The book folder is named from the (root) page; the file from the page.
    expect(file).toContain('trip-plans--');
    await mirror.close();
  });

  it('writes atomically — no .tmp files survive a flush', async () => {
    await store.upsertPage({name: 'Atomic', data: snap('x')});
    const mirror = await BookMirror.create({store, dir: bookDir, watch: false});
    const folder = join(bookDir, readdirSync(bookDir).find((d) => d.startsWith('atomic--'))!);
    expect(readdirSync(folder).some((f) => f.endsWith('.tmp'))).toBe(false);
    await mirror.close();
  });

  it('rewrites the file and prunes the old one when a page is renamed', async () => {
    // A child under a stable parent, so the *book folder* stays put while the
    // child's filename changes (renaming a root would also move the folder).
    const book = await store.upsertPage({name: 'Notebook', data: snap('cover')});
    const child = await store.upsertPage({name: 'Before', data: snap('hi'), parentId: book.id});
    const mirror = await BookMirror.create({store, dir: bookDir, watch: false});
    await store.renamePage(child.id, 'After');
    mirror.enqueueWrite(child.id);
    await mirror.flush();
    const folder = join(bookDir, readdirSync(bookDir).find((d) => d.startsWith('notebook--'))!);
    const childFiles = readdirSync(folder).filter((f) => f.endsWith('.html') && !f.startsWith('notebook--'));
    expect(childFiles).toHaveLength(1);
    expect(childFiles[0]).toContain('after--');
    expect(readdirSync(folder).some((f) => f.startsWith('before--'))).toBe(false);
    await mirror.close();
  });

  it('deletes the file when a page is removed', async () => {
    const page = await store.upsertPage({name: 'Doomed', data: snap('x')});
    const mirror = await BookMirror.create({store, dir: bookDir, watch: false});
    await onlyHtmlFile(); // exists
    await store.deletePage(page.id);
    await mirror.reconcileAll();
    await mirror.flush();
    const folder = join(bookDir, readdirSync(bookDir).find((d) => d.startsWith('doomed--')) ?? 'doomed--missing');
    expect(existsSync(folder) ? readdirSync(folder).filter((f) => f.endsWith('.html')).length : 0).toBe(0);
    await mirror.close();
  });
});

describe('BookMirror journal & crash replay', () => {
  it('replays un-flushed journal entries on the next start', async () => {
    const page = await store.upsertPage({name: 'Journaled', data: snap('survive me')});
    // First mirror: enqueue but DON'T flush — simulate a crash mid-write by
    // persisting the journal and abandoning the instance.
    const crashed = await BookMirror.create({store, dir: bookDir, watch: false});
    // Wipe the just-written file to prove the replay re-creates it.
    const file = await onlyHtmlFile();
    rmSync(file);
    crashed.enqueueWrite(page.id);
    // Persist the journal without flushing (the enqueue persisted it already).
    // Abandon `crashed` without calling flush/close.

    // Second mirror over the same dir: reconcile + journal replay rewrites it.
    const restarted = await BookMirror.create({store, dir: bookDir, watch: false});
    const html = await readFile(await onlyHtmlFile(), 'utf8');
    expect(html).toContain('survive me');
    await restarted.close();
  });

  it('close() drains pending writes before resolving', async () => {
    const page = await store.upsertPage({name: 'Flush On Exit', data: snap('committed')});
    const mirror = await BookMirror.create({store, dir: bookDir, watch: false});
    await store.upsertPage({id: page.id, name: 'Flush On Exit', data: snap('edited just before exit')});
    mirror.enqueueWrite(page.id);
    await mirror.close(); // must flush the pending edit
    const html = await readFile(await onlyHtmlFile(), 'utf8');
    expect(html).toContain('edited just before exit');
  });
});

describe('BookMirror re-import (disk → DB)', () => {
  it('ignores the app\'s own write-through (no feedback loop)', async () => {
    const page = await store.upsertPage({name: 'Echo', data: snap('original')});
    const mirror = await BookMirror.create({store, dir: bookDir, watch: false});
    const action = await mirror.importFile(await onlyHtmlFile());
    expect(action).toBe('skipped'); // identical bytes to what we wrote
    expect((await store.getPage(page.id))?.data && true).toBe(true);
    await mirror.close();
  });

  it('re-imports an external edit when the DB is untouched since', async () => {
    const page = await store.upsertPage({name: 'External', data: snap('original')});
    const mirror = await BookMirror.create({store, dir: bookDir, watch: false});
    const file = await onlyHtmlFile();

    // Simulate an external tool rewriting the file with newer content. Keep the
    // same base (page.updatedAt) so the DB is "untouched since".
    const edited = pageToBookHtml({id: page.id, name: 'External', icon: null, updatedAt: page.updatedAt, data: snap('edited on disk')});
    await writeFile(file, edited, 'utf8');

    const action = await mirror.importFile(file);
    expect(action).toBe('updated');
    const after = await store.getPage(page.id);
    expect(JSON.stringify(after?.data.editorjs)).toContain('edited on disk');
    await mirror.close();
  });

  it('DB wins on conflict: imports the disk version as a suffixed copy', async () => {
    const page = await store.upsertPage({name: 'Conflicted', data: snap('v1')});
    const base = page.updatedAt;
    const mirror = await BookMirror.create({store, dir: bookDir, watch: false});
    const file = await onlyHtmlFile();

    // The DB advances (a real edit), making it strictly newer than the file's base.
    await new Promise((r) => setTimeout(r, 5));
    await store.upsertPage({id: page.id, name: 'Conflicted', data: snap('v2 from the app')});

    // Meanwhile an external tool wrote a divergent edit carrying the OLD base.
    const diverged = pageToBookHtml({id: page.id, name: 'Conflicted', icon: null, updatedAt: base, data: snap('v2 from disk')});
    await writeFile(file, diverged, 'utf8');

    const action = await mirror.importFile(file);
    expect(action).toBe('conflict');

    // The canonical page kept the app's edit (DB wins).
    const canonical = await store.getPage(page.id);
    expect(JSON.stringify(canonical?.data.editorjs)).toContain('v2 from the app');

    // The disk version landed as a new, suffixed page.
    const pages = await store.listPages();
    const copy = pages.find((p) => p.name?.startsWith('Conflicted (conflicted copy'));
    expect(copy).toBeTruthy();
    expect(copy!.id).not.toBe(page.id);
    await mirror.close();
  });

  it('converges to ONE conflict copy when an external tool re-applies the same divergent file (OB-241)', async () => {
    // Reproduces the runaway: a cloud-sync daemon (Dropbox/iCloud) re-applies the
    // same remote (divergent, stale-base) version over and over. The mirror keeps
    // restoring the canonical bytes, so the file diverges again every round — and
    // before the fix each round minted a fresh "(conflicted copy)" page + file,
    // a 10 GB write storm. It must now settle at exactly one copy.
    const page = await store.upsertPage({name: 'Hello World', data: snap('v0')});
    const base = page.updatedAt;
    const mirror = await BookMirror.create({store, dir: bookDir, watch: false});
    const file = await onlyHtmlFile();

    // The DB advances (a real app edit), making it strictly newer than the base.
    await new Promise((r) => setTimeout(r, 5));
    await store.upsertPage({id: page.id, name: 'Hello World', data: snap('v1 from app')});
    mirror.enqueueWrite(page.id);
    await mirror.flush();

    const diverged = pageToBookHtml({id: page.id, name: 'Hello World', icon: null, updatedAt: base, data: snap('v1 from disk')});
    for (let i = 0; i < 10; i += 1) {
      await writeFile(file, diverged, 'utf8'); // the sync daemon re-applies the remote
      const action = await mirror.importFile(file);
      expect(action).toBe('conflict');
      await mirror.flush(); // restore canonical + (idempotently) mirror the copy
    }

    const conflictCopies = (await store.listPages()).filter((p) => p.name?.includes('(conflicted copy'));
    expect(conflictCopies).toHaveLength(1); // one external divergence ⇒ exactly one copy
    // Data safety preserved: the disk version survives, the DB kept the app's edit.
    const copy = await store.getPage(conflictCopies[0].id);
    expect(JSON.stringify(copy?.data.editorjs)).toContain('v1 from disk');
    expect(JSON.stringify((await store.getPage(page.id))?.data.editorjs)).toContain('v1 from app');
    await mirror.close();
  });

  it('importBookPage reuses an existing conflict copy for identical divergent content (OB-241)', async () => {
    const page = await store.upsertPage({name: 'Doc', data: snap('v0')});
    const base = page.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await store.upsertPage({id: page.id, name: 'Doc', data: snap('app edit')});
    const divergent = snap('disk edit');

    const r1 = await store.importBookPage({id: page.id, name: 'Doc', data: divergent}, base);
    const r2 = await store.importBookPage({id: page.id, name: 'Doc', data: divergent}, base);
    expect(r1.action).toBe('conflict');
    expect(r2.action).toBe('conflict');
    expect(r2.page.id).toBe(r1.page.id); // same copy reused, not a duplicate
    const copies = (await store.listPages()).filter((p) => p.name?.includes('(conflicted copy'));
    expect(copies).toHaveLength(1);

    // A *different* divergent edit still earns its own copy (no data lost).
    const r3 = await store.importBookPage({id: page.id, name: 'Doc', data: snap('a different disk edit')}, base);
    expect(r3.action).toBe('conflict');
    expect(r3.page.id).not.toBe(r1.page.id);
    expect((await store.listPages()).filter((p) => p.name?.includes('(conflicted copy'))).toHaveLength(2);
  });

  it('recreates a page that is missing from the DB (restored backup)', async () => {
    const mirror = await BookMirror.create({store, dir: bookDir, watch: false});
    // A file for a page id the DB has never seen.
    const id = '99999999-9999-4999-8999-999999999999';
    const folder = join(bookDir, 'restored--99999999');
    await import('node:fs/promises').then((fs) => fs.mkdir(folder, {recursive: true}));
    const html = pageToBookHtml({id, name: 'Restored', icon: null, updatedAt: '2026-01-01T00:00:00.000Z', data: snap('from a backup')});
    await writeFile(join(folder, 'restored--99999999.html'), html, 'utf8');

    const action = await mirror.importFile(join(folder, 'restored--99999999.html'));
    expect(action).toBe('created');
    expect((await store.getPage(id))?.name).toBe('Restored');
    await mirror.close();
  });
});

describe('BookMirror single-owner lock (OB-241)', () => {
  const lockPath = (): string => join(bookDir, '.openbook-mirror.lock');

  it('refuses to mirror a directory a live foreign process owns', async () => {
    await mkdir(bookDir, {recursive: true});
    // A lock from another machine (network-synced folder): liveness is unknowable,
    // so we must assume it is live and decline rather than start a write war.
    await writeFile(
      lockPath(),
      JSON.stringify({pid: process.pid, host: 'some-other-host', startedAt: new Date().toISOString()}),
      'utf8',
    );
    await expect(BookMirror.create({store, dir: bookDir, watch: false})).rejects.toBeInstanceOf(MirrorLockedError);
  });

  it('takes over a stale lock whose holder is gone', async () => {
    await mkdir(bookDir, {recursive: true});
    await writeFile(
      lockPath(),
      JSON.stringify({pid: 999999, host: hostname(), startedAt: new Date().toISOString()}),
      'utf8',
    );
    // The recorded pid is dead → safe to claim. Mirroring proceeds normally.
    const page = await store.upsertPage({name: 'After Takeover', data: snap('ok')});
    const mirror = await BookMirror.create({store, dir: bookDir, watch: false});
    const folder = join(bookDir, readdirSync(bookDir).find((d) => d.startsWith('after-takeover--'))!);
    expect(readdirSync(folder).some((f) => f.endsWith('.html'))).toBe(true);
    expect(page.id).toBeTruthy();
    await mirror.close();
  });

  it('releases the lock on close so the next start can re-acquire it', async () => {
    await store.upsertPage({name: 'Cycle', data: snap('x')});
    const first = await BookMirror.create({store, dir: bookDir, watch: false});
    await first.close();
    // A fresh instance over the same dir must not be blocked by the prior lock.
    const second = await BookMirror.create({store, dir: bookDir, watch: false});
    expect(second).toBeTruthy();
    await second.close();
  });
});

describe('BookMirror WriteBudgetError hardening (ER-5 carry-forward)', () => {
  const lockFile = (): string => join(bookDir, '.openbook-mirror.lock');

  it('a budget trip during the bootstrap reconcile rejects AND releases the lock', async () => {
    await store.upsertPage({name: 'Boot', data: snap('x')});
    // A byte budget of 1 trips on the very first page write during create()'s
    // awaited reconcile→flush. Pre-fix this rejected with the lock still held.
    await expect(
      BookMirror.create({store, dir: bookDir, watch: false, writeBudget: {bytes: 1, intervalMs: 60_000}}),
    ).rejects.toBeInstanceOf(WriteBudgetError);
    // The single-owner lock was released on the failed bootstrap, so a clean retry
    // (here: the server degrading to run-without-mirror, then a later restart) can
    // re-acquire the directory rather than being permanently locked out.
    expect(existsSync(lockFile())).toBe(false);
    const retry = await BookMirror.create({store, dir: bookDir, watch: false});
    expect(retry).toBeTruthy();
    await retry.close();
  });

  it('a live write-through budget trip is caught/logged, not an unhandled rejection', async () => {
    const logs: string[] = [];
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      // Empty store at open → the bootstrap does no counted writes, so the tight
      // budget has headroom until the live enqueues below.
      const mirror = await BookMirror.create({
        store,
        dir: bookDir,
        watch: false,
        writeDebounceMs: 10,
        writeBudget: {writes: 1, intervalMs: 60_000},
        log: (m) => logs.push(m),
      });
      const a = await store.upsertPage({name: 'A', data: snap('a')});
      const b = await store.upsertPage({name: 'B', data: snap('b')});
      // Two enqueues schedule ONE debounced flush; draining both trips the budget on
      // the timer-driven write-through path (`scheduleFlush → void flush()`), which
      // has no awaiter — so it must be `.catch`-logged, never left unhandled.
      mirror.enqueueWrite(a.id);
      mirror.enqueueWrite(b.id);
      await new Promise((r) => setTimeout(r, 120)); // let the timer fire + flush settle
      expect(logs.some((m) => m.includes('scheduled flush failed'))).toBe(true);
      await mirror.close().catch(() => undefined); // close re-drains → may re-trip; swallow
    } finally {
      process.removeListener('unhandledRejection', onRejection);
    }
    await new Promise((r) => setTimeout(r, 20)); // drain any trailing microtasks
    // The crux: the trip surfaced via the log, not as an unhandled promise rejection
    // that could crash the host process.
    expect(rejections.filter((r) => r instanceof WriteBudgetError)).toHaveLength(0);
  });
});
