import {describe, expect, it} from 'vitest';
import {
  OPENBOOK_ISLAND_MARKER,
  encodeIsland,
  islandScript,
  readIsland,
  readIslandRaw,
  libraryIslandScript,
  readLibraryIsland,
  type PageSnapshot,
  type LibrarySnapshot,
} from '@book.dev/sdk';

/**
 * The shared source-island helpers underpin BOTH the sync-folder `.book.html`
 * format and every standalone HTML export. These guard the generic writer/reader,
 * the `</`-escaping that makes islands immune to hostile content, and the
 * whole-space (site export) island round-trip.
 */

describe('encodeIsland / islandScript / readIsland', () => {
  it('round-trips an arbitrary value through the escaped island', () => {
    const value = {a: 1, nested: {b: [true, 'x']}};
    const html = `<html><body>${islandScript(value)}</body></html>`;
    expect(html).toContain(`type="${OPENBOOK_ISLAND_MARKER}"`);
    expect(readIsland(html)).toEqual(value);
  });

  it('escapes </ so a literal </script> cannot close the tag early', () => {
    const value = {evil: 'a </script><script>alert(1)</script> b </div>'};
    const body = encodeIsland(value);
    expect(body).toContain('<\\/script>'); // the `<\/` escape
    expect(body).not.toMatch(/<\/script>/); // no un-escaped closer inside the body
    const html = islandScript(value);
    expect(readIsland(html)).toEqual(value); // still parses back intact
  });

  it('returns null for missing or corrupt islands', () => {
    expect(readIsland('<html><body>no island</body></html>')).toBeNull();
    expect(readIslandRaw('<html>nope</html>')).toBeNull();
    const broken = `<script type="${OPENBOOK_ISLAND_MARKER}">{not json</script>`;
    expect(readIsland(broken)).toBeNull();
  });

  it('honours extra attrs and indent', () => {
    const out = islandScript({k: 1}, {attrs: 'data-openbook-snapshot', indent: '  '});
    expect(out).toBe(`  <script type="${OPENBOOK_ISLAND_MARKER}" data-openbook-snapshot>\n{"k":1}\n  </script>`);
  });
});

describe('space island (site export)', () => {
  const snap = (text: string): PageSnapshot => ({editorjs: {blocks: [{id: 'a', type: 'paragraph', data: {text}}]}, values: [], names: []});
  const space: LibrarySnapshot = {
    pages: [
      {id: 'root', name: 'Root', data: snap('root'), hostedDatabaseId: 'db', databaseId: null, parentId: null, properties: {}, deletedAt: null, createdAt: '', updatedAt: ''},
      {id: 'kid', name: 'Kid', data: snap('kid'), hostedDatabaseId: null, databaseId: null, parentId: 'root', properties: {}, deletedAt: null, createdAt: '', updatedAt: ''},
    ],
    databases: [{id: 'db', pageId: 'root', name: 'Tasks', schema: {properties: [], views: []}, createdAt: '', updatedAt: ''}],
  };

  it('round-trips the whole space bundle (pages + databases + nesting)', () => {
    const html = `<html><body>${libraryIslandScript('root', space)}</body></html>`;
    const parsed = readLibraryIsland(html)!;
    expect(parsed).not.toBeNull();
    expect(parsed.rootId).toBe('root');
    expect(parsed.space).toEqual(space);
    expect(parsed.space.pages.find((p) => p.id === 'kid')?.parentId).toBe('root');
  });

  it('writes the NEW `library` island key (LIB-4), never the legacy `space` key', () => {
    // The wire payload is what already-published readers key off, so assert the
    // serialized JSON directly (readIslandRaw is still `<\/`-escaped, JSON.parse
    // unescapes it).
    const html = `<html><body>${libraryIslandScript('root', space)}</body></html>`;
    const payload = JSON.parse(readIslandRaw(html)!) as Record<string, unknown>;
    expect(payload.library).toBeDefined();
    expect(payload.space).toBeUndefined();
    expect(payload.rootId).toBe('root');
  });

  it('dual-read: still imports a legacy island that carries the old `space` key', () => {
    // A pre-LIB-4 export embedded `{version, rootId, space}` — the exact shape the
    // old writer produced. Build that fixture with the generic islandScript and
    // prove the current reader recovers it.
    const legacyHtml = `<html><body>${islandScript({version: 1, rootId: 'root', space})}</body></html>`;
    expect(legacyHtml).toContain('"space"');
    expect(legacyHtml).not.toContain('"library"');
    const parsed = readLibraryIsland(legacyHtml)!;
    expect(parsed).not.toBeNull();
    expect(parsed.rootId).toBe('root');
    expect(parsed.space).toEqual(space);
    expect(parsed.space.pages.find((p) => p.id === 'kid')?.parentId).toBe('root');
  });

  it('returns null when the island is not a space bundle', () => {
    const pageIsland = islandScript({version: 1, id: 'x', data: {}});
    expect(readLibraryIsland(pageIsland)).toBeNull();
  });

  // ── LX-2 `ledger` key: the parse boundary is DEEP-validated (Sasha) ─────────
  // Island text is untrusted input and LX-4's import will consume this type
  // verbatim, so a hostile/malformed key must be dropped — never throw, never
  // carry a shape the type doesn't promise.

  const ledgerSection = () => ({
    settings: {ledgerDb: {hostPageId: 'h', accounts: 'a', transactions: 't', postings: 'p', reconciliations: 'r', hostPages: {}}},
    library: {
      pages: [{id: 'h', name: 'h', data: snap('h'), hostedDatabaseId: null, databaseId: null, parentId: null, properties: {}, deletedAt: null, createdAt: '', updatedAt: ''}],
      databases: [{id: 'a', pageId: 'h', name: 'Accounts', schema: {properties: [], views: []}, createdAt: '', updatedAt: ''}],
    },
    auditHead: {seq: 7, hash: 'ab'.repeat(32)},
  });

  const islandWithLedger = (ledger: unknown): string =>
    `<html><body>${islandScript({version: 1, rootId: 'root', library: space, ledger})}</body></html>`;

  it('a well-formed ledger key round-trips (settings + library + auditHead)', () => {
    const parsed = readLibraryIsland(islandWithLedger(ledgerSection()))!;
    expect(parsed.ledger).toEqual(ledgerSection());
  });

  it('hostile shapes are dropped without a throw: arrays, missing parts, bad auditHead, bad elements', () => {
    const good = ledgerSection();
    const hostile: unknown[] = [
      [], // an array passes a typeof-object check — must not pass here
      'ledger', // not an object at all
      {...good, settings: []}, // settings must be a plain object, not an array
      {...good, settings: 'x'},
      {...good, library: {pages: {}, databases: []}}, // pages not an array
      {...good, library: {pages: [{name: 'no id'}], databases: []}}, // page without a string id
      {...good, library: {pages: good.library.pages, databases: [{id: 'a'}]}}, // database without pageId
      {...good, auditHead: {seq: 'high', hash: 'x'}}, // seq not a number
      {...good, auditHead: {seq: 1}}, // hash missing
      {...good, auditHead: 42},
    ];
    for (const ledger of hostile) {
      const parsed = readLibraryIsland(islandWithLedger(ledger))!;
      expect(parsed).not.toBeNull(); // the space bundle itself still reads
      expect(parsed.ledger).toBeUndefined();
    }
  });

  it('strips __proto__/constructor/prototype keys from settings (prototype-pollution gadget)', () => {
    // Build the hostile payload as raw JSON — JSON.parse creates own
    // `__proto__` data properties that object literals cannot express.
    const section = ledgerSection();
    const json = JSON.stringify({version: 1, rootId: 'root', library: space, ledger: section}).replace(
      '"ledgerDb"',
      '"__proto__":{"polluted":true},"constructor":{"bad":1},"nested":{"prototype":{"x":1},"keep":"ok"},"ledgerDb"',
    );
    const html = `<script type="${OPENBOOK_ISLAND_MARKER}">\n${json}\n</script>`;
    const parsed = readLibraryIsland(html)!;
    expect(parsed.ledger).toBeDefined();
    const settings = parsed.ledger!.settings as Record<string, unknown>;
    expect(Object.keys(settings)).not.toContain('__proto__');
    expect(Object.keys(settings)).not.toContain('constructor');
    expect((settings.nested as Record<string, unknown>).keep).toBe('ok');
    expect(Object.keys(settings.nested as Record<string, unknown>)).not.toContain('prototype');
    expect(settings.ledgerDb).toEqual(section.settings.ledgerDb);
    // And nothing leaked onto Object.prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a valid section with a null auditHead (empty audit stream) is kept', () => {
    const parsed = readLibraryIsland(islandWithLedger({...ledgerSection(), auditHead: null}))!;
    expect(parsed.ledger).toBeDefined();
    expect(parsed.ledger!.auditHead).toBeNull();
  });
});
