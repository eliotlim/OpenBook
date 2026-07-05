import {describe, it, expect} from 'vitest';
import type {PageSnapshot} from '@book.dev/sdk';
import {toHtml, toHtmlSite, toSlideDeck} from '../toHtml';
import type {SiteBundle} from '../exportSite';
import {parityExportSnapshot, paritySiteBundle, HOSTILE_TEXT} from './parityFixtureDoc';

/**
 * Runtime selection for the rearchitected HTML export (island-hydrated
 * vendored viewer): block-doc content ships the real OpenBook viewer bundle +
 * boot; the bespoke `#ob-data` runtime and legacy `NAV` router remain ONLY for
 * what the viewer can't render yet — legacy EditorJS snapshots, site bundles
 * containing databases, and slide decks.
 */

const legacySnapshot = (): PageSnapshot =>
  ({
    editorjs: {blocks: [
      {type: 'paragraph', data: {text: 'legacy body'}},
      {type: 'slider', data: {refCellId: 'cell-1', min: 0, max: 10, initial: 5, name: 'x'}},
    ]},
    values: [['cell-1', 5]],
    names: [['x', 'cell-1']],
  }) as never;

describe('viewer-hydrated page export', () => {
  const snap = parityExportSnapshot();
  const html = toHtml(snap, 'Parity fixture', '🧪', new Map(), {id: 'fx-root', updatedAt: '2026-07-04T00:00:00.000Z'});

  it('ships the vendored viewer + boot instead of the bespoke runtime', () => {
    expect(html).toContain('OpenBookViewer');
    expect(html).toContain('ob-viewer-host');
    expect(html).toContain('__OB_NO_HYDRATE'); // the PDF pipeline's static opt-out
    expect(html).not.toContain('id="ob-data"'); // bespoke runtime retired here
    expect(html).not.toContain('id="ob-back"'); // legacy router header retired here
  });

  it('orders body as static render → island → viewer bundle → boot', () => {
    const staticBody = html.indexOf('<main>');
    const island = html.indexOf('<script type="application/openbook+json"');
    const viewer = html.indexOf('OpenBookViewer: already loaded'); // bundle prelude
    const boot = html.indexOf('ob-viewer-host'); // only in the boot script
    expect(staticBody).toBeGreaterThan(-1);
    expect(island).toBeGreaterThan(staticBody);
    expect(viewer).toBeGreaterThan(island); // boot can read the island from the DOM
    expect(boot).toBeGreaterThan(viewer);
  });

  it('keeps the static body readable (no-JS fallback) with computed values baked', () => {
    // Everything before the island is the static projection: real text, the
    // computed formula value, a drawn kit chart, the resolved image.
    const staticPart = html.slice(0, html.indexOf('<script'));
    expect(staticPart).toContain('Parity fixture');
    expect(staticPart).toContain('first tab body');
    expect(staticPart).toContain('<span data-val>240</span>'); // months * 2, precomputed
    expect(staticPart).toContain('data-status="ok"');
    expect(staticPart).toContain('<svg'); // kit chart drawn at build time
    expect(staticPart).toContain('data:image/png;base64,');
    expect(staticPart).toContain('<td>Ada</td>');
  });

  it('escapes hostile content as text everywhere outside the island', () => {
    expect(html).toContain('&lt;/script&gt;'); // visible body: inert text
    expect(html).toContain('Hostile:');
    // The raw hostile sequence never appears unescaped outside the island's
    // `<\/`-escaped JSON, so no comment/script can swallow the document.
    const outsideIsland = html.replace(/<script type="application\/openbook\+json"[\s\S]*?<\/script>/, '');
    expect(outsideIsland).not.toContain(HOSTILE_TEXT);
  });

  it('is deterministic: the same snapshot renders byte-identical HTML', () => {
    expect(toHtml(snap, 'Parity fixture', '🧪', new Map(), {id: 'fx-root', updatedAt: '2026-07-04T00:00:00.000Z'})).toBe(html);
  });
});

describe('legacy-snapshot page export (no block-doc)', () => {
  it('keeps the bespoke reactive runtime and never boots the viewer', () => {
    const html = toHtml(legacySnapshot(), 'Legacy', '');
    expect(html).toContain('id="ob-data"');
    expect(html).not.toContain('OpenBookViewer');
  });
});

describe('site export runtime selection', () => {
  it('hydrates an all-block-doc, database-free bundle through the viewer', () => {
    const html = toHtmlSite(paritySiteBundle());
    expect(html).toContain('OpenBookViewer');
    expect(html).not.toContain('id="ob-back"'); // legacy router replaced by #page= nav
    expect(html).not.toContain('id="ob-data"');
  });

  it('is deterministic for site bundles too', () => {
    const bundle = paritySiteBundle();
    expect(toHtmlSite(bundle)).toBe(toHtmlSite(bundle));
  });

  it('falls back to the legacy router when the bundle carries a database', () => {
    const bundle = paritySiteBundle();
    const withDb: SiteBundle = {
      ...bundle,
      space: {
        ...bundle.space,
        databases: [{id: 'db-1', pageId: 'fx-root', name: 'Tasks', schema: {properties: [], views: []} as never, createdAt: '', updatedAt: ''}],
      },
    };
    const html = toHtmlSite(withDb);
    expect(html).toContain('id="ob-back"');
    expect(html).not.toContain('OpenBookViewer');
  });

  it('falls back to the legacy router when any page lacks a block-doc', () => {
    const bundle = paritySiteBundle();
    bundle.space.pages[1] = {...bundle.space.pages[1], data: {editorjs: {blocks: []}, values: [], names: []} as never};
    const html = toHtmlSite(bundle);
    expect(html).toContain('id="ob-back"');
    expect(html).not.toContain('OpenBookViewer');
  });
});

describe('slide decks (viewer deck mode is a follow-up)', () => {
  it('keeps the legacy deck runtime + slide nav', () => {
    const html = toSlideDeck(parityExportSnapshot(), 'Deck', '');
    expect(html).toContain('deck-nav');
    expect(html).toContain('id="ob-data"');
    expect(html).not.toContain('OpenBookViewer');
  });
});
