import {describe, it, expect} from 'vitest';
import type {DataClient, PageSnapshot} from '@book.dev/sdk';
import {createDoc, encodeSnapshot} from '../../blockeditor/model';
import {buildDocumentModel} from '../documentModel';
import {toMarkdown} from '../toMarkdown';
import {toHtml} from '../toHtml';
import {blocksToHtml, blocksToMarkdown} from '../../blockeditor/exportBlocks';
import {collectAssetIds, resolveExportAssets, bytesToDataUri} from '../exportAssets';
import {awaitImages} from '../toPdf';

/**
 * Assets A3 — image blocks render in every exporter. An `assetId` block resolves
 * to an inlined `data:` URI (pre-resolved via getAsset), a legacy `data:`/URL
 * `src` renders directly, and an unresolvable asset degrades to alt text (no
 * broken `<img>`, no crash).
 */

// A 1×1 PNG (real, decodable) as raw bytes, for the mock asset store.
const PNG_BYTES = new Uint8Array([1, 2, 3, 4]);
const PNG_DATA_URI = bytesToDataUri(PNG_BYTES, 'image/png'); // data:image/png;base64,AQIDBA==

/** An EditorJS-shape snapshot (passes through blockSnapshotToEditorJs untouched). */
const snapshot = (blocks: unknown[]): PageSnapshot => ({editorjs: {blocks}, values: [], names: []});

/** A block-CRDT snapshot (exercises the blocksToEditorJs image projection). */
const blockSnapshot = (blocks: Parameters<typeof createDoc>[0]): PageSnapshot =>
  ({editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: encodeSnapshot(createDoc(blocks))}) as never;

describe('bytesToDataUri', () => {
  it('base64-encodes bytes into a data: URI', () => {
    expect(bytesToDataUri(PNG_BYTES, 'image/png')).toBe('data:image/png;base64,AQIDBA==');
    expect(bytesToDataUri(PNG_BYTES, '')).toBe('data:application/octet-stream;base64,AQIDBA==');
  });
});

describe('resolveExportAssets', () => {
  const client = {
    getAsset: (id: string) => Promise.resolve(id === 'a1' ? {bytes: PNG_BYTES, mime: 'image/png'} : null),
  } as unknown as DataClient;

  it('collects assetIds from image blocks (both snapshot shapes)', () => {
    expect(collectAssetIds(snapshot([{type: 'image', data: {assetId: 'a1'}}]))).toEqual(['a1']);
    expect(collectAssetIds(blockSnapshot([{type: 'image', props: {assetId: 'a2'}}]))).toEqual(['a2']);
  });

  it('resolves each referenced asset to a data-URI', async () => {
    const assets = await resolveExportAssets(client, [snapshot([{type: 'image', data: {assetId: 'a1'}}])]);
    expect(assets.images.get('a1')).toBe(PNG_DATA_URI);
  });

  it('leaves a missing asset out of the map (renderers degrade)', async () => {
    const assets = await resolveExportAssets(client, [snapshot([{type: 'image', data: {assetId: 'gone'}}])]);
    expect(assets.images.has('gone')).toBe(false);
  });

  it('never crashes when getAsset throws — the asset is just absent', async () => {
    const flaky = {getAsset: () => Promise.reject(new Error('boom'))} as unknown as DataClient;
    const assets = await resolveExportAssets(flaky, [snapshot([{type: 'image', data: {assetId: 'a1'}}])]);
    expect(assets.images.size).toBe(0);
    expect(assets.artifactText.size).toBe(0);
  });

  it('returns an empty map when no asset client is available', async () => {
    expect((await resolveExportAssets(null, [snapshot([{type: 'image', data: {assetId: 'a1'}}])])).images.size).toBe(0);
  });
});

describe('toHtml — image block', () => {
  it('inlines a resolved assetId as an <img> data-URI, honouring width + caption', () => {
    const html = toHtml(
      snapshot([{type: 'image', data: {assetId: 'a1', alt: 'A cat', caption: 'Fluffy', width: '50%'}}]),
      'T',
      '',
      new Map([['a1', PNG_DATA_URI]]),
    );
    expect(html).toContain(`<img data-asset-id="a1" src="${PNG_DATA_URI}" alt="A cat" style="width:50%">`);
    expect(html).toContain('<figcaption>Fluffy</figcaption>');
  });

  it('renders a legacy data:/URL src directly (no asset store needed)', () => {
    const dataUrl = 'data:image/png;base64,ZZZ';
    expect(toHtml(snapshot([{type: 'image', data: {src: dataUrl, alt: 'B'}}]), 'T', '')).toContain(`<img src="${dataUrl}" alt="B">`);
    expect(toHtml(snapshot([{type: 'image', data: {src: 'https://x.test/p.png', alt: 'C'}}]), 'T', '')).toContain(
      '<img src="https://x.test/p.png" alt="C">',
    );
  });

  it('degrades an unresolvable asset to an alt-text placeholder (no <img>)', () => {
    const html = toHtml(snapshot([{type: 'image', data: {assetId: 'gone', alt: 'Missing pic'}}]), 'T', '');
    expect(html).toContain('ob-image is-missing');
    expect(html).toContain('Missing pic');
    expect(html).not.toContain('<img');
  });

  it('resolves through the block-CRDT projection (assetId carried end-to-end)', () => {
    const html = toHtml(blockSnapshot([{type: 'image', props: {assetId: 'a1', alt: 'Cat', width: '30%'}}]), 'T', '', new Map([['a1', PNG_DATA_URI]]));
    expect(html).toContain(`<img data-asset-id="a1" src="${PNG_DATA_URI}" alt="Cat" style="width:30%">`);
  });
});

describe('toMarkdown — image block', () => {
  it('emits ![alt](data-uri) with an italic caption', () => {
    const md = toMarkdown(
      buildDocumentModel({
        title: 'T',
        icon: '',
        snapshot: snapshot([{type: 'image', data: {assetId: 'a1', alt: 'A cat', caption: 'Fluffy'}}]),
        assets: new Map([['a1', PNG_DATA_URI]]),
      }),
    );
    expect(md).toContain(`![A cat](${PNG_DATA_URI})`);
    expect(md).toContain('*Fluffy*');
  });

  it('emits a legacy URL src directly', () => {
    const md = toMarkdown(buildDocumentModel({title: 'T', icon: '', snapshot: snapshot([{type: 'image', data: {src: 'https://x.test/p.png', alt: 'B'}}])}));
    expect(md).toContain('![B](https://x.test/p.png)');
  });

  it('degrades a missing asset to italic alt text', () => {
    const md = toMarkdown(buildDocumentModel({title: 'T', icon: '', snapshot: snapshot([{type: 'image', data: {assetId: 'gone', alt: 'Missing'}}])}));
    expect(md).toContain('_Missing_');
    expect(md).not.toContain('![');
  });
});

describe('exportBlocks clipboard renderers — image case', () => {
  it('HTML uses a legacy src and degrades to alt otherwise', () => {
    expect(blocksToHtml([{id: 'i', type: 'image', props: {src: 'data:image/png;base64,ZZ', alt: 'A'}}])).toContain('<img src="data:image/png;base64,ZZ" alt="A">');
    const degraded = blocksToHtml([{id: 'i', type: 'image', props: {assetId: 'x', alt: 'Only alt'}}]);
    expect(degraded).toContain('Only alt');
    expect(degraded).not.toContain('<img');
  });

  it('Markdown uses a legacy src and degrades to alt otherwise', () => {
    expect(blocksToMarkdown([{id: 'i', type: 'image', props: {src: 'https://x.test/p.png', alt: 'A'}}])).toContain('![A](https://x.test/p.png)');
    expect(blocksToMarkdown([{id: 'i', type: 'image', props: {assetId: 'x', alt: 'Only alt'}}])).toContain('_Only alt_');
  });
});

describe('toPdf pre-pass — awaitImages', () => {
  /** Build an <img> with controllable complete/naturalWidth/decode for the wait. */
  const img = (opts: {complete?: boolean; naturalWidth?: number; decode?: () => Promise<void>}): HTMLImageElement => {
    const el = document.createElement('img');
    Object.defineProperty(el, 'complete', {value: opts.complete ?? false, configurable: true});
    Object.defineProperty(el, 'naturalWidth', {value: opts.naturalWidth ?? 0, configurable: true});
    Object.defineProperty(el, 'decode', {value: opts.decode, configurable: true});
    return el;
  };

  it('resolves once every image is loaded/decoded (and never hangs on a broken one)', async () => {
    const root = document.createElement('div');
    const loaded = img({complete: true, naturalWidth: 10}); // already ready
    const decodes = img({decode: () => Promise.resolve()}); // ready via decode()
    const broken = img({decode: () => Promise.reject(new Error('bad'))}); // ready via error event
    root.append(loaded, decodes, broken);

    const done = awaitImages(root); // listeners attached synchronously in the executors
    broken.dispatchEvent(new Event('error'));
    // If any image were left un-awaited this would reject on the test timeout.
    await expect(done).resolves.toBeUndefined();
  });
});
