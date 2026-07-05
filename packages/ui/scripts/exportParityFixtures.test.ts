import {describe, it, expect} from 'vitest';
import {mkdirSync, writeFileSync} from 'fs';
import {dirname, resolve} from 'path';
import {fileURLToPath} from 'url';
import {toHtml, toHtmlSite} from '../src/export/toHtml';
import {parityExportSnapshot, paritySiteBundle} from '../src/export/__tests__/parityFixtureDoc';

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
 */

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/e2e-viewer/generated');

describe('parity fixture generation (consumed by e2e-viewer/export-parity.spec.ts)', () => {
  it('writes a deterministic single-page export', () => {
    const snap = parityExportSnapshot();
    const meta = {id: 'fx-root', updatedAt: '2026-07-04T00:00:00.000Z'};
    const html = toHtml(snap, 'Parity fixture', '🧪', new Map(), meta);
    expect(toHtml(snap, 'Parity fixture', '🧪', new Map(), meta)).toBe(html); // byte-stable
    mkdirSync(OUT_DIR, {recursive: true});
    writeFileSync(resolve(OUT_DIR, 'export-page.html'), html);
  });

  it('writes a deterministic site-bundle export', () => {
    const bundle = paritySiteBundle();
    const html = toHtmlSite(bundle);
    expect(toHtmlSite(bundle)).toBe(html); // byte-stable
    mkdirSync(OUT_DIR, {recursive: true});
    writeFileSync(resolve(OUT_DIR, 'export-site.html'), html);
  });
});
