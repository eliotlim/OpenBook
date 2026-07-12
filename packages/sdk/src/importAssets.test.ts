import {describe, it, expect} from 'vitest';
import {zipSync, strToU8} from 'fflate';
import {notionExportToImportedDoc} from './notionImport';
import {markdownToImportedDoc} from './markdownImport';
import {
  imagePlaceholderBlock,
  importDoc,
  IMAGE_PLACEHOLDER_PROP,
  type ImportedBlock,
  type ImportedDoc,
  type ImportWriteClient,
} from './import';
import {
  rehydrateImageUrls,
  rehydrateStoredImages,
  importedImageBlock,
  mimeFromRef,
  notionAssetResolver,
  urlAssetResolver,
  type FetchLike,
} from './importAssets';
import type {PageInput, PageSnapshot, StoredPage} from './types';

// ── An in-memory store fake (savePage/getPage/putAsset/getAsset/importLibrary) ──

const emptyData = (): PageSnapshot => ({editorjs: {blocks: []}, values: [], names: []});
const blocksSnapshot = (blocks: ImportedBlock[]): PageSnapshot => ({
  editorjs: {blocks: []},
  values: [],
  names: [],
  editor: 'blocks',
  blockdoc: {blocks},
});
const pageBlocks = (page: StoredPage): ImportedBlock[] => (page.data.blockdoc as {blocks?: ImportedBlock[]})?.blocks ?? [];

/** A content-addressed id, so a byte-identical re-upload dedups (like the real store). */
const hashBytes = (b: Uint8Array): string => `asset_${b.length}_${b.reduce((a, x) => (a * 31 + x) >>> 0, 7)}`;

function makeStore() {
  const pages = new Map<string, StoredPage>();
  const assets = new Map<string, {bytes: Uint8Array; mime: string}>();
  let putCount = 0;
  let n = 0;
  const mk = (id: string, patch: Partial<StoredPage>): StoredPage => ({
    id,
    name: null,
    data: emptyData(),
    hostedDatabaseId: null,
    databaseId: null,
    parentId: null,
    properties: {},
    deletedAt: null,
    createdAt: 'now',
    updatedAt: 'now',
    ...patch,
  });
  const store = {
    pages,
    assets,
    get putCount() {
      return putCount;
    },
    async savePage(input: PageInput): Promise<StoredPage> {
      const id = input.id ?? `p_${(n += 1)}`;
      const prev = pages.get(id);
      const page = mk(id, {
        name: input.name ?? prev?.name ?? null,
        data: input.data ?? prev?.data ?? emptyData(),
        parentId: input.parentId ?? prev?.parentId ?? null,
        properties: prev?.properties ?? {},
      });
      pages.set(id, page);
      return page;
    },
    async getPage(id: string): Promise<StoredPage | null> {
      return pages.get(id) ?? null;
    },
    async putAsset(bytes: Uint8Array, mime: string): Promise<{id: string}> {
      putCount += 1;
      const id = hashBytes(bytes);
      if (!assets.has(id)) assets.set(id, {bytes: bytes.slice(), mime});
      return {id};
    },
    async getAsset(id: string): Promise<{bytes: Uint8Array; mime: string} | null> {
      return assets.get(id) ?? null;
    },
    async setPageProperties(): Promise<void> {},
    async createDatabase(input: {pageId: string; name: string | null}): Promise<{id: string}> {
      return {id: `db_${(n += 1)}`, ...input};
    },
    async createRow(databaseId: string, input?: {name?: string | null; data?: PageSnapshot}): Promise<StoredPage> {
      const id = `r_${(n += 1)}`;
      const page = mk(id, {name: input?.name ?? null, data: input?.data ?? emptyData(), databaseId});
      pages.set(id, page);
      return page;
    },
    async importLibrary(req: {pages: StoredPage[]}): Promise<{created: number; overwritten: number; renamed: number; idMap: Record<string, string>}> {
      const idMap: Record<string, string> = {};
      for (const p of req.pages) {
        const newId = `srv_${p.id}`;
        idMap[p.id] = newId;
        pages.set(newId, {...p, id: newId});
      }
      return {created: req.pages.length, overwritten: 0, renamed: 0, idMap};
    },
  };
  return store;
}

/** Seed a page with the given block body, return its id. */
function seedPage(store: ReturnType<typeof makeStore>, blocks: ImportedBlock[], id = 'pg1'): string {
  store.pages.set(id, {
    id,
    name: 'P',
    data: blocksSnapshot(blocks),
    hostedDatabaseId: null,
    databaseId: null,
    parentId: null,
    properties: {},
    deletedAt: null,
    createdAt: 'now',
    updatedAt: 'now',
  });
  return id;
}

/** Seed a page holding a paragraph + one image placeholder, return its id. */
function seedPlaceholderPage(store: ReturnType<typeof makeStore>, ref: string, id = 'pg1'): string {
  const ph = imagePlaceholderBlock({kind: 'image', ref, alt: 'alt text'});
  return seedPage(store, [{type: 'paragraph', text: [{t: 'hi'}]}, ph], id);
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

// ── mimeFromRef ──────────────────────────────────────────────────────────────

describe('mimeFromRef', () => {
  it('maps common image extensions, ignoring query/hash', () => {
    expect(mimeFromRef('a/b/pic.png')).toBe('image/png');
    expect(mimeFromRef('photo.JPG')).toBe('image/jpeg');
    expect(mimeFromRef('x.jpeg?v=2')).toBe('image/jpeg');
    expect(mimeFromRef('logo.svg#frag')).toBe('image/svg+xml');
    expect(mimeFromRef('anim.gif')).toBe('image/gif');
  });
  it('defaults to octet-stream for an unknown/absent extension', () => {
    expect(mimeFromRef('noext')).toBe('application/octet-stream');
    expect(mimeFromRef('file.bin')).toBe('application/octet-stream');
  });
});

// ── importedImageBlock ───────────────────────────────────────────────────────

describe('importedImageBlock', () => {
  it('rewrites a placeholder to an image block, alt→alt, title→caption, keeps id', () => {
    const ph = imagePlaceholderBlock({kind: 'image', ref: 'x.png', alt: 'a cat', title: 'Fig 1'});
    const block = importedImageBlock(ph, {assetId: 'AID'});
    expect(block.type).toBe('image');
    expect(block.id).toBe(ph.id);
    expect(block.props).toMatchObject({assetId: 'AID', alt: 'a cat', caption: 'Fig 1'});
    expect(block.props?.[IMAGE_PLACEHOLDER_PROP]).toBeUndefined();
  });
  it('supports a src target (URL/data preserve)', () => {
    const ph = imagePlaceholderBlock({kind: 'image', ref: 'https://x/c.png'});
    expect(importedImageBlock(ph, {src: 'https://x/c.png'}).props).toMatchObject({src: 'https://x/c.png'});
  });
});

// ── Pass 1: rehydrateImageUrls (pure) ────────────────────────────────────────

describe('rehydrateImageUrls (URL / data preserve)', () => {
  it('turns an http image placeholder into a URL image block', () => {
    const doc = markdownToImportedDoc('# D\n\n![cat](https://ex.com/cat.png)');
    const out = rehydrateImageUrls(doc);
    const blocks = out.pages[0].blocks;
    const img = blocks.find((b) => b.type === 'image');
    expect(img?.props).toMatchObject({src: 'https://ex.com/cat.png'});
    expect(blocks.some((b) => b.props?.[IMAGE_PLACEHOLDER_PROP])).toBe(false);
  });

  it('turns an in-cap data: image into an inline image block', () => {
    const dataUrl = 'data:image/png;base64,AAAA';
    const doc = markdownToImportedDoc(`# D\n\n![x](${dataUrl})`);
    const img = rehydrateImageUrls(doc).pages[0].blocks.find((b) => b.type === 'image');
    expect(img?.props).toMatchObject({src: dataUrl});
  });

  it('keeps an over-cap data: image as a placeholder (never bloat the CRDT)', () => {
    const dataUrl = `data:image/png;base64,${'A'.repeat(4000)}`;
    const doc = markdownToImportedDoc(`# D\n\n![x](${dataUrl})`);
    const blocks = rehydrateImageUrls(doc, {maxDataBytes: 100}).pages[0].blocks;
    expect(blocks.some((b) => b.type === 'image')).toBe(false);
    expect(blocks.some((b) => b.props?.[IMAGE_PLACEHOLDER_PROP])).toBe(true);
  });

  it('leaves a non-loadable (relative / zip-path) ref as a placeholder', () => {
    const doc = markdownToImportedDoc('# D\n\n![x](images/local.png)');
    const blocks = rehydrateImageUrls(doc).pages[0].blocks;
    expect(blocks.some((b) => b.type === 'image')).toBe(false);
    expect(blocks.some((b) => b.props?.[IMAGE_PLACEHOLDER_PROP])).toBe(true);
  });

  it('with preserveHttpUrls:false keeps http images as placeholders (for opt-in download)', () => {
    const doc = markdownToImportedDoc('# D\n\n![cat](https://ex.com/cat.png)');
    const blocks = rehydrateImageUrls(doc, {preserveHttpUrls: false}).pages[0].blocks;
    expect(blocks.some((b) => b.type === 'image')).toBe(false);
    expect(blocks.some((b) => b.props?.[IMAGE_PLACEHOLDER_PROP])).toBe(true);
  });
});

// ── Pass 2 degrade paths ─────────────────────────────────────────────────────

describe('rehydrateStoredImages — degrade without losing the ref', () => {
  it('uploads bytes and rewrites to an assetId image block', async () => {
    const store = makeStore();
    const id = seedPlaceholderPage(store, 'export/img.png');
    const stats = await rehydrateStoredImages(store, [id], () => ({bytes: PNG, mime: 'image/png'}));
    expect(stats).toMatchObject({uploaded: 1, keptPlaceholders: 0});
    const img = pageBlocks((await store.getPage(id))!).find((b) => b.type === 'image')!;
    expect(img.props?.assetId).toBeTruthy();
    expect(await store.getAsset(img.props!.assetId as string)).toEqual({bytes: PNG, mime: 'image/png'});
  });

  it('keeps a placeholder when the bytes are missing (resolver → null)', async () => {
    const store = makeStore();
    const id = seedPlaceholderPage(store, 'export/gone.png');
    const stats = await rehydrateStoredImages(store, [id], () => null);
    expect(stats).toMatchObject({uploaded: 0, keptPlaceholders: 1});
    expect(pageBlocks((await store.getPage(id))!).some((b) => b.props?.[IMAGE_PLACEHOLDER_PROP])).toBe(true);
  });

  it('keeps a placeholder for an over-cap image (skip, never fail the import)', async () => {
    const store = makeStore();
    const id = seedPlaceholderPage(store, 'export/huge.png');
    const big = new Uint8Array(64);
    const stats = await rehydrateStoredImages(store, [id], () => ({bytes: big, mime: 'image/png'}), {maxAssetBytes: 8});
    expect(stats).toMatchObject({uploaded: 0, keptPlaceholders: 1});
    expect(store.putCount).toBe(0);
    expect(pageBlocks((await store.getPage(id))!).some((b) => b.props?.[IMAGE_PLACEHOLDER_PROP])).toBe(true);
  });

  it('preserves a URL image block when a download fails (opt-in path degrade)', async () => {
    const store = makeStore();
    const id = seedPlaceholderPage(store, 'https://ex.com/c.png');
    const stats = await rehydrateStoredImages(store, [id], () => null);
    expect(stats).toMatchObject({uploaded: 0, preservedUrls: 1, keptPlaceholders: 0});
    const img = pageBlocks((await store.getPage(id))!).find((b) => b.type === 'image')!;
    expect(img.props).toMatchObject({src: 'https://ex.com/c.png'});
  });

  it('keeps a placeholder when putAsset throws (transient upload failure)', async () => {
    const store = makeStore();
    const id = seedPlaceholderPage(store, 'export/img.png');
    store.putAsset = () => Promise.reject(new Error('boom'));
    const stats = await rehydrateStoredImages(store, [id], () => ({bytes: PNG, mime: 'image/png'}));
    expect(stats).toMatchObject({uploaded: 0, keptPlaceholders: 1});
    expect(pageBlocks((await store.getPage(id))!).some((b) => b.props?.[IMAGE_PLACEHOLDER_PROP])).toBe(true);
  });

  it('does NOT re-inline an over-cap data: image on degrade (keeps the placeholder)', async () => {
    const store = makeStore();
    const bigData = `data:image/png;base64,${'A'.repeat(400)}`; // ~300 raw bytes
    const id = seedPlaceholderPage(store, bigData);
    const stats = await rehydrateStoredImages(store, [id], () => null, {maxAssetBytes: 10});
    expect(stats).toMatchObject({uploaded: 0, preservedUrls: 0, keptPlaceholders: 1});
    const blocks = pageBlocks((await store.getPage(id))!);
    expect(blocks.some((b) => b.props?.[IMAGE_PLACEHOLDER_PROP])).toBe(true);
    expect(blocks.some((b) => b.type === 'image')).toBe(false);
  });

  it('does degrade a normal-size data: image to an inline block when it cannot upload', async () => {
    const store = makeStore();
    const smallData = 'data:image/png;base64,AAAA';
    const id = seedPlaceholderPage(store, smallData);
    const stats = await rehydrateStoredImages(store, [id], () => null);
    expect(stats).toMatchObject({preservedUrls: 1});
    const img = pageBlocks((await store.getPage(id))!).find((b) => b.type === 'image')!;
    expect(img.props).toMatchObject({src: smallData});
  });

  it('bounds total in-flight uploads across an image-dense page (shared limiter)', async () => {
    const store = makeStore();
    const blocks: ImportedBlock[] = [];
    for (let i = 0; i < 12; i += 1) blocks.push(imagePlaceholderBlock({kind: 'image', ref: `export/img${i}.png`}));
    const id = seedPage(store, blocks);
    let inFlight = 0;
    let maxInFlight = 0;
    store.putAsset = async (bytes: Uint8Array) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return {id: `a_${bytes[0]}`};
    };
    // Distinct bytes per image so every one triggers a real putAsset.
    let k = 0;
    const stats = await rehydrateStoredImages(store, [id], () => ({bytes: new Uint8Array([(k += 1)]), mime: 'image/png'}), {
      concurrency: 3,
    });
    expect(stats.uploaded).toBe(12);
    expect(maxInFlight).toBeGreaterThan(0);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });
});

// ── ImportWriteResult.placeholderPageIds (writer reporting) ──────────────────

describe('placeholderPageIds reporting', () => {
  it('create path: a page that retains a placeholder is reported by its created id', async () => {
    const store = makeStore();
    const ph = imagePlaceholderBlock({kind: 'image', ref: 'images/local.png'}); // non-loadable → stays a placeholder
    const doc: ImportedDoc = {pages: [{title: 'Solo', blocks: [{type: 'paragraph', text: [{t: 'x'}]}, ph]}]};
    const result = await importDoc(store as unknown as ImportWriteClient, rehydrateImageUrls(doc));
    expect(result.strategy).toBe('create');
    expect(result.placeholderPageIds).toEqual([result.pageIds[0]]);
  });
});

// ── notionAssetResolver / urlAssetResolver ───────────────────────────────────

describe('resolvers', () => {
  it('notionAssetResolver resolves an in-zip entry to bytes + mime, null for a miss', () => {
    const zip = zipSync({'Export/images/a.png': PNG});
    const resolve = notionAssetResolver(zip);
    expect(resolve('Export/images/a.png')).toEqual({bytes: PNG, mime: 'image/png'});
    expect(resolve('Export/images/missing.png')).toBeNull();
  });

  it('urlAssetResolver downloads http bytes with the response mime; null on non-http / !ok', async () => {
    const fakeFetch: FetchLike = async (url) => ({
      ok: url.includes('good'),
      status: url.includes('good') ? 200 : 404,
      arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
      headers: {get: (n) => (n.toLowerCase() === 'content-type' ? 'image/png; charset=binary' : null)},
    });
    const resolve = urlAssetResolver(fakeFetch);
    expect(await resolve('https://ex.com/good.bin')).toEqual({bytes: PNG, mime: 'image/png'});
    expect(await resolve('https://ex.com/bad.png')).toBeNull();
    expect(await resolve('images/local.png')).toBeNull();
  });
});

// ── End-to-end: a Notion export with an image ────────────────────────────────

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
function notionZipWithImage(): Uint8Array {
  return zipSync({
    [`Export-test/Doc ${A}.md`]: strToU8('# Doc\n\n![arch](images/arch.png)'),
    [`Export-test/Notes ${B}.md`]: strToU8('# Notes\n\nplain'),
    'Export-test/images/arch.png': PNG,
  });
}

describe('Notion export → real stored image (end-to-end)', () => {
  it('rewrites the placeholder ref to the absolute in-zip path', () => {
    const doc = notionExportToImportedDoc(notionZipWithImage());
    const docPage = doc.pages.find((p) => p.title === 'Doc')!;
    const ph = docPage.blocks.find((b) => b.props?.[IMAGE_PLACEHOLDER_PROP]);
    expect((ph!.props![IMAGE_PLACEHOLDER_PROP] as {ref: string}).ref).toBe('Export-test/images/arch.png');
  });

  it('imports the image as a real image block with an assetId + bytes in the store', async () => {
    const store = makeStore();
    const zip = notionZipWithImage();
    const doc = rehydrateImageUrls(notionExportToImportedDoc(zip));
    const result = await importDoc(store as unknown as ImportWriteClient, doc);
    expect(result.strategy).toBe('bundle'); // two top-level pages
    expect(result.placeholderPageIds).toHaveLength(1);

    const stats = await rehydrateStoredImages(store, result.placeholderPageIds, notionAssetResolver(zip));
    expect(stats.uploaded).toBe(1);

    const landed = (await store.getPage(result.placeholderPageIds[0]))!;
    const blocks = pageBlocks(landed);
    const img = blocks.find((b) => b.type === 'image')!;
    expect(img.props?.assetId).toBeTruthy();
    expect(await store.getAsset(img.props!.assetId as string)).toEqual({bytes: PNG, mime: 'image/png'});
    expect(blocks.some((b) => b.props?.[IMAGE_PLACEHOLDER_PROP])).toBe(false);
  });

  it('is idempotent — a re-run uploads nothing new and keeps the same assetId', async () => {
    const store = makeStore();
    const zip = notionZipWithImage();
    const doc = rehydrateImageUrls(notionExportToImportedDoc(zip));
    const result = await importDoc(store as unknown as ImportWriteClient, doc);
    await rehydrateStoredImages(store, result.placeholderPageIds, notionAssetResolver(zip));
    const firstAssetId = pageBlocks((await store.getPage(result.placeholderPageIds[0]))!).find((b) => b.type === 'image')!
      .props!.assetId as string;
    const putsAfterFirst = store.putCount;

    // Re-run the upload pass over the same pages: no placeholders remain.
    const again = await rehydrateStoredImages(store, result.placeholderPageIds, notionAssetResolver(zip));
    expect(again).toMatchObject({uploaded: 0, keptPlaceholders: 0});
    expect(store.putCount).toBe(putsAfterFirst);
    expect(store.assets.size).toBe(1);
    const secondAssetId = pageBlocks((await store.getPage(result.placeholderPageIds[0]))!).find((b) => b.type === 'image')!
      .props!.assetId as string;
    expect(secondAssetId).toBe(firstAssetId);
  });
});

// ── End-to-end: a Markdown URL image (no upload, create path) ─────────────────

describe('Markdown URL image → URL image block (no upload needed)', () => {
  it('lands a URL image block and reports no placeholder pages', async () => {
    const store = makeStore();
    const doc = rehydrateImageUrls(markdownToImportedDoc('# Solo\n\n![cat](https://ex.com/cat.png)'));
    const result = await importDoc(store as unknown as ImportWriteClient, doc);
    expect(result.strategy).toBe('create');
    expect(result.placeholderPageIds).toHaveLength(0);
    const img = pageBlocks((await store.getPage(result.pageIds[0]))!).find((b) => b.type === 'image')!;
    expect(img.props).toMatchObject({src: 'https://ex.com/cat.png'});
  });
});
