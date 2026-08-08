import {describe, it, expect} from 'vitest';
import type {DataClient, LedgerExportSection, PageSnapshot, StoredPage} from '@book.dev/sdk';
import {readLibraryIsland} from '@book.dev/sdk';
import {createDoc, encodeSnapshot, type NewBlock} from '../../blockeditor/model';
import {toHtmlSite} from '../toHtml';
import {bundleHasLedgerBlocks, gatherSite, snapshotHasLedgerBlocks, type SiteBundle} from '../exportSite';

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

// ── The crawl: ledger content behind a reference (Sasha #2, consent bypass) ──

/** A root doc whose `@`-mentions reach a ledger child host page and a plain page. */
const crawlRootSnapshot = blockSnapshot([
  {type: 'paragraph', text: [{t: 'Accounts', a: {m: 'host-acc'}}, {t: ' and '}, {t: 'notes', a: {m: 'plain'}}]},
]);

/**
 * A stub world where the ledger is seeded and READABLE by the caller: the
 * crawl can reach the accounts child host page (and would, unpruned, pull the
 * managed database's schema + rows into the visible bundle and the island).
 */
/** A record marker that can never collide with the bundled ledger plugin's own
 *  source (which toHtmlSite embeds verbatim and mentions common account names). */
const SECRET_ROW = 'Assets:Vault:LX2-SECRET-9314';

function crawlClient(overrides: Partial<Record<keyof DataClient, unknown>> = {}): DataClient {
  const dbIds = {accounts: 'db-acc', transactions: 'db-tx', postings: 'db-po', reconciliations: 'db-rec'};
  const pagesById: Record<string, StoredPage> = {
    root: storedPage('root', crawlRootSnapshot),
    plain: storedPage('plain', plainSnapshot),
    'ledger-root': storedPage('ledger-root', plainSnapshot),
    'host-acc': storedPage('host-acc', plainSnapshot, {parentId: 'ledger-root', hostedDatabaseId: dbIds.accounts}),
    'row-acc-lx2': storedPage('row-acc-lx2', plainSnapshot, {databaseId: dbIds.accounts, properties: {name: SECRET_ROW}}),
  };
  const base = {
    ledgerInfo: async () => ({exists: true, hostPageId: 'ledger-root', databases: dbIds}),
    getPage: async (id: string) => pagesById[id] ?? null,
    getDatabase: async (id: string) =>
      id === dbIds.accounts
        ? {id, pageId: 'host-acc', name: 'Ledger accounts', schema: {properties: [{id: 'name', name: 'Account', type: 'text'}], views: []}, createdAt: '', updatedAt: ''}
        : null,
    listRows: async (dbId: string) =>
      dbId === dbIds.accounts
        ? [{id: 'row-acc-lx2', name: SECRET_ROW, properties: {name: SECRET_ROW}, exports: {}, parentId: null, createdAt: '', updatedAt: ''}]
        : [],
  };
  return {...base, ...overrides} as unknown as DataClient;
}

describe('gatherSite — crawled ledger content is pruned and consent-flagged (Sasha #2)', () => {
  it('a crawl reaching a ledger host page prunes the books from bundle AND island, and flags consent', async () => {
    const bundle = await gatherSite(crawlClient(), 'root', {snapshot: crawlRootSnapshot, title: 'Root', icon: ''});
    // The reference was reached → the export flow must run the consent dialog.
    expect(bundle.ledgerReached).toBe(true);
    // The visible bundle carries only non-ledger pages, and no database rows.
    expect(bundle.pages.map((p) => p.id).sort()).toEqual(['plain', 'root']);
    expect(bundle.pages.every((p) => p.database === undefined)).toBe(true);
    // The lossless island bundle is equally clean.
    expect(bundle.space.pages.map((p) => p.id).sort()).toEqual(['plain', 'root']);
    expect(bundle.space.databases).toHaveLength(0);
  });

  it('toggle off (no section): ZERO ledger records anywhere in the exported file', async () => {
    const bundle = await gatherSite(crawlClient(), 'root', {snapshot: crawlRootSnapshot, title: 'Root', icon: ''});
    const html = toHtmlSite(bundle); // no bundle.ledger — the user opted out
    expect(readLibraryIsland(html)!.ledger).toBeUndefined();
    expect(html).not.toContain(SECRET_ROW);
    expect(html).not.toContain('row-acc-lx2');
    expect(html).not.toContain('Ledger accounts');
  });

  it('guest (existence-hiding ledgerInfo + 404s on restricted pages): zero records, no dialog needed', async () => {
    const client = crawlClient({
      ledgerInfo: async () => ({exists: false, hostPageId: null, databases: null}),
      getPage: async (id: string) =>
        id === 'root'
          ? storedPage('root', crawlRootSnapshot)
          : id === 'plain'
            ? storedPage('plain', plainSnapshot)
            : null, // the restricted ledger pages 404 for a guest
    });
    const bundle = await gatherSite(client, 'root', {snapshot: crawlRootSnapshot, title: 'Root', icon: ''});
    expect(bundle.ledgerReached).toBeUndefined();
    const html = toHtmlSite(bundle);
    expect(html).not.toContain(SECRET_ROW);
    expect(html).not.toContain('row-acc-lx2');
  });

  it('exporting a ledger page directly: the root stays but its managed database (rows) is pruned', async () => {
    const bundle = await gatherSite(crawlClient(), 'host-acc', {snapshot: plainSnapshot, title: 'Accounts', icon: ''});
    expect(bundle.ledgerReached).toBe(true);
    expect(bundle.pages.map((p) => p.id)).toEqual(['host-acc']);
    expect(bundle.pages[0].database).toBeUndefined();
    expect(bundle.space.databases).toHaveLength(0);
    const html = toHtmlSite(bundle);
    expect(html).not.toContain(SECRET_ROW);
    expect(html).not.toContain('row-acc-lx2');
  });
});

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

  it('crawled ledger content: opted-in records ship EXACTLY once (the section), never via the crawl copy', async () => {
    const bundle = await gatherSite(crawlClient(), 'root', {snapshot: crawlRootSnapshot, title: 'Root', icon: ''});
    bundle.ledger = fixtureSection();
    const html = toHtmlSite(bundle);
    const parsed = readLibraryIsland(html)!;
    // The section carries the records; the generic bundle stays clean.
    expect(parsed.ledger).toEqual(fixtureSection());
    expect(parsed.space.pages.map((p) => p.id).sort()).toEqual(['plain', 'root']);
    expect(parsed.space.databases).toHaveLength(0);
    // A unique record marker appears exactly once in the whole file — the
    // consent-gated section is the single sanctioned carrier (no duplication).
    expect(html.split('Owner investment')).toHaveLength(2);
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
