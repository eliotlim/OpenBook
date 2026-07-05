import {describe, it, expect} from 'vitest';
import type {
  DatabaseSchema,
  ImportRequest,
  ImportResult,
  PageInput,
  PageSnapshot,
  StoredPage,
} from '@book.dev/sdk';
import {createDoc, encodeSnapshot, type NewBlock} from '../../blockeditor/model';
import {projectSnapshotForExport} from '../../blockeditor/exportBlocks';
import {toHtml, toHtmlSite} from '../../export/toHtml';
import type {SiteBundle} from '../../export/exportSite';
import {bytesToDataUri} from '../../export/exportAssets';
import {htmlToImportedDoc, parseHtmlImport} from '../htmlImport';
import {
  dataUriToBytes,
  detectHtmlIsland,
  readExportAssetMap,
  runIslandImport,
  snapshotAssetIds,
  type IslandImportClient,
} from '../islandImport';

/**
 * Island-first import — the lossless half of the export round-trip (epic req 4).
 * An exported HTML file's `openbook+json` source island re-imports the ORIGINAL
 * block-doc (ids, types, props, order intact) and databases/nesting, with asset
 * bytes recovered byte-identically from the file's own data-URIs; foreign HTML
 * (no island) still routes through the legacy DOM conversion.
 */

/** SHA-256 hex — the store's content-addressed asset id (server `assetHash`). */
async function sha256hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

const blockSnapshot = (blocks: NewBlock[]): PageSnapshot =>
  ({editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: encodeSnapshot(createDoc(blocks))}) as never;

const blocksOf = (data: PageSnapshot): unknown => (data.blockdoc as {blocks?: unknown[]}).blocks;

/** A capturing mock of the client surface an island import drives. The asset
 *  store is emulated faithfully: `putAsset` returns the sha-256 of the bytes,
 *  exactly like the real content-addressed store. */
function mockClient() {
  const saved: PageInput[] = [];
  const icons: Array<{id: string; props: Record<string, unknown>}> = [];
  const importRequests: ImportRequest[] = [];
  const putCalls: Array<{bytes: Uint8Array; mime: string; pageId: string}> = [];
  const client = {
    savePage: async (input: PageInput): Promise<StoredPage> => {
      saved.push(input);
      return {
        id: `landed-${saved.length}`,
        name: input.name ?? null,
        data: input.data,
        hostedDatabaseId: null,
        databaseId: null,
        parentId: input.parentId ?? null,
        properties: {},
        deletedAt: null,
        createdAt: '',
        updatedAt: '',
      };
    },
    setPageProperties: async (id: string, props: Record<string, unknown>) => {
      icons.push({id, props});
    },
    createDatabase: async () => {
      throw new Error('unused in these tests');
    },
    createRow: async () => {
      throw new Error('unused in these tests');
    },
    importSpace: async (req: ImportRequest): Promise<ImportResult> => {
      importRequests.push(req);
      const idMap: Record<string, string> = {};
      req.pages.forEach((p, i) => {
        idMap[p.id] = `landed-${i + 1}`;
      });
      return {created: req.pages.length, overwritten: 0, renamed: 0, idMap};
    },
    putAsset: async (bytes: Uint8Array, mime: string, pageId: string) => {
      putCalls.push({bytes, mime, pageId});
      return {id: await sha256hex(bytes)};
    },
  } as unknown as IslandImportClient;
  return {client, saved, icons, importRequests, putCalls};
}

describe('single-page export → island-first import (round trip)', () => {
  const buildPage = async () => {
    const assetId = await sha256hex(PNG);
    const blocks: NewBlock[] = [
      {type: 'heading', text: [{t: 'Trip Plan'}], props: {level: 2}},
      {type: 'paragraph', text: [{t: 'Hello '}, {t: 'world', a: {b: true}}]},
      {type: 'slider', props: {name: 'price', label: 'Price', value: 50, min: 0, max: 100}},
      {type: 'code', text: [{t: 'price * 2'}], props: {live: true, name: 'doubled', language: 'js'}},
      {type: 'kitchart', props: {kind: 'bar', title: 'Chart', labels: 'a, b', source: '[price, price * 2]'}},
      {type: 'image', props: {assetId, alt: 'A cat'}},
    ];
    const snapshot = blockSnapshot(blocks);
    const html = toHtml(snapshot, 'Trip Plan', '🧭', new Map([[assetId, bytesToDataUri(PNG, 'image/png')]]), {id: 'orig-1'});
    return {assetId, snapshot, html};
  };

  it('re-imports the exact block-doc: ids, types, props, order — and the title/icon', async () => {
    const {snapshot, html} = await buildPage();
    const parsed = parseHtmlImport(html);
    expect(parsed.kind).toBe('island');
    if (parsed.kind !== 'island') return;
    expect(parsed.island.kind).toBe('page');
    expect(parsed.summary).toEqual({pages: 1, databases: 0, rows: 0, images: 1});

    const {client, saved, icons} = mockClient();
    const result = await runIslandImport(client, parsed.island, parsed.assets);
    expect(result.pageIds).toEqual(['landed-1']);
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('Trip Plan');
    expect(icons[0]?.props).toEqual({sys_icon: '🧭'});
    // The landed block-doc deep-equals the original (ids included) — the island
    // carried the source, not the rendered HTML.
    expect(blocksOf(saved[0].data)).toEqual(blocksOf(snapshot));
  });

  it('restores asset bytes byte-identically — content addressing yields the SAME id', async () => {
    const {assetId, html} = await buildPage();
    const parsed = parseHtmlImport(html);
    if (parsed.kind !== 'island') throw new Error('expected island');
    // The map was recovered from the file's own <img data-asset-id> data-URI.
    expect([...parsed.assets.keys()]).toEqual([assetId]);

    const {client, putCalls} = mockClient();
    const result = await runIslandImport(client, parsed.island, parsed.assets);
    expect(result.assetsRestored).toBe(1);
    expect(result.assetsMissing).toEqual([]);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].pageId).toBe('landed-1'); // read-gate anchored on the landed page
    expect(putCalls[0].mime).toBe('image/png');
    // Byte-identical: the uploaded bytes hash back to the island's assetId.
    expect(Array.from(putCalls[0].bytes)).toEqual(Array.from(PNG));
    expect(await sha256hex(putCalls[0].bytes)).toBe(assetId);
  });

  it('degrades an unrecoverable asset without dropping it (block + assetId kept)', async () => {
    // No data-URI in the file for this asset (e.g. an htmlArtifact's, or an
    // asset that was already missing at export) — the island stays faithful.
    const blocks: NewBlock[] = [{type: 'image', props: {assetId: 'not-in-file', alt: 'Gone'}}];
    const snapshot = blockSnapshot(blocks);
    const html = toHtml(snapshot, 'Sparse', '', new Map(), {id: 'p1'});
    const parsed = parseHtmlImport(html);
    if (parsed.kind !== 'island') throw new Error('expected island');
    expect(parsed.assets.size).toBe(0);

    const {client, saved, putCalls} = mockClient();
    const result = await runIslandImport(client, parsed.island, parsed.assets);
    expect(putCalls).toHaveLength(0);
    expect(result.assetsRestored).toBe(0);
    expect(result.assetsMissing).toEqual(['not-in-file']);
    // The image block landed intact — assetId + alt preserved (renders as the
    // editor's visible placeholder; resolves if the asset exists in the space).
    expect(blocksOf(saved[0].data)).toEqual(blocksOf(snapshot));
  });

  it('a page whose content contains </script> still round-trips', async () => {
    const blocks: NewBlock[] = [{type: 'paragraph', text: [{t: 'evil </script><script>alert(1)</script> text'}]}];
    const snapshot = blockSnapshot(blocks);
    const html = toHtml(snapshot, 'Pwn </script>', '', new Map(), {id: 'p1'});
    const parsed = parseHtmlImport(html);
    if (parsed.kind !== 'island') throw new Error('expected island');
    const {client, saved} = mockClient();
    await runIslandImport(client, parsed.island, parsed.assets);
    expect(saved[0].name).toBe('Pwn </script>');
    expect(blocksOf(saved[0].data)).toEqual(blocksOf(snapshot));
  });
});

describe('site export → island-first import (round trip)', () => {
  const schema = {properties: [{id: 'p1', name: 'Status', type: 'text'}], views: []} as unknown as DatabaseSchema;
  const page = (
    id: string,
    name: string,
    blocks: NewBlock[],
    extra: Partial<StoredPage> = {},
  ): StoredPage => ({
    id,
    name,
    data: blockSnapshot(blocks),
    hostedDatabaseId: null,
    databaseId: null,
    parentId: null,
    properties: {},
    deletedAt: null,
    createdAt: '',
    updatedAt: '',
    ...extra,
  });

  const buildSite = async () => {
    const assetId = await sha256hex(PNG);
    const space = {
      pages: [
        page('root', 'Root', [{type: 'paragraph', text: [{t: 'root body'}]}], {hostedDatabaseId: 'db-1'}),
        page('child', 'Child', [{type: 'image', props: {assetId, alt: 'pic'}}], {parentId: 'root'}),
        page('grand', 'Grandchild', [{type: 'paragraph', text: [{t: 'deep'}]}], {parentId: 'child'}),
        page('row1', 'Task one', [{type: 'paragraph', text: [{t: 'row body'}]}], {databaseId: 'db-1'}),
      ],
      databases: [{id: 'db-1', pageId: 'root', name: 'Tasks', schema, createdAt: '', updatedAt: ''}],
    };
    const bundle: SiteBundle = {
      rootId: 'root',
      // gatherSite projects each page for rendering; the island keeps the raw space.
      pages: space.pages.map((p) => ({id: p.id, title: p.name ?? '', icon: '', snapshot: projectSnapshotForExport(p.data)})),
      space,
    };
    const html = toHtmlSite(bundle, new Map([[assetId, bytesToDataUri(PNG, 'image/png')]]));
    return {assetId, space, html};
  };

  it('lands the whole space bundle as a copy — structure, database, rows intact', async () => {
    const {space, html} = await buildSite();
    const parsed = parseHtmlImport(html);
    expect(parsed.kind).toBe('island');
    if (parsed.kind !== 'island') return;
    expect(parsed.island.kind).toBe('space');
    expect(parsed.summary).toEqual({pages: 3, databases: 1, rows: 1, images: 1});

    const {client, importRequests} = mockClient();
    const result = await runIslandImport(client, parsed.island, parsed.assets);
    expect(importRequests).toHaveLength(1);
    // The server receives the EXACT space bundle (raw snapshots, nesting,
    // database membership) in copy mode — its remap re-keys and rewrites links.
    expect(importRequests[0].mode).toBe('copy');
    expect(importRequests[0].pages).toEqual(space.pages);
    expect(importRequests[0].databases).toEqual(space.databases);
    expect(result.pageIds).toHaveLength(4);
    // Nesting survived verbatim in the submitted bundle.
    expect(importRequests[0].pages.find((p) => p.id === 'grand')?.parentId).toBe('child');
    expect(importRequests[0].pages.find((p) => p.id === 'row1')?.databaseId).toBe('db-1');
  });

  it('recovers the asset onto the LANDED id of its referencing page', async () => {
    const {assetId, html} = await buildSite();
    const parsed = parseHtmlImport(html);
    if (parsed.kind !== 'island') throw new Error('expected island');
    const {client, putCalls} = mockClient();
    const result = await runIslandImport(client, parsed.island, parsed.assets);
    expect(result.assetsRestored).toBe(1);
    // 'child' (the referencing page) is pages[1] → the mock idMap says landed-2.
    expect(putCalls[0].pageId).toBe('landed-2');
    expect(await sha256hex(putCalls[0].bytes)).toBe(assetId);
  });
});

describe('foreign / legacy HTML (no island) — regression', () => {
  it('routes to the DOM converter exactly as before', () => {
    const html = '<html><head><title>Notes</title></head><body><h2>Hi</h2><p>plain <strong>bold</strong></p></body></html>';
    const parsed = parseHtmlImport(html);
    expect(parsed.kind).toBe('doc');
    if (parsed.kind !== 'doc') return;
    expect(parsed.doc).toEqual(htmlToImportedDoc(html));
    expect(parsed.doc.pages[0].title).toBe('Notes');
    expect(parsed.doc.pages[0].blocks.map((b) => b.type)).toEqual(['heading', 'paragraph']);
  });

  it('detectHtmlIsland ignores plain and non-island script content', () => {
    expect(detectHtmlIsland('<p>no island</p>')).toBeNull();
    // The export runtime's own JSON payload is NOT an island.
    expect(detectHtmlIsland('<script type="application/json" id="ob-data">{"values":{}}</script>')).toBeNull();
  });
});

describe('asset byte helpers', () => {
  it('dataUriToBytes inverts bytesToDataUri', () => {
    const decoded = dataUriToBytes(bytesToDataUri(PNG, 'image/png'));
    expect(decoded).not.toBeNull();
    expect(decoded!.mime).toBe('image/png');
    expect(Array.from(decoded!.bytes)).toEqual(Array.from(PNG));
    expect(dataUriToBytes('https://not-a-data-uri.test/x.png')).toBeNull();
  });

  it('readExportAssetMap reads only store-resolved data-URI images', () => {
    const html = [
      '<img src="data:image/png;base64,AQIDBA==" alt="a" data-asset-id="asset-a">',
      '<img data-asset-id="asset-b" src="https://remote.test/pic.png">', // remote → not recoverable
      '<img src="data:image/png;base64,BQYH">', // no asset id → not an asset
    ].join('\n');
    const map = readExportAssetMap(html);
    expect([...map.keys()]).toEqual(['asset-a']);
    expect(Array.from(map.get('asset-a')!.bytes)).toEqual([1, 2, 3, 4]);
  });

  it('snapshotAssetIds walks nested blockdoc children and the EditorJS shape', () => {
    const nested = blockSnapshot([
      {type: 'columns', children: [
        {type: 'column', children: [{type: 'image', props: {assetId: 'deep-1', alt: ''}}]},
        {type: 'column', children: [{type: 'paragraph', text: [{t: 'x'}]}]},
      ]},
      {type: 'image', props: {assetId: 'top-1', alt: ''}},
    ]);
    expect(snapshotAssetIds(nested).sort()).toEqual(['deep-1', 'top-1']);
    const legacy: PageSnapshot = {editorjs: {blocks: [{type: 'image', data: {assetId: 'ed-1'}}]}, values: [], names: []};
    expect(snapshotAssetIds(legacy)).toEqual(['ed-1']);
  });
});
