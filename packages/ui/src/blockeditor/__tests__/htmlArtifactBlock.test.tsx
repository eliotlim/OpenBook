import {afterEach, describe, expect, it} from 'vitest';
import {render, cleanup, waitFor} from '@testing-library/react';
import {createDoc, docToJSON} from '../model';
import {BlockEditor} from '../BlockEditor';
import {
  HTML_ARTIFACT_TOO_LARGE_MESSAGE,
  htmlArtifactBlockFromFile,
  isHtmlFile,
  editorFilesFromTransfer,
  type HtmlArtifactBlockProps,
} from '../htmlArtifactBlock';
import {MAX_ASSET_BYTES} from '../imageBlock';
import {blockSnapshotToEditorJs, blocksToHtml, blocksToMarkdown} from '../exportBlocks';
import {collectAssetIds} from '../../export/exportAssets';
import {SANDBOX_FLAGS} from '@/lib/srcdoc';
import {setAssetBridge, type AssetBridgeImpl} from '@/lib/assetBridge';

/**
 * The htmlArtifact block: ingest uploads the document to the content-addressed
 * asset store (never the CRDT), the block JSON projection carries the assetId
 * through to the export pipeline, and the view renders the resolved text
 * through the sandboxed renderer (opaque origin — see lib/srcdoc.ts).
 */

/**
 * A CONTENT-ADDRESSED in-memory bridge (id = the bytes themselves), mirroring
 * the real server's SHA-256 store: byte-identical uploads yield the same id.
 */
function installContentAddressedBridge() {
  const assets = new Map<string, {bytes: Uint8Array; mime: string}>();
  let puts = 0;
  const impl: AssetBridgeImpl = {
    putAsset: (bytes, mime) => {
      puts += 1;
      const id = `sha-${Array.from(bytes).join('.')}`;
      if (!assets.has(id)) assets.set(id, {bytes: new Uint8Array(bytes), mime});
      return Promise.resolve({id});
    },
    getAsset: (id) => Promise.resolve(assets.get(id) ?? null),
  };
  setAssetBridge(impl);
  return {assets, puts: () => puts};
}

afterEach(() => {
  cleanup();
  setAssetBridge(null);
});

const htmlFile = (name = 'demo.html', body = '<h1>hi</h1>'): File => new File([body], name, {type: 'text/html'});

describe('htmlArtifact — file narrowing + transfer extraction', () => {
  it('accepts text/html and .html/.htm names (empty mime from OS drags)', () => {
    expect(isHtmlFile(htmlFile())).toBe(true);
    expect(isHtmlFile(new File(['x'], 'widget.HTM', {type: ''}))).toBe(true);
    expect(isHtmlFile(new File(['x'], 'notes.txt', {type: 'text/plain'}))).toBe(false);
    expect(isHtmlFile(new File(['x'], 'p.png', {type: 'image/png'}))).toBe(false);
  });

  it('editorFilesFromTransfer keeps images AND html, in order, deduped', () => {
    const img = new File(['i'], 'p.png', {type: 'image/png'});
    const html = htmlFile();
    const txt = new File(['t'], 'a.txt', {type: 'text/plain'});
    const dt = {files: [img, html, txt, html]} as unknown as DataTransfer;
    const out = editorFilesFromTransfer(dt);
    expect(out).toEqual([img, html]); // mixed drop: both kinds, txt dropped, html deduped
  });
});

describe('htmlArtifact — ingest (drop / slash-picker both use htmlArtifactBlockFromFile)', () => {
  it('uploads the bytes as text/html and stores only the assetId (title seeded from the name)', async () => {
    const {assets} = installContentAddressedBridge();
    const res = await htmlArtifactBlockFromFile(htmlFile('sales_dashboard.html'), 'page-1');
    expect('block' in res).toBe(true);
    if (!('block' in res)) return;
    const props = res.block.props as unknown as HtmlArtifactBlockProps;
    expect(props.assetId).toBeTruthy();
    expect(props.title).toBe('sales dashboard');
    // The document went to the store (as text/html at ingest; the server
    // serves it back as octet-stream — that coercion is its job, not ours).
    expect(assets.get(props.assetId!)?.mime).toBe('text/html');
    // Nothing inline in the block: the CRDT never carries the markup.
    expect(Object.keys(res.block.props ?? {})).toEqual(['assetId', 'title']);
  });

  it('byte-identical re-ingest dedups to the SAME assetId (content-addressed)', async () => {
    installContentAddressedBridge();
    const a = await htmlArtifactBlockFromFile(htmlFile('one.html', '<p>same bytes</p>'), 'page-1');
    const b = await htmlArtifactBlockFromFile(htmlFile('two.html', '<p>same bytes</p>'), 'page-1');
    if (!('block' in a) || !('block' in b)) throw new Error('ingest failed');
    const idA = (a.block.props as unknown as HtmlArtifactBlockProps).assetId;
    const idB = (b.block.props as unknown as HtmlArtifactBlockProps).assetId;
    expect(idA).toBeTruthy();
    expect(idA).toBe(idB);
  });

  it('rejects non-HTML files', async () => {
    installContentAddressedBridge();
    const res = await htmlArtifactBlockFromFile(new File(['x'], 'a.txt', {type: 'text/plain'}), 'page-1');
    expect('error' in res && !res.soft).toBe(true);
  });

  it('rejects an over-cap (>10 MiB) file with the soft too-large message (pre-check)', async () => {
    installContentAddressedBridge();
    const big = {type: 'text/html', size: MAX_ASSET_BYTES + 1, name: 'big.html'} as unknown as File;
    const res = await htmlArtifactBlockFromFile(big, 'page-1');
    expect('error' in res).toBe(true);
    if (!('error' in res)) return;
    expect(res.error).toBe(HTML_ARTIFACT_TOO_LARGE_MESSAGE);
    expect(res.soft).toBe(true);
  });

  it('fails friendly (no inline fallback) without a page id / asset backend', async () => {
    installContentAddressedBridge();
    const noPage = await htmlArtifactBlockFromFile(htmlFile());
    expect('error' in noPage).toBe(true);
    setAssetBridge(null);
    const noBridge = await htmlArtifactBlockFromFile(htmlFile(), 'page-1');
    expect('error' in noBridge).toBe(true);
  });

  it('maps a server 413 to the soft too-large message', async () => {
    setAssetBridge({
      putAsset: () => Promise.reject(new Error('OpenBook request failed (413 Payload Too Large)')),
      getAsset: () => Promise.resolve(null),
    });
    const res = await htmlArtifactBlockFromFile(htmlFile(), 'page-1');
    expect('error' in res).toBe(true);
    if (!('error' in res)) return;
    expect(res.error).toBe(HTML_ARTIFACT_TOO_LARGE_MESSAGE);
    expect(res.soft).toBe(true);
  });
});

describe('htmlArtifact — block JSON projection carries the assetId', () => {
  const blockdoc = () => ({
    blocks: docToJSON(
      createDoc([{id: 'art', type: 'htmlArtifact', props: {assetId: 'A-html', title: 'Widget', height: 480}}]),
    ),
  });

  it('docToJSON keeps assetId/title/height on the block', () => {
    const [b] = blockdoc().blocks;
    expect(b.type).toBe('htmlArtifact');
    expect(b.props?.assetId).toBe('A-html');
    expect(b.props?.title).toBe('Widget');
    expect(b.props?.height).toBe(480);
  });

  it('blockSnapshotToEditorJs projects the artifact with its assetId', () => {
    const snapshot = blockSnapshotToEditorJs({editor: 'blocks', blockdoc: blockdoc(), editorjs: {blocks: []}} as never);
    const blocks = (snapshot as {editorjs?: {blocks?: Array<{type: string; data: Record<string, unknown>}>}}).editorjs?.blocks ?? [];
    const art = blocks.find((b) => b.type === 'htmlArtifact');
    expect(art?.data.assetId).toBe('A-html');
    expect(art?.data.title).toBe('Widget');
    expect(art?.data.height).toBe(480);
  });

  it('collectAssetIds picks up artifact assetIds (export asset pre-pass)', () => {
    const snapshot = {editor: 'blocks', blockdoc: blockdoc(), editorjs: {blocks: []}};
    expect(collectAssetIds(snapshot as never)).toEqual(['A-html']);
  });
});

describe('htmlArtifact — export arms (placeholder for now)', () => {
  const blocks = docToJSON(
    createDoc([{id: 'art', type: 'htmlArtifact', props: {assetId: 'A', title: '<b>“Chart” & co</b>'}}]),
  );

  it('HTML export emits a captioned figure placeholder with the title escaped', () => {
    const html = blocksToHtml(blocks);
    expect(html).toContain('<figure class="obe-x-artifact">');
    expect(html).toContain('&lt;b&gt;“Chart” &amp; co&lt;/b&gt;'); // escaped, no tag injection
    expect(html).not.toContain('<b>“Chart”');
    expect(html).toContain('<figcaption>');
  });

  it('Markdown export emits a callout line', () => {
    const md = blocksToMarkdown(docToJSON(createDoc([{type: 'htmlArtifact', props: {title: 'My widget'}}])));
    expect(md).toContain('> **HTML artifact:** My widget');
  });
});

describe('htmlArtifact — view renders through the sandboxed renderer', () => {
  it('resolves the assetId and mounts a sandboxed iframe (no allow-same-origin)', async () => {
    const {assets} = installContentAddressedBridge();
    assets.set('A1', {bytes: new TextEncoder().encode('<h1 id="inner">artifact!</h1>'), mime: 'application/octet-stream'});
    const doc = createDoc([{id: 'art', type: 'htmlArtifact', props: {assetId: 'A1', title: 'Demo'}}]);
    const {container} = render(<BlockEditor doc={doc} pageId="page-1" />);

    await waitFor(() => expect(container.querySelector('.obe-artifact iframe')).toBeTruthy());
    const frame = container.querySelector('.obe-artifact iframe') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe(SANDBOX_FLAGS);
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.getAttribute('srcdoc')).toContain('<h1 id="inner">artifact!</h1>');
    // Authoring chrome present in an editable context.
    expect(container.querySelector('input.obe-artifact-title')).toBeTruthy();
    expect(container.querySelector('.obe-artifact-resize')).toBeTruthy();
  });

  it('read-only: the frame still mounts (interactive for readers) but chrome is gone', async () => {
    const {assets} = installContentAddressedBridge();
    assets.set('A1', {bytes: new TextEncoder().encode('<p>live</p>'), mime: 'application/octet-stream'});
    const doc = createDoc([{id: 'art', type: 'htmlArtifact', props: {assetId: 'A1', title: 'Demo'}}]);
    const {container} = render(<BlockEditor doc={doc} pageId="page-1" readOnly />);

    await waitFor(() => expect(container.querySelector('.obe-artifact iframe')).toBeTruthy());
    expect(container.querySelector('input.obe-artifact-title')).toBeNull();
    expect(container.querySelector('.obe-artifact-resize')).toBeNull();
    expect(container.querySelector('.obe-artifact input[type=file]')).toBeNull();
    // The static title still shows for readers.
    expect(container.querySelector('.obe-artifact-title-static')?.textContent).toBe('Demo');
  });

  it('empty block: an editable placeholder opens the .html file picker', () => {
    installContentAddressedBridge();
    const doc = createDoc([{id: 'art', type: 'htmlArtifact'}]);
    const {container} = render(<BlockEditor doc={doc} pageId="page-1" />);
    const button = container.querySelector('.obe-artifact .obe-image-placeholder') as HTMLButtonElement;
    expect(button).toBeTruthy();
    const input = container.querySelector('.obe-artifact input[type=file]') as HTMLInputElement;
    expect(input?.accept).toBe('.html,.htm,text/html');
  });
});
