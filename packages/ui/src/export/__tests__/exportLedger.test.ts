import {describe, it, expect} from 'vitest';
import type {LedgerExportSection, PageSnapshot, StoredPage} from '@book.dev/sdk';
import {readLibraryIsland} from '@book.dev/sdk';
import {createDoc, encodeSnapshot, type NewBlock} from '../../blockeditor/model';
import {toHtmlSite} from '../toHtml';
import {bundleHasLedgerBlocks, snapshotHasLedgerBlocks, type SiteBundle} from '../exportSite';

/**
 * LX-2 — ledger records in the site export island.
 *
 * What a passing suite means:
 *  - DETECTION runs on the RAW block-doc (recursively, so a ledger block inside
 *    a toggle/column is found) and never on the projection — the projection
 *    flattens plugin blocks to placeholder markup where the type is only an
 *    attribute, and matching THAT would also fire on hostile text content.
 *  - EMBEDDING: with a section on the bundle, the island carries it under its
 *    own `ledger` key — machine-readable and complete (schema + rows + settings
 *    + audit anchor parse back verbatim via `readLibraryIsland`) — and the main
 *    `space` bundle is NOT polluted with ledger pages/databases.
 *  - TOGGLE OFF / EXCLUDED: without a section, the export contains ZERO ledger
 *    records — no key in the island, no record text anywhere in the file.
 *    (Full restore of the payload is LX-4; here we pin that the payload is
 *    parseable and complete, i.e. importable-by-construction.)
 */

const blockSnapshot = (blocks: NewBlock[]): PageSnapshot =>
  ({editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: encodeSnapshot(createDoc(blocks))}) as never;

const storedPage = (id: string, data: PageSnapshot, over: Partial<StoredPage> = {}): StoredPage => ({
  id,
  name: id,
  data,
  hostedDatabaseId: null,
  databaseId: null,
  parentId: null,
  properties: {},
  deletedAt: null,
  createdAt: '',
  updatedAt: '',
  ...over,
});

const ledgerSnapshot = blockSnapshot([
  {type: 'heading', text: [{t: 'Books'}], props: {level: 1}},
  // Nested: detection must recurse into children, not just the top level.
  {type: 'group', children: [{type: 'openbook.ledger/trial-balance' as never, props: {ledgerTbShowZero: false}}]},
]);
const plainSnapshot = blockSnapshot([{type: 'paragraph', text: [{t: 'no books here'}]}]);

describe('snapshotHasLedgerBlocks (raw-snapshot detection)', () => {
  it('finds a ledger block, including nested inside children', () => {
    expect(snapshotHasLedgerBlocks(ledgerSnapshot)).toBe(true);
    expect(snapshotHasLedgerBlocks(blockSnapshot([{type: 'openbook.ledger/journal-entry' as never, props: {ledgerRows: ''}}]))).toBe(true);
  });

  it('is false for plain docs, legacy EditorJS snapshots, and absent snapshots', () => {
    expect(snapshotHasLedgerBlocks(plainSnapshot)).toBe(false);
    // Legacy EditorJS (no blockdoc): plugin blocks cannot exist there.
    expect(snapshotHasLedgerBlocks({editorjs: {blocks: [{id: 'a', type: 'paragraph', data: {text: 'openbook.ledger/journal-entry'}}]}, values: [], names: []} as never)).toBe(false);
    expect(snapshotHasLedgerBlocks(null)).toBe(false);
  });

  it('does not fire on ledger-looking TEXT content (type match only, never text)', () => {
    expect(snapshotHasLedgerBlocks(blockSnapshot([{type: 'paragraph', text: [{t: 'openbook.ledger/journal-entry'}]}]))).toBe(false);
  });

  it('bundleHasLedgerBlocks scans every page in the raw export set', () => {
    const space = {pages: [storedPage('a', plainSnapshot), storedPage('b', ledgerSnapshot)], databases: []};
    expect(bundleHasLedgerBlocks(space)).toBe(true);
    expect(bundleHasLedgerBlocks({pages: [storedPage('a', plainSnapshot)], databases: []})).toBe(false);
  });
});

// ── The embedded section ──────────────────────────────────────────────────────

/** A small but complete fixture section: 4 databases, hosts + rows, settings, anchor. */
function fixtureSection(): LedgerExportSection {
  const dbIds = {accounts: 'db-acc', transactions: 'db-tx', postings: 'db-po', reconciliations: 'db-rec'};
  const hostPages = {accounts: 'host-acc', transactions: 'host-tx', postings: 'host-po', reconciliations: 'host-rec'};
  const schema = {properties: [{id: 'p', name: 'Name', type: 'text'}], views: []} as never;
  const rowSnap = {editorjs: {blocks: []}, values: [], names: []} as never;
  return {
    settings: {
      ledgerDb: {hostPageId: 'host-root', ...dbIds, hostPages},
      ledgerPeriods: [{id: 'per-1', startDate: '2026-01-01', endDate: '2026-03-31', status: 'closed'}],
    },
    library: {
      pages: [
        storedPage('host-root', rowSnap),
        ...Object.values(hostPages).map((id) => storedPage(id, rowSnap, {parentId: 'host-root'})),
        storedPage('row-acc-1', rowSnap, {databaseId: dbIds.accounts, properties: {name: 'Assets:Cash'}}),
        storedPage('row-tx-1', rowSnap, {databaseId: dbIds.transactions, properties: {description: 'Owner investment', amountMinor: 5000000}}),
        storedPage('row-po-1', rowSnap, {databaseId: dbIds.postings}),
        storedPage('row-po-2', rowSnap, {databaseId: dbIds.postings}),
      ],
      databases: (Object.entries(dbIds) as Array<[keyof typeof dbIds, string]>).map(([k, id]) => ({
        id,
        pageId: hostPages[k],
        name: `Ledger ${k}`,
        schema,
        createdAt: '',
        updatedAt: '',
      })),
    },
    auditHead: {seq: 42, hash: 'f'.repeat(64)},
  };
}

function siteBundle(ledger?: LedgerExportSection): SiteBundle {
  return {
    rootId: 'root',
    pages: [{id: 'root', title: 'Root', icon: '', snapshot: ledgerSnapshot}],
    space: {pages: [storedPage('root', ledgerSnapshot)], databases: []},
    ...(ledger ? {ledger} : {}),
  };
}

describe('site export island — ledger section (LX-2)', () => {
  it('toggle ON: the island carries the complete, machine-readable section under its own key', () => {
    const section = fixtureSection();
    const html = toHtmlSite(siteBundle(section));
    const parsed = readLibraryIsland(html)!;
    expect(parsed).not.toBeNull();
    // Complete and verbatim: settings, all 4 schemas, hosts + every row, anchor.
    expect(parsed.ledger).toEqual(section);
    // Count parity inside the payload (what LX-4 will consume).
    const rows = (dbId: string) => parsed.ledger!.library.pages.filter((p) => p.databaseId === dbId);
    expect(rows('db-acc')).toHaveLength(1);
    expect(rows('db-tx')).toHaveLength(1);
    expect(rows('db-po')).toHaveLength(2);
    expect(parsed.ledger!.library.databases).toHaveLength(4);
    expect(parsed.ledger!.auditHead).toEqual({seq: 42, hash: 'f'.repeat(64)});
    // Namespaced: the ledger records do NOT leak into the main space bundle.
    expect(parsed.space.pages.map((p) => p.id)).toEqual(['root']);
    expect(parsed.space.databases).toHaveLength(0);
  });

  it('toggle OFF (or unreadable books): zero ledger records anywhere in the file', () => {
    const html = toHtmlSite(siteBundle());
    const parsed = readLibraryIsland(html)!;
    expect(parsed.ledger).toBeUndefined();
    // Not merely "no island key": no record content leaks anywhere in the file.
    expect(html).not.toContain('Owner investment');
    expect(html).not.toContain('db-acc');
  });

  it('the section survives hostile content in the books (island escaping)', () => {
    const section = fixtureSection();
    const evil = 'Pwn </script><script>alert(1)</script>';
    section.library.pages.push(storedPage('row-tx-evil', {editorjs: {blocks: []}, values: [], names: []} as never, {databaseId: 'db-tx', properties: {description: evil}}));
    const html = toHtmlSite(siteBundle(section));
    const parsed = readLibraryIsland(html)!;
    const evilRow = parsed.ledger!.library.pages.find((p) => p.id === 'row-tx-evil')!;
    expect(evilRow.properties.description).toBe(evil); // lossless round-trip
  });
});
