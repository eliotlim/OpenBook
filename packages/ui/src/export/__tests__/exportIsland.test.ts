import {describe, it, expect} from 'vitest';
import type {PageSnapshot, DatabaseSchema} from '@book.dev/sdk';
import {readIsland, readLibraryIsland, OPENBOOK_ISLAND_MARKER} from '@book.dev/sdk';
import {createDoc, encodeSnapshot, type NewBlock} from '../../blockeditor/model';
import {toHtml, toSlideDeck} from '../toHtml';
import {toHtmlSite} from '../toHtml';
import type {SiteBundle} from '../exportSite';

/**
 * Every standalone HTML export ALWAYS embeds its lossless `openbook+json` source
 * island (no toggle) — this is the export format's contract, consumed by the
 * future vendored viewer + island-first import. These guard the island's shape,
 * its lossless round-trip, and its immunity to hostile page content.
 */

const blockSnapshot = (blocks: NewBlock[]): PageSnapshot =>
  ({editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: encodeSnapshot(createDoc(blocks))}) as never;

/** Count the source-island `<script>`s in a document. Matches the actual tag
 *  (`<script type="…"`), not any occurrence of the marker string — the vendored
 *  viewer's boot script legitimately mentions the marker in its selector. */
const islandCount = (html: string): number =>
  (html.match(new RegExp(`<script type="${OPENBOOK_ISLAND_MARKER.replace(/[/+]/g, '\\$&')}"`, 'g')) ?? []).length;

describe('single-page export island', () => {
  const snapshot = blockSnapshot([
    {type: 'heading', text: [{t: 'Hello'}], props: {level: 2}},
    {type: 'paragraph', text: [{t: 'World'}]},
    {type: 'image', props: {assetId: 'asset-123', alt: 'A cat'}},
  ]);

  it('embeds exactly one island that parses back to a snapshot deep-equal to the input', () => {
    const html = toHtml(snapshot, 'My Page', '📄', new Map(), {id: 'page-1', updatedAt: '2026-07-04T00:00:00.000Z'});
    expect(islandCount(html)).toBe(1);
    const island = readIsland<{version: number; id: string; name: string; icon: string; data: PageSnapshot}>(html)!;
    expect(island).not.toBeNull();
    expect(island.version).toBe(1);
    expect(island.id).toBe('page-1');
    expect(island.name).toBe('My Page');
    expect(island.icon).toBe('📄');
    // Lossless: the island's data deep-equals the raw input snapshot (block ids,
    // blockdoc, everything) — it is the source, not the flattened render.
    expect(island.data).toEqual(snapshot);
  });

  it('keeps image assetIds intact in the island (never rewritten to a data-URI)', () => {
    // The visible <img> carries the resolved data-URI; the island keeps the
    // assetId, so re-import preserves the content-addressed reference + read-gate.
    const html = toHtml(snapshot, 'My Page', '📄', new Map([['asset-123', 'data:image/png;base64,AQ==']]));
    expect(html).toContain('data:image/png;base64,AQ=='); // visible body resolved
    expect(JSON.stringify(readIsland(html))).toContain('asset-123'); // island faithful
    expect(JSON.stringify(readIsland(html))).not.toContain('data:image/png;base64,AQ==');
  });

  it('embeds the same lossless island in a slide deck', () => {
    const deck = toSlideDeck(snapshot, 'Deck', '🎞', new Map(), {id: 'page-1'});
    expect(islandCount(deck)).toBe(1);
    expect(readIsland<{data: PageSnapshot}>(deck)!.data).toEqual(snapshot);
  });
});

describe('site export island', () => {
  const dbSchema = {properties: [{id: 'p1', name: 'Status', type: 'text'}], views: []} as unknown as DatabaseSchema;
  const bundle: SiteBundle = {
    rootId: 'root',
    pages: [
      {id: 'root', title: 'Root', icon: '', snapshot: blockSnapshot([{type: 'paragraph', text: [{t: 'root'}]}])},
      {id: 'child', title: 'Child', icon: '', snapshot: blockSnapshot([{type: 'paragraph', text: [{t: 'child'}]}])},
    ],
    space: {
      pages: [
        {
          id: 'root', name: 'Root', data: blockSnapshot([{type: 'paragraph', text: [{t: 'root'}]}]),
          hostedDatabaseId: 'db-1', databaseId: null, parentId: null, properties: {},
          deletedAt: null, createdAt: '', updatedAt: '',
        },
        {
          id: 'child', name: 'Child', data: blockSnapshot([{type: 'paragraph', text: [{t: 'child'}]}]),
          hostedDatabaseId: null, databaseId: null, parentId: 'root', properties: {},
          deletedAt: null, createdAt: '', updatedAt: '',
        },
      ],
      databases: [{id: 'db-1', pageId: 'root', name: 'Tasks', schema: dbSchema, createdAt: '', updatedAt: ''}],
    },
  };

  it('embeds one island parsing to a space bundle listing every page + database', () => {
    const html = toHtmlSite(bundle);
    expect(islandCount(html)).toBe(1);
    const parsed = readLibraryIsland(html)!;
    expect(parsed).not.toBeNull();
    expect(parsed.rootId).toBe('root');
    expect(parsed.space.pages.map((p) => p.id).sort()).toEqual(['child', 'root']);
    expect(parsed.space.databases.map((d) => d.id)).toEqual(['db-1']);
    // Nesting survives (openbook.space.json structure — parentId preserved).
    expect(parsed.space.pages.find((p) => p.id === 'child')?.parentId).toBe('root');
  });
});

describe('island escaping (hostile page content)', () => {
  const tricky = blockSnapshot([
    {type: 'heading', text: [{t: '</script><script>alert(1)</script>'}], props: {level: 1}},
    {type: 'paragraph', text: [{t: 'a </div> b </ c'}]},
  ]);

  it('a </script> / </ in content cannot break the island or the document', () => {
    const evilName = 'Pwn </script><img src=x onerror=alert(1)>';
    const html = toHtml(tricky, evilName, '', new Map(), {id: 'p'});
    // The island is escaped: literal `</` becomes `<\/`, so the tag never closes early.
    expect(html).toContain('<\\/script>');
    // Exactly one island, and it still round-trips the source losslessly.
    expect(islandCount(html)).toBe(1);
    expect(readIsland<{name: string; data: PageSnapshot}>(html)!.data).toEqual(tricky);
    expect(readIsland<{name: string}>(html)!.name).toBe(evilName);
    // The visible body escapes the same content as text (no raw executable tag).
    expect(html).toContain('&lt;/script&gt;');
  });
});
