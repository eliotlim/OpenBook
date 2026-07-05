import {describe, it, expect} from 'vitest';
import {
  assetsIslandScript,
  islandScript,
  readAssetsIsland,
  readIsland,
  OPENBOOK_ASSETS_MARKER,
  type ExportAssetEntry,
} from './island';

/**
 * The export **assets island** — the sibling blob carrying asset bytes (HTML
 * artifact documents) alongside the source island. These pin the contract the
 * standalone viewer's boot and island-first import rely on: exact byte
 * round-trip through adversarial content, coexistence with the source island,
 * and spoof resistance (a fake opening tag inside an earlier island can't mask
 * or corrupt the real one).
 */

const HOSTILE_DOC =
  '<!doctype html><title>"quoted" & \'quoted\'</title>' +
  '<script>document.body.textContent = "</closed>";</' + 'script>' +
  '<iframe srcdoc="nested &quot;srcdoc&quot; content"></iframe>' +
  'we’re 🎉 emoji + </script> + </iframe> literals';

const entry = (data: string): ExportAssetEntry => ({mime: 'text/html', encoding: 'utf8', data});

describe('assets island', () => {
  it('round-trips adversarial artifact text exactly', () => {
    const html = `<!doctype html><body>${assetsIslandScript({'sha-1': entry(HOSTILE_DOC)})}</body>`;
    const parsed = readAssetsIsland(html);
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe(1);
    expect(parsed!.assets['sha-1']).toEqual({mime: 'text/html', encoding: 'utf8', data: HOSTILE_DOC});
    // The serialized island never contains a raw `</` (tag-closing) sequence
    // inside its body, so hostile content cannot terminate the script tag.
    const body = html.slice(html.indexOf('data-openbook-assets'), html.lastIndexOf('</script>'));
    expect(body).not.toMatch(/<\/(?!\\)/); // every `</` is the escaped `<\/`
  });

  it('coexists with the source island (each reader finds its own)', () => {
    const source = islandScript({version: 1, id: 'p1', data: {x: 1}}, {attrs: 'data-openbook-snapshot'});
    const assets = assetsIslandScript({'sha-1': entry('<b>doc</b>')});
    const html = `<!doctype html><body><main>static</main>\n${source}\n${assets}</body>`;
    expect(readIsland<{id: string}>(html)!.id).toBe('p1');
    expect(readAssetsIsland(html)!.assets['sha-1'].data).toBe('<b>doc</b>');
  });

  it('is not masked by a spoof opening tag inside the source island', () => {
    // A page whose TEXT contains a literal assets-island opening tag: it lands
    // inside the source island's JSON (only `</` is escaped there, `<script…>`
    // is not). The scan-and-shape-check reader must skip the garbage candidate
    // and still find the real island that follows.
    const spoof = `<script type="${OPENBOOK_ASSETS_MARKER}">`;
    const source = islandScript({version: 1, id: 'p1', name: `evil ${spoof} name`, data: {}});
    const assets = assetsIslandScript({'sha-real': entry('real payload')});
    const html = `<body>${source}\n${assets}</body>`;
    const parsed = readAssetsIsland(html);
    expect(parsed).not.toBeNull();
    expect(parsed!.assets['sha-real'].data).toBe('real payload');
    // And the spoof did not corrupt the source island either.
    expect(readIsland<{id: string}>(html)!.id).toBe('p1');
  });

  it('returns null when absent or corrupt', () => {
    expect(readAssetsIsland('<body>nothing here</body>')).toBeNull();
    expect(readAssetsIsland(`<script type="${OPENBOOK_ASSETS_MARKER}">not json</script>`)).toBeNull();
    // Wrong shape (no version/assets) is rejected, not half-parsed.
    expect(readAssetsIsland(`<script type="${OPENBOOK_ASSETS_MARKER}">{"foo":1}</script>`)).toBeNull();
  });
});
