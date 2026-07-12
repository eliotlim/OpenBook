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

  it('returns null when the island is not a space bundle', () => {
    const pageIsland = islandScript({version: 1, id: 'x', data: {}});
    expect(readLibraryIsland(pageIsland)).toBeNull();
  });
});
