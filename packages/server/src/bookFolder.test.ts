import {rmSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {spaceToBookFiles, parseBookFolder, SPACE_BUNDLE_FILE, type PageSnapshot} from '@open-book/sdk';
import {createLocalDataClient} from './browser';
import {LocalDataClient} from './localClient';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {BookMirror} from './mirror';

const snap = (text: string): PageSnapshot => ({
  editorjs: {blocks: [{id: 'b1', type: 'paragraph', data: {text}}]},
  values: [],
  names: [],
});

let client: LocalDataClient;
let seq = 0;
let outDir: string;
let dbDir: string;

beforeEach(async () => {
  seq += 1;
  client = await createLocalDataClient({dataDir: 'memory://'});
  outDir = join(tmpdir(), `ob-folder-out-${process.pid}-${seq}`);
  dbDir = join(tmpdir(), `ob-folder-db-${process.pid}-${seq}`);
  rmSync(outDir, {recursive: true, force: true});
  rmSync(dbDir, {recursive: true, force: true});
});

afterEach(async () => {
  await (client as unknown as {store: {close(): Promise<void>}}).store.close();
  rmSync(outDir, {recursive: true, force: true});
  rmSync(dbDir, {recursive: true, force: true});
});

describe('spaceToBookFiles — folder serialisation', () => {
  it('lays out one HTML file per page plus a lossless bundle', async () => {
    const root = await client.savePage({name: 'Trip Plans', data: snap('pack sunscreen')});
    await client.savePage({name: 'Day One', data: snap('hike'), parentId: root.id});

    const files = spaceToBookFiles(await client.exportSpace());

    const htmlFiles = files.filter((f) => f.path.endsWith('.html'));
    expect(htmlFiles).toHaveLength(2);
    // Both pages live under the same book folder, named from the root page.
    for (const f of htmlFiles) expect(f.path.startsWith('trip-plans--')).toBe(true);
    expect(htmlFiles.some((f) => f.contents.includes('pack sunscreen'))).toBe(true);
    expect(files.some((f) => f.path === SPACE_BUNDLE_FILE)).toBe(true);
  });

  it('round-trips through the lossless bundle (parent + properties survive)', async () => {
    const root = await client.savePage({name: 'Alpha', data: snap('alpha')});
    await client.setPageProperties(root.id, {sys_icon: '📘'});
    const host = await client.savePage({name: 'Board', data: snap('')});
    const db = await client.createDatabase({pageId: host.id, name: 'Board'});
    await client.createRow(db.id, {name: 'Row 1'});

    const original = await client.exportSpace();
    const files = spaceToBookFiles(original);
    const parsed = parseBookFolder(files);

    expect(parsed).not.toBeNull();
    expect(parsed!.pages.map((p) => p.id).sort()).toEqual(original.pages.map((p) => p.id).sort());
    expect(parsed!.databases.map((d) => d.id)).toEqual(original.databases.map((d) => d.id));
    const alpha = parsed!.pages.find((p) => p.id === root.id);
    expect(alpha?.properties.sys_icon).toBe('📘');
  });

  it('falls back to the HTML files when the bundle is absent (flat pages)', async () => {
    await client.savePage({name: 'Solo', data: snap('just me')});
    const files = spaceToBookFiles(await client.exportSpace()).filter((f) => f.path !== SPACE_BUNDLE_FILE);

    const parsed = parseBookFolder(files);
    expect(parsed?.pages.some((p) => p.name === 'Solo')).toBe(true);
    expect(parsed?.databases).toEqual([]);
  });

  it('returns null for a folder with nothing parseable', () => {
    expect(parseBookFolder([{path: 'readme.txt', contents: 'hi'}])).toBeNull();
  });
});

describe('spaceToBookFiles — byte-compatible with the server BookMirror (OB-134)', () => {
  it('a web/desktop export imports cleanly through the server mirror', async () => {
    await client.savePage({name: 'Field Notes', data: snap('observed a heron')});
    const files = spaceToBookFiles(await client.exportSpace());

    // Write the exported HTML files to disk in their relative layout.
    for (const f of files) {
      if (!f.path.endsWith('.html')) continue;
      const abs = join(outDir, f.path);
      await mkdir(dirname(abs), {recursive: true});
      await writeFile(abs, f.contents, 'utf8');
    }

    // A fresh, empty server store imports those files via the real mirror.
    const store = new PageStore(await PgliteDb.create(dbDir));
    await store.migrate();
    const mirror = await BookMirror.create({store, dir: outDir, watch: false});
    try {
      for (const f of files) {
        if (!f.path.endsWith('.html')) continue;
        const outcome = await mirror.importFile(join(outDir, f.path));
        expect(['created', 'unchanged']).toContain(outcome);
      }
      const imported = await store.listPages();
      expect(imported.some((p) => p.name === 'Field Notes')).toBe(true);
    } finally {
      await mirror.close();
      await store.close();
    }
  });
});
