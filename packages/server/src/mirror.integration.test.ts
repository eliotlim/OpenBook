import {readdirSync, rmSync} from 'node:fs';
import {readdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {HttpDataClient, pageToBookHtml, type PageSnapshot} from '@open-book/sdk';
import {startServer, type RunningServer} from './server';

const snap = (text: string): PageSnapshot => ({
  editorjs: {blocks: [{id: 'b1', type: 'paragraph', data: {text}}]},
  values: [],
  names: [],
});

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns truthy or the deadline passes. */
async function until<T>(fn: () => Promise<T> | T, timeoutMs = 4000, stepMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return v;
    await wait(stepMs);
  }
}

let server: RunningServer | null = null;
const dataDir = join(tmpdir(), `ob-integ-db-${process.pid}`);
const bookDir = join(tmpdir(), `ob-integ-out-${process.pid}`);
const PORT = 4471;

function cleanDirs(): void {
  rmSync(dataDir, {recursive: true, force: true});
  rmSync(bookDir, {recursive: true, force: true});
}

afterEach(async () => {
  if (server) await server.close();
  server = null;
  cleanDirs();
});

async function bookFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const dir of await readdir(bookDir, {withFileTypes: true}).catch(() => [])) {
    if (dir.isDirectory()) {
      for (const f of await readdir(join(bookDir, dir.name))) {
        if (f.endsWith('.html')) out.push(join(bookDir, dir.name, f));
      }
    }
  }
  return out;
}

describe('desktop robustness acceptance (server + mirror)', () => {
  it('mirrors live edits, syncs multiple clients, re-imports external edits, and resolves conflicts DB-wins', async () => {
    cleanDirs();
    server = await startServer({dataDir, bookDir, host: '127.0.0.1', port: PORT});
    const a = new HttpDataClient(server.url);
    const b = new HttpDataClient(server.url);

    // ── 1. Concurrent multi-client writes all persist (serialized store) ──
    const created = await Promise.all([
      a.savePage({name: 'Alpha', data: snap('alpha body')}),
      a.savePage({name: 'Bravo', data: snap('bravo body')}),
      b.savePage({name: 'Charlie', data: snap('charlie body')}),
    ]);
    expect(new Set(created.map((p) => p.id)).size).toBe(3);
    expect((await a.listPages()).length).toBeGreaterThanOrEqual(3);

    // ── 2. Live cross-client fan-out over SSE (OB-131) ──
    // The browser client uses EventSource (WKWebView/browser only); here we read
    // the server's `/api/live` firehose directly with fetch to prove a write by
    // one client fans out to a separate connected listener.
    const target = created[0];
    const ac = new AbortController();
    let pushed = '';
    const sse = fetch(`${server.url}/api/live`, {signal: ac.signal}).then(async (res) => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        buf += decoder.decode(value, {stream: true});
        if (buf.includes('edited by A')) pushed = buf;
      }
    }).catch(() => undefined);
    await wait(150); // let the stream attach
    await a.savePage({id: target.id, name: 'Alpha', data: snap('edited by A')});
    await until(() => pushed !== '');
    ac.abort();
    await sse;
    expect(pushed).toContain('"type":"page"');
    expect(pushed).toContain('edited by A');

    // ── 3. Write-through reaches disk (OB-134) ──
    await until(async () => (await bookFiles()).length >= 3);
    const files = await bookFiles();
    expect(files.length).toBeGreaterThanOrEqual(3);
    // Wait for the latest edit to actually land on disk before editing it
    // externally — otherwise a still-pending write-through would clobber us
    // (a real race only inside the brief debounce after an app save).
    const alphaFile = files.find((f) => f.includes('alpha--'))!;
    await until(async () => (await readFile(alphaFile, 'utf8')).includes('edited by A'), 6000);
    // No partial/temp files ever observed.
    for (const dir of readdirSync(bookDir, {withFileTypes: true})) {
      if (!dir.isDirectory()) continue;
      const folder = join(bookDir, dir.name);
      expect(readdirSync(folder).some((f) => f.endsWith('.tmp'))).toBe(false);
    }

    // ── 4. External edit is re-imported via the live fs watcher (OB-135) ──
    const current = await a.getPage(target.id);
    const externallyEdited = pageToBookHtml({
      id: target.id,
      name: 'Alpha',
      icon: null,
      updatedAt: current!.updatedAt, // same base → DB untouched since → apply
      data: snap('edited directly on disk'),
    });
    await writeFile(alphaFile, externallyEdited, 'utf8');
    const reimported = await until(async () => {
      const p = await a.getPage(target.id);
      return JSON.stringify(p?.data.editorjs).includes('edited directly on disk') ? p : null;
    }, 6000);
    expect(JSON.stringify(reimported?.data.editorjs)).toContain('edited directly on disk');

    // ── 5. Conflict → DB wins, disk version lands as a suffixed copy (OB-136) ──
    const bravo = created[1];
    const bravoBase = (await a.getPage(bravo.id))!.updatedAt;
    await wait(5);
    await a.savePage({id: bravo.id, name: 'Bravo', data: snap('bravo from the app (newer)')});
    const bravoFile = (await bookFiles()).find((f) => f.includes('bravo--'))!;
    // Let the app's write-through settle before the divergent external write,
    // so the conflicting edit is the last writer (not clobbered by the mirror).
    await until(async () => (await readFile(bravoFile, 'utf8')).includes('bravo from the app (newer)'), 6000);
    const diverged = pageToBookHtml({
      id: bravo.id,
      name: 'Bravo',
      icon: null,
      updatedAt: bravoBase, // stale base → DB is newer → conflict
      data: snap('bravo from disk (divergent)'),
    });
    await writeFile(bravoFile, diverged, 'utf8');
    const copy = await until(async () =>
      (await a.listPages()).find((p) => p.name?.startsWith('Bravo (conflicted copy')) ?? null, 6000);
    expect(copy).toBeTruthy();
    // The canonical page kept the app's edit.
    expect(JSON.stringify((await a.getPage(bravo.id))?.data.editorjs)).toContain('bravo from the app (newer)');
  });

  it('loses no committed data across a server restart and keeps the mirror consistent (OB-132)', async () => {
    cleanDirs();
    server = await startServer({dataDir, bookDir, host: '127.0.0.1', port: PORT});
    let client = new HttpDataClient(server.url);
    const page = await client.savePage({name: 'Durable', data: snap('committed before restart')});
    // Edit right up to shutdown; close() must flush the mirror journal.
    await client.savePage({id: page.id, name: 'Durable', data: snap('last edit before exit')});
    await server.close();

    // Restart over the same data + book dirs.
    server = await startServer({dataDir, bookDir, host: '127.0.0.1', port: PORT});
    client = new HttpDataClient(server.url);
    const survivor = await client.getPage(page.id);
    expect(JSON.stringify(survivor?.data.editorjs)).toContain('last edit before exit');

    // The on-disk mirror reflects the last edit too (flushed on exit, no .tmp).
    const file = (await bookFiles()).find((f) => f.includes('durable--'))!;
    expect(file).toBeTruthy();
    expect(await readFile(file, 'utf8')).toContain('last edit before exit');
  });
});
