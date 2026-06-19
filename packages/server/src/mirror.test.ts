import {existsSync, readdirSync} from 'node:fs';
import {readFile, writeFile, readdir} from 'node:fs/promises';
import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {bookHtmlToPage, pageToBookHtml, type PageSnapshot} from '@open-book/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {BookMirror} from './mirror';

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
