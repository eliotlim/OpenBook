import {rmSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  libraryToBookFiles,
  parseBookFolder,
  SPACE_BUNDLE_FILE,
  LEGACY_SPACE_BUNDLE_FILE,
  BOOK_RUNTIME_FILE,
  type PageSnapshot,
} from '@book.dev/sdk';
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

describe('libraryToBookFiles — folder serialisation', () => {
  it('lays out one HTML file per page plus a lossless bundle', async () => {
    const root = await client.savePage({name: 'Trip Plans', data: snap('pack sunscreen')});
    await client.savePage({name: 'Day One', data: snap('hike'), parentId: root.id});

    const files = libraryToBookFiles(await client.exportLibrary());

    const htmlFiles = files.filter((f) => f.path.endsWith('.html'));
    expect(htmlFiles).toHaveLength(2);
    // Both pages live under the same book folder, named from the root page.
    for (const f of htmlFiles) expect(f.path.startsWith('trip-plans--')).toBe(true);
    expect(htmlFiles.some((f) => f.contents.includes('pack sunscreen'))).toBe(true);
    expect(files.some((f) => f.path === SPACE_BUNDLE_FILE)).toBe(true);
  });

  it('writes the NEW sidecar filename (openbook.library.json), never the legacy name', async () => {
    await client.savePage({name: 'Trip Plans', data: snap('pack sunscreen')});
    const files = libraryToBookFiles(await client.exportLibrary());
    expect(SPACE_BUNDLE_FILE).toBe('openbook.library.json');
    expect(files.some((f) => f.path === SPACE_BUNDLE_FILE)).toBe(true);
    // The pre-LIB-4 filename is never emitted by the writer.
    expect(files.some((f) => f.path === LEGACY_SPACE_BUNDLE_FILE)).toBe(false);
  });

  it('dual-read: re-imports a folder whose sidecar uses the LEGACY openbook.space.json name', async () => {
    const root = await client.savePage({name: 'Alpha', data: snap('alpha')});
    await client.setPageProperties(root.id, {sys_icon: '📘'});
    const host = await client.savePage({name: 'Board', data: snap('')});
    const db = await client.createDatabase({pageId: host.id, name: 'Board'});
    await client.createRow(db.id, {name: 'Row 1'});

    const original = await client.exportLibrary();
    // Simulate a folder exported BEFORE the rename: rename the sidecar back to
    // the legacy filename, leaving its lossless contents untouched.
    const files = libraryToBookFiles(original).map((f) =>
      f.path === SPACE_BUNDLE_FILE ? {...f, path: LEGACY_SPACE_BUNDLE_FILE} : f,
    );
    expect(files.some((f) => f.path === LEGACY_SPACE_BUNDLE_FILE)).toBe(true);
    expect(files.some((f) => f.path === SPACE_BUNDLE_FILE)).toBe(false);

    const parsed = parseBookFolder(files);
    expect(parsed).not.toBeNull();
    // Still the lossless path (databases + properties survive), not the HTML fallback.
    expect(parsed!.pages.map((p) => p.id).sort()).toEqual(original.pages.map((p) => p.id).sort());
    expect(parsed!.databases.map((d) => d.id)).toEqual(original.databases.map((d) => d.id));
    expect(parsed!.pages.find((p) => p.id === root.id)?.properties.sys_icon).toBe('📘');
  });

  it('round-trips through the lossless bundle (parent + properties survive)', async () => {
    const root = await client.savePage({name: 'Alpha', data: snap('alpha')});
    await client.setPageProperties(root.id, {sys_icon: '📘'});
    const host = await client.savePage({name: 'Board', data: snap('')});
    const db = await client.createDatabase({pageId: host.id, name: 'Board'});
    await client.createRow(db.id, {name: 'Row 1'});

    const original = await client.exportLibrary();
    const files = libraryToBookFiles(original);
    const parsed = parseBookFolder(files);

    expect(parsed).not.toBeNull();
    expect(parsed!.pages.map((p) => p.id).sort()).toEqual(original.pages.map((p) => p.id).sort());
    expect(parsed!.databases.map((d) => d.id)).toEqual(original.databases.map((d) => d.id));
    const alpha = parsed!.pages.find((p) => p.id === root.id);
    expect(alpha?.properties.sys_icon).toBe('📘');
  });

  it('falls back to the HTML files when the bundle is absent (flat pages)', async () => {
    await client.savePage({name: 'Solo', data: snap('just me')});
    const files = libraryToBookFiles(await client.exportLibrary()).filter((f) => f.path !== SPACE_BUNDLE_FILE);

    const parsed = parseBookFolder(files);
    expect(parsed?.pages.some((p) => p.name === 'Solo')).toBe(true);
    expect(parsed?.databases).toEqual([]);
  });

  it('returns null for a folder with nothing parseable', () => {
    expect(parseBookFolder([{path: 'readme.txt', contents: 'hi'}])).toBeNull();
  });
});

describe('libraryToBookFiles — folder-level viewer runtime (_openbook/viewer.js)', () => {
  const RUNTIME = 'var OpenBookViewer = {mount: function () {}}; /* stub bundle */';

  it('emits ONE runtime copy per folder and a relative reference in every page file', async () => {
    const root = await client.savePage({name: 'Trip Plans', data: snap('pack sunscreen')});
    await client.savePage({name: 'Day One', data: snap('hike'), parentId: root.id});

    const files = libraryToBookFiles(await client.exportLibrary(), {runtime: RUNTIME});

    // Exactly one bundle, at the folder root — never vendored per-file.
    const bundles = files.filter((f) => f.path === BOOK_RUNTIME_FILE);
    expect(bundles).toHaveLength(1);
    expect(bundles[0].contents).toBe(RUNTIME);

    // Every page references it relatively (portable when moved/zipped) + boots.
    const htmlFiles = files.filter((f) => f.path.endsWith('.html'));
    expect(htmlFiles).toHaveLength(2);
    for (const f of htmlFiles) {
      expect(f.contents).toContain('<script src="../_openbook/viewer.js" defer data-openbook-runtime></script>');
      expect(f.contents).toContain('data-openbook-runtime-boot');
    }
  });

  it('emits NO reference when the runtime is unavailable (graceful static, current bytes)', async () => {
    await client.savePage({name: 'Solo', data: snap('just me')});
    const space = await client.exportLibrary();
    const without = libraryToBookFiles(space);
    const empty = libraryToBookFiles(space, {runtime: ''});
    expect(without.some((f) => f.path === BOOK_RUNTIME_FILE)).toBe(false);
    for (const f of without) expect(f.contents).not.toContain('_openbook');
    // An empty runtime string is "unavailable" too — byte-identical output.
    expect(JSON.stringify(empty)).toBe(JSON.stringify(without));
  });

  it('parseBookFolder ignores the runtime cleanly — the round-trip is unaffected', async () => {
    const root = await client.savePage({name: 'Alpha', data: snap('alpha')});
    await client.setPageProperties(root.id, {sys_icon: '📘'});

    const original = await client.exportLibrary();
    const files = libraryToBookFiles(original, {runtime: RUNTIME});
    // Both through the lossless bundle and the HTML-only fallback.
    const parsed = parseBookFolder(files);
    expect(parsed!.pages.map((p) => p.id).sort()).toEqual(original.pages.map((p) => p.id).sort());
    const htmlOnly = parseBookFolder(files.filter((f) => f.path !== SPACE_BUNDLE_FILE));
    expect(htmlOnly!.pages.map((p) => p.id).sort()).toEqual(original.pages.map((p) => p.id).sort());
    expect(htmlOnly!.pages.find((p) => p.id === root.id)?.properties.sys_icon).toBe('📘');
  });
});

describe('libraryToBookFiles — byte-compatible with the server BookMirror (OB-134)', () => {
  it('a web/desktop export imports cleanly through the server mirror', async () => {
    await client.savePage({name: 'Field Notes', data: snap('observed a heron')});
    const files = libraryToBookFiles(await client.exportLibrary());

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

  it('a runtime-carrying export imports cleanly too (the runtime is never a page)', async () => {
    const RUNTIME = 'var OpenBookViewer = {}; /* stub */';
    await client.savePage({name: 'Field Notes', data: snap('observed a heron')});
    const files = libraryToBookFiles(await client.exportLibrary(), {runtime: RUNTIME});

    for (const f of files) {
      if (!f.path.endsWith('.html') && f.path !== BOOK_RUNTIME_FILE) continue;
      const abs = join(outDir, f.path);
      await mkdir(dirname(abs), {recursive: true});
      await writeFile(abs, f.contents, 'utf8');
    }

    const store = new PageStore(await PgliteDb.create(dbDir));
    await store.migrate();
    const mirror = await BookMirror.create({store, dir: outDir, watch: false, runtimeBundle: RUNTIME});
    try {
      for (const f of files) {
        if (!f.path.endsWith('.html')) continue;
        const outcome = await mirror.importFile(join(outDir, f.path));
        expect(['created', 'unchanged']).toContain(outcome);
      }
      // The runtime file itself is inert to the importer.
      expect(await mirror.importFile(join(outDir, BOOK_RUNTIME_FILE))).toBe('skipped');
      expect((await store.listPages()).some((p) => p.name === 'Field Notes')).toBe(true);
    } finally {
      await mirror.close();
      await store.close();
    }
  });

  it('the SDK writer and the mirror emit BYTE-IDENTICAL files when both carry the runtime', async () => {
    // The byte-compatibility contract, extended to the runtime era: for the same
    // page content, libraryToBookFiles({runtime}) and a BookMirror({runtimeBundle})
    // must produce the exact same page bytes (so either side re-imports the
    // other's folder as its own writes) AND the exact same bundle bytes.
    const RUNTIME = 'var OpenBookViewer = {mount: function () {}}; /* stub bundle */';
    const store = new PageStore(await PgliteDb.create(dbDir));
    await store.migrate();
    const mirror = await BookMirror.create({store, dir: outDir, watch: false, runtimeBundle: RUNTIME});
    try {
      await store.upsertPage({name: 'Field Notes', data: snap('observed a heron')});
      await mirror.reconcileAll();
      await mirror.flush();

      const {pages, databases} = await store.exportAll();
      const sdkFiles = libraryToBookFiles({pages, databases}, {runtime: RUNTIME});
      const sdkHtml = sdkFiles.filter((f) => f.path.endsWith('.html'));
      expect(sdkHtml).toHaveLength(1);
      const onDisk = await readFile(join(outDir, sdkHtml[0].path), 'utf8');
      expect(onDisk).toBe(sdkHtml[0].contents); // byte-identical page file
      const bundleOnDisk = await readFile(join(outDir, BOOK_RUNTIME_FILE), 'utf8');
      expect(bundleOnDisk).toBe(RUNTIME); // byte-identical runtime
    } finally {
      await mirror.close();
      await store.close();
    }
  });
});
