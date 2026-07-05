import {describe, it, expect} from 'vitest';
import type {PageSnapshot} from '@book.dev/sdk';
import {readAssetsIsland, readIsland} from '@book.dev/sdk';
import {SANDBOX_FLAGS, EXPORT_ARTIFACT_CSP, escapeSrcdocAttribute, wrapSandboxDocument} from '@/lib/srcdoc';
import {createDoc, encodeSnapshot, type NewBlock} from '../../blockeditor/model';
import {resolveExportAssets, type ExportAssets} from '../exportAssets';
import {toHtml, toHtmlSite, toSlideDeck} from '../toHtml';
import type {SiteBundle} from '../exportSite';

/**
 * HTML-artifact export: the bytes ride the assets island, the static body is a
 * captioned placeholder, and adversarial artifact content survives every layer
 * (island JSON, assets island, srcdoc attribute). The hydrated sandboxed
 * rendering is exercised end-to-end in the parity harness (real iframe); these
 * pin the payload contract + escaping the harness can't cheaply assert.
 */

const ARTIFACT_ID = 'sha256-artifact';
const ARTIFACT_DOC =
  '<!doctype html><title>"q" & \'q\'</title><script>parent.postMessage("</script>", "*")</' +
  'script><iframe srcdoc="nested"></iframe>we’re 🎉 </iframe> </script>';

const artifactSnapshot = (props: Record<string, unknown> = {assetId: ARTIFACT_ID, title: 'My widget'}): PageSnapshot => {
  const blocks: NewBlock[] = [
    {id: 'h', type: 'heading', props: {level: 1}, text: [{t: 'Doc'}]},
    {id: 'a', type: 'htmlArtifact', props},
  ];
  return {editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: encodeSnapshot(createDoc(blocks))} as never;
};

/** A fake asset store returning the artifact document as text/html bytes. */
const storeWith = (id: string, doc: string) => ({
  getAsset: (assetId: string) =>
    Promise.resolve(assetId === id ? {bytes: new TextEncoder().encode(doc), mime: 'text/html'} : null),
});

const withArtifact = async (snapshot: PageSnapshot): Promise<{html: string; assets: ExportAssets}> => {
  const assets = await resolveExportAssets(storeWith(ARTIFACT_ID, ARTIFACT_DOC), [snapshot]);
  return {html: toHtml(snapshot, 'Doc', '', assets, {id: 'p1'}), assets};
};

describe('resolveExportAssets — artifact text', () => {
  it('resolves an htmlArtifact assetId to UTF-8 text, not a data-URI', async () => {
    const {assets} = await withArtifact(artifactSnapshot());
    expect(assets.artifactText.get(ARTIFACT_ID)).toBe(ARTIFACT_DOC);
    expect(assets.images.has(ARTIFACT_ID)).toBe(false);
  });
});

describe('toHtml — artifact export payload', () => {
  it('carries the artifact bytes EXACTLY in the assets island (round-trip)', async () => {
    const {html} = await withArtifact(artifactSnapshot());
    const island = readAssetsIsland(html);
    expect(island).not.toBeNull();
    expect(island!.assets[ARTIFACT_ID]).toEqual({mime: 'text/html', encoding: 'utf8', data: ARTIFACT_DOC});
    // The source island keeps the assetId (lossless, never the bytes inline).
    const source = readIsland<{data: PageSnapshot}>(html)!;
    expect(JSON.stringify(source.data)).toContain(ARTIFACT_ID);
  });

  it('renders a captioned, escaped placeholder — never a live iframe — in the static body', async () => {
    const {html} = await withArtifact(artifactSnapshot({assetId: ARTIFACT_ID, title: '<img src=x onerror=alert(1)>'}));
    const staticBody = html.slice(0, html.indexOf('<script'));
    expect(staticBody).toContain('class="ob-artifact"');
    expect(staticBody).toContain('data-artifact-asset-id="sha256-artifact"');
    expect(staticBody).toContain('&lt;img src=x onerror=alert(1)&gt;'); // title escaped
    expect(staticBody).not.toContain('<iframe'); // no live frame without the viewer
    expect(staticBody).not.toContain('<img src=x'); // the payload can't inject a tag
  });

  it('emits no assets island when the page has no artifacts', () => {
    const html = toHtml(
      {editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: encodeSnapshot(createDoc([{type: 'paragraph', text: [{t: 'hi'}]}]))} as never,
      'Doc',
      '',
    );
    expect(readAssetsIsland(html)).toBeNull();
  });

  it('degrades an unresolvable artifact to the placeholder (no assets island entry)', () => {
    // Export with NO asset store: the assetId can't resolve, the placeholder
    // still renders (title carried), and nothing is smuggled into an island.
    const html = toHtml(artifactSnapshot({assetId: ARTIFACT_ID, title: 'Gone'}), 'Doc', '');
    expect(html).toContain('class="ob-artifact"');
    expect(html).toContain('Gone');
    expect(readAssetsIsland(html)).toBeNull();
  });
});

describe('the assets island survives adversarial artifact content', () => {
  it('never lets the payload break out of the island or the document', async () => {
    const {html} = await withArtifact(artifactSnapshot());
    // Only the ESCAPED form of the hostile close-tag exists outside the islands.
    const outsideIslands = html
      .replace(/<script type="application\/openbook\+json"[\s\S]*?<\/script>/g, '')
      .replace(/<script type="application\/openbook-assets\+json"[\s\S]*?<\/script>/g, '');
    expect(outsideIslands).not.toContain('parent.postMessage'); // the artifact script never lands in the doc
    // The assets island still round-trips the exact bytes despite the payload.
    expect(readAssetsIsland(html)!.assets[ARTIFACT_ID].data).toBe(ARTIFACT_DOC);
  });
});

describe('the srcdoc/sandbox contract the viewer renders through', () => {
  it('keeps the canonical sandbox flags (no allow-same-origin)', () => {
    expect(SANDBOX_FLAGS).toBe('allow-scripts allow-popups allow-forms allow-modals');
    expect(SANDBOX_FLAGS).not.toContain('allow-same-origin');
  });

  it('a quoted srcdoc attribute cannot be broken by the adversarial document', () => {
    const wrapped = wrapSandboxDocument(ARTIFACT_DOC, {csp: EXPORT_ARTIFACT_CSP});
    const attr = escapeSrcdocAttribute(wrapped);
    // Inside a quoted attribute, quotes are the only breakout — both escaped.
    expect(attr).not.toContain('"');
    expect(attr).not.toContain('\'');
    // The CSP meta and untrusted body both survive (as escaped attribute text).
    expect(attr).toContain('Content-Security-Policy');
    expect(attr).toContain('default-src &amp;#39;none&amp;#39;'); // CSP quote-escaped inside the doc, then attribute-escaped
  });

  it('the export CSP is network-off but keeps inline script/style + data: media', () => {
    expect(EXPORT_ARTIFACT_CSP).toContain('default-src \'none\'');
    expect(EXPORT_ARTIFACT_CSP).toContain('script-src \'unsafe-inline\'');
    expect(EXPORT_ARTIFACT_CSP).toContain('img-src data: blob:');
    expect(EXPORT_ARTIFACT_CSP).not.toMatch(/https?:/); // no remote origin allowed
  });
});

describe('site + slide artifact behavior', () => {
  const siteBundle = (): SiteBundle => {
    const snap = artifactSnapshot();
    return {
      rootId: 'r',
      pages: [{id: 'r', title: 'Root', icon: '', snapshot: snap}],
      space: {
        pages: [{id: 'r', name: 'Root', data: snap, hostedDatabaseId: null, databaseId: null, parentId: null, properties: {}, deletedAt: null, createdAt: '', updatedAt: ''}],
        databases: [],
      },
    };
  };

  it('a hydrated site export carries the artifact bytes in its assets island', async () => {
    const bundle = siteBundle();
    const assets = await resolveExportAssets(storeWith(ARTIFACT_ID, ARTIFACT_DOC), [bundle.pages[0].snapshot]);
    const html = toHtmlSite(bundle, assets);
    expect(html).toContain('OpenBookViewer'); // hydrated
    expect(readAssetsIsland(html)!.assets[ARTIFACT_ID].data).toBe(ARTIFACT_DOC);
  });

  it('a slide deck degrades an artifact to the placeholder and emits no assets island', async () => {
    const snap = artifactSnapshot();
    const assets = await resolveExportAssets(storeWith(ARTIFACT_ID, ARTIFACT_DOC), [snap]);
    const deck = toSlideDeck(snap, 'Deck', '', assets);
    expect(deck).toContain('class="ob-artifact"'); // placeholder
    expect(deck).not.toContain('OpenBookViewer'); // deck never hydrates (phase 2)
    expect(readAssetsIsland(deck)).toBeNull(); // no consumer → no island
  });
});
