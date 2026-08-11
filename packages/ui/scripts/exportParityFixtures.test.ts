import {describe, it, expect} from 'vitest';
import {mkdirSync, writeFileSync} from 'fs';
import {dirname, resolve} from 'path';
import {fileURLToPath} from 'url';
import {toHtml, toHtmlSite} from '../src/export/toHtml';
import {
  parityExportSnapshot,
  parityExportAssets,
  paritySiteBundle,
  PARITY_PLUGIN_BLOCKS,
  LEDGER_BLOCK_TYPES,
  parityLedgerSiteBundle,
} from '../src/export/__tests__/parityFixtureDoc';

/**
 * Generates the exported-HTML fixtures the Playwright parity harness opens
 * from file:// (packages/web/e2e-viewer/export-parity.spec.ts): a real
 * `toHtml` page export and a real `toHtmlSite` bundle export of the parity
 * fixture doc. Doubles as the byte-determinism guard for both.
 *
 * A test that writes files is unusual, but deliberate: this is the only place
 * in the repo where the export pipeline (?raw-vendored viewer included) can
 * run outside a full app — vitest's vite transform resolves the `?raw`
 * imports. The output dir is gitignored; `pnpm test:e2e:viewer` runs this file
 * (after `build:viewer`) before the browser suite. It lives in scripts/ (not
 * src/) because it needs node fs/path, which the DOM-typed src tsconfig
 * rejects — vitest still runs it as part of the package's test suite.
 *
 * NOTE on fixture bytes across RUNS: each generator run builds a fresh Y.Doc
 * via createDoc(), whose random Yjs clientID lands in the island's base64
 * update — so the generated FILES differ run-to-run. That is expected and not
 * an export-determinism regression: the byte-stability assertions below feed
 * the SAME snapshot twice, which is the real contract (a persisted snapshot
 * always exports byte-identically).
 */

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/e2e-viewer/generated');

describe('parity fixture generation (consumed by e2e-viewer/export-parity.spec.ts)', () => {
  it('writes a deterministic single-page export', async () => {
    const snap = await parityExportSnapshot();
    const assets = parityExportAssets();
    const meta = {id: 'fx-root', updatedAt: '2026-07-04T00:00:00.000Z'};
    const html = toHtml(snap, 'Parity fixture', '🧪', assets, meta);
    expect(toHtml(snap, 'Parity fixture', '🧪', parityExportAssets(), meta)).toBe(html); // byte-stable
    mkdirSync(OUT_DIR, {recursive: true});
    writeFileSync(resolve(OUT_DIR, 'export-page.html'), html);
  });

  // LX-1: the plugin-block page. Exported HTML must show every plugin block as a
  // labelled placeholder — no block may vanish into an empty paragraph.
  it('writes a plugin-block export where every unrenderable block is visibly labelled', async () => {
    const snap = await parityExportSnapshot(PARITY_PLUGIN_BLOCKS);
    const meta = {id: 'lx-root', updatedAt: '2026-07-04T00:00:00.000Z'};
    const html = toHtml(snap, 'Ledger plugin blocks', '📒', parityExportAssets(), meta);
    expect(toHtml(snap, 'Ledger plugin blocks', '📒', parityExportAssets(), meta)).toBe(html); // byte-stable
    mkdirSync(OUT_DIR, {recursive: true});
    writeFileSync(resolve(OUT_DIR, 'export-plugin-blocks.html'), html);

    const body = html.slice(0, html.indexOf('<script type="application/openbook+json"'));
    expect(body).not.toMatch(/<p>\s*<\/p>/); // the LX-1 regression: silent empty paragraphs
    for (const type of LEDGER_BLOCK_TYPES) expect(body).toContain(`data-block-type="${type}"`);
    expect(body).toContain('Trial balance');
    expect(body).toContain('Beancount export');
    // The FIRST-PARTY ledger blocks get ledger-aware hints, not the generic
    // "install the plugin" line (LX-3 replaced that wording and this assertion
    // was left behind): a report says the books weren't included, an
    // interactive tool says it has no static view. Only a genuinely unknown
    // third-party block still names a plugin to install.
    expect(body).toContain('the books weren\'t included in this export');
    expect(body).toContain('Interactive ledger tool');
    expect(body).toContain('requires the Future plugin');
  });

  // LX-3 → LX-5: the ledger REPORTS page, exported twice. Records on, the five
  // report blocks are real tables and must still be tables once the viewer
  // hydrates; records off, they are the ledger-aware "books weren't included"
  // cards and must stay that way.
  it('writes the ledger-reports exports (records on and off)', () => {
    mkdirSync(OUT_DIR, {recursive: true});
    const withRecords = toHtmlSite(parityLedgerSiteBundle(true));
    const noRecords = toHtmlSite(parityLedgerSiteBundle(false));
    // Both files land BEFORE any assertion, so a failing expectation still
    // leaves the browser harness a complete pair to open.
    writeFileSync(resolve(OUT_DIR, 'export-ledger-reports.html'), withRecords);
    writeFileSync(resolve(OUT_DIR, 'export-ledger-norecords.html'), noRecords);

    // Records on: real tables, each marked for the hydrating viewer to keep.
    expect(withRecords).toContain('figure class="ob-ledger-report"');
    expect(withRecords).toContain('data-ob-keep-static="ledger"');
    expect(withRecords).toContain('Amounts in USD');
    // Records off: no fabricated tables, and the ledger-aware wording instead.
    expect(noRecords).not.toContain('figure class="ob-ledger-report"');
    expect(noRecords).toContain('the books weren\'t included in this export');
  });

  it('writes a deterministic site-bundle export', async () => {
    const bundle = await paritySiteBundle();
    const html = toHtmlSite(bundle, parityExportAssets());
    expect(toHtmlSite(bundle, parityExportAssets())).toBe(html); // byte-stable
    mkdirSync(OUT_DIR, {recursive: true});
    writeFileSync(resolve(OUT_DIR, 'export-site.html'), html);
  });
});
