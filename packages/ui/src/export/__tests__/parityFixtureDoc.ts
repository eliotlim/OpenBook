/**
 * The shared **parity fixture**: one block-doc exercising every exported block
 * behavior (text, headings, the slider→live-code→chart reactive chain, a
 * formula, status light, progress bar, tabs, accordion, image, table, group,
 * to-do, hostile text). Used by:
 *  - `exportViewer.test.ts` (runtime-selection + determinism assertions), and
 *  - `exportParityFixtures.test.ts` (writes the exported HTML the Playwright
 *    parity harness opens from file:// — packages/web/e2e-viewer).
 *
 * The Playwright suite asserts the exported file, hydrated by the vendored
 * viewer, behaves like the in-app locked page — so these blocks deliberately
 * mirror the app's known-good reactive shapes (see sdk sampleDocument).
 */
import type {LedgerExportSection, LibrarySnapshot, PageSnapshot, StoredPage} from '@book.dev/sdk';
import {LEDGER_PROP, STARTUP_BOOKS_CHART, startupBooksTransactions} from '@book.dev/sdk';
import {createDoc, decodeSnapshot, encodeSnapshot, type NewBlock} from '../../blockeditor/model';
import {projectSnapshotForExport} from '../../blockeditor/exportBlocks';
import {computeExportCells} from '../../blockeditor/kit/scope';
import {emptyExportAssets, type ExportAssets} from '../exportAssets';
import type {SiteBundle} from '../exportSite';

/** An 8×8 grey PNG — a real decodable image with zero network. */
export const PARITY_IMAGE_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAD0lEQVR4nGM4gwMwDC0JAMg9mQEkEhIxAAAAAElFTkSuQmCC';

/** The content-addressed id the artifact block references. */
export const PARITY_ARTIFACT_ID = 'sha256-parity-artifact';

/**
 * The artifact's HTML document — a self-contained interactive widget: a button
 * that increments a counter (proves the sandboxed frame runs its own JS live),
 * plus a `parent.document` reach that must throw under the opaque origin
 * (proves the sandbox walls the frame off from the host). Inline style/script
 * only, so it works under the export's network-off CSP.
 *
 * Note it carries adversarial *marker* content — quotes, emoji, a literal
 * `</iframe>` in visible text — to prove it survives the island + srcdoc
 * escaping when hydrated. It deliberately does NOT put a literal `</script>`
 * inside the inline script: the HTML parser (in ANY browser, unrelated to our
 * pipeline) would close the script element early — that class of payload is
 * covered at the byte layer by exportArtifact.test.ts instead.
 */
export const PARITY_ARTIFACT_DOC = [
  '<!doctype html><meta charset="utf-8"><title>"Counter" & \'demo\' 🎉</title>',
  '<style>body{font:14px system-ui;margin:12px}button{font-size:16px}</style>',
  '<p>Marker: &lt;/iframe&gt; "quoted" 🎉</p>',
  '<button id="b">count: <span id="n">0</span></button>',
  '<p id="leak">host: checking…</p>',
  '<scr' + 'ipt>',
  'var n=0;document.getElementById("b").addEventListener("click",function(){',
  '  n++;document.getElementById("n").textContent=String(n);});',
  '// Breakout attempt — must fail under the opaque origin:',
  'try{document.getElementById("leak").textContent="host:"+parent.document.title;}',
  'catch(e){document.getElementById("leak").textContent="host: blocked";}',
  '</scr' + 'ipt>',
].join('\n');

const GROWTH_SOURCE =
  'return {low: Array.from({length: months}, (_, i) => Math.pow(1.03, i / 12)), high: Array.from({length: months}, (_, i) => Math.pow(1.10, i / 12))};';

/** Hostile content: must render as inert TEXT and never break the island. */
export const HOSTILE_TEXT = 'Hostile: </script><script>alert(1)</script> <!-- open comment';

export const PARITY_BLOCKS: NewBlock[] = [
  {id: 'fx-h1', type: 'heading', props: {level: 1}, text: [{t: 'Parity fixture'}]},
  {id: 'fx-p1', type: 'paragraph', text: [
    {t: 'Interactive export. Drag '},
    {t: 'months', a: {b: true}},
    {t: ' to redraw the chart.'},
  ]},
  {id: 'fx-hostile', type: 'paragraph', text: [{t: HOSTILE_TEXT}]},
  {id: 'fx-slider', type: 'slider', props: {name: 'months', label: 'Months', value: 120, min: 1, max: 360, step: 1}},
  {id: 'fx-growth', type: 'code', props: {live: true, name: 'growth', language: 'js', collapsed: true}, text: [{t: GROWTH_SOURCE}]},
  {id: 'fx-formula', type: 'formula', props: {source: 'months * 2', name: 'doubled'}},
  {id: 'fx-chart', type: 'kitchart', props: {kind: 'line', title: 'Growth of £1', source: 'growth'}},
  // Untitled + description-less: the hydrated viewer must NOT render ghost
  // "Chart title" / "Add a description…" placeholders on the locked page.
  {id: 'fx-chart2', type: 'kitchart', props: {kind: 'bar', source: '[months, doubled]'}},
  {id: 'fx-light', type: 'statuslight', props: {label: 'Health', source: 'months <= 120', okAt: 1, warnAt: 0}},
  {id: 'fx-progress', type: 'progressbar', props: {label: 'Used', source: 'months / 360', max: 1, format: 'percent'}},
  {id: 'fx-image', type: 'image', props: {src: PARITY_IMAGE_DATA_URI, alt: 'grey square'}},
  {id: 'fx-table', type: 'table', children: [
    {id: 'fx-tr1', type: 'row', children: [
      {id: 'fx-c11', type: 'cell', text: [{t: 'Name'}]},
      {id: 'fx-c12', type: 'cell', text: [{t: 'Age'}]},
    ]},
    {id: 'fx-tr2', type: 'row', children: [
      {id: 'fx-c21', type: 'cell', text: [{t: 'Ada'}]},
      {id: 'fx-c22', type: 'cell', text: [{t: '36'}]},
    ]},
  ]},
  {id: 'fx-todo', type: 'todo', props: {checked: true}, text: [{t: 'ship the viewer'}]},
  {id: 'fx-acc', type: 'accordion', children: [
    {id: 'fx-as1', type: 'accordionsection', props: {label: 'Details A'}, children: [
      {id: 'fx-ap1', type: 'paragraph', text: [{t: 'Accordion body A'}]},
    ]},
    {id: 'fx-as2', type: 'accordionsection', props: {label: 'Details B'}, children: [
      {id: 'fx-ap2', type: 'paragraph', text: [{t: 'Accordion body B'}]},
    ]},
  ]},
  {id: 'fx-group', type: 'group', props: {name: 'Config'}, children: [
    {id: 'fx-toggle', type: 'toggle', props: {name: 'enabled', label: 'Enabled', value: true}},
    {id: 'fx-gp', type: 'paragraph', text: [{t: 'Group body text'}]},
  ]},
  {id: 'fx-tabs', type: 'tabs', props: {active: 0}, children: [
    {id: 'fx-t1', type: 'tab', props: {label: 'First'}, children: [
      {id: 'fx-tp1', type: 'paragraph', text: [{t: 'first tab body'}]},
    ]},
    {id: 'fx-t2', type: 'tab', props: {label: 'Second'}, children: [
      {id: 'fx-tp2', type: 'paragraph', text: [{t: 'second tab body'}]},
    ]},
  ]},
  {id: 'fx-artifact', type: 'htmlArtifact', props: {assetId: PARITY_ARTIFACT_ID, title: 'Counter widget'}},
];

/**
 * **Plugin-block fixture (LX-1).** Every block type the bundled Ledger plugin
 * contributes, in one page, plus two forward-compatibility unknowns (a
 * props-only type from a hypothetical newer version, and a text-carrying one).
 *
 * None of these renderers exist in an export (or in an app without the plugin
 * installed), so this fixture is the guard for the *placeholder* contract:
 * every one of them must survive the export projection with its `type` +
 * `props` intact and render as a visibly labelled block — never the empty
 * `<p></p>` the old flatten produced.
 */
export const LEDGER_BLOCK_TYPES = [
  'openbook.ledger/journal-entry',
  'openbook.ledger/trial-balance',
  'openbook.ledger/account-register',
  'openbook.ledger/bank-import',
  'openbook.ledger/reconcile',
  'openbook.ledger/balance-sheet',
  'openbook.ledger/income-statement',
  'openbook.ledger/period-close',
  'openbook.ledger/beancount-export',
] as const;

/** The seed props each Ledger block is created with (see examples/plugins/ledger). */
const LEDGER_BLOCK_PROPS: Record<string, Record<string, unknown>> = {
  'openbook.ledger/journal-entry': {ledgerRows: '2026-08-01 Rent | Expenses:Rent 1200 | Assets:Bank -1200'},
  'openbook.ledger/trial-balance': {ledgerTbShowZero: false},
  'openbook.ledger/account-register': {ledgerRegAccount: 'Assets:Bank'},
  'openbook.ledger/bank-import': {ledgerImport: '1'},
  'openbook.ledger/reconcile': {ledgerRecId: 'rec-2026-08'},
  'openbook.ledger/balance-sheet': {ledgerBsAsOf: '2026-08-31'},
  'openbook.ledger/income-statement': {ledgerIsFrom: '2026-08-01', ledgerIsTo: '2026-08-31'},
  'openbook.ledger/period-close': {ledgerPeriodStart: '2026-08-01'},
  'openbook.ledger/beancount-export': {ledgerBeancount: '1'},
};

export const PARITY_PLUGIN_BLOCKS: NewBlock[] = [
  {id: 'lx-h1', type: 'heading', props: {level: 1}, text: [{t: 'Ledger plugin blocks'}]},
  {id: 'lx-p1', type: 'paragraph', text: [{t: 'Each block below needs a plugin this export cannot run.'}]},
  ...LEDGER_BLOCK_TYPES.map((type) => ({
    id: `lx-${type.slice(type.indexOf('/') + 1)}`,
    type,
    props: LEDGER_BLOCK_PROPS[type],
  })),
  // Forward compatibility: a type from a plugin nothing knows about, and a type
  // with no `{pluginId}/` shape at all (the plain unsupported-block path). Note
  // neither can carry text — `makeBlock` only creates a Y.Text for core
  // TEXT_BLOCKS — so text-carrying unknowns are covered against a hand-built
  // projection instead (see exportPluginBlocks.test.tsx).
  {id: 'lx-future', type: 'org.example.future/widget', props: {shape: 'hexagon'}},
  {id: 'lx-nameless', type: 'not-a-plugin-type', props: {any: 'thing'}},
];

// ── Ledger REPORTS fixture (LX-3 tables → LX-5 hydration) ────────────────────

/**
 * **Ledger reports fixture.** One page carrying all five REPORT blocks plus the
 * four interactive tools, over the SDK's own Startup Books book — the same chart
 * and entries `STARTUP_BOOKS_CHART` / `startupBooksTransactions` seed, rebuilt
 * as the stored rows an LX-2 export embeds.
 *
 * Records ON, this page exports as real tables of real numbers (LX-3). It is
 * therefore the fixture for the LX-5 contract: those tables must SURVIVE
 * hydration, while the four interactive tools and (records OFF) the report
 * blocks keep their honest, ledger-specific placeholder cards.
 */
const LEDGER_ACCOUNT_ID = new Map(STARTUP_BOOKS_CHART.map((a, i) => [a.name, `lgacc-${i}`]));
const LEDGER_DRAFTS = startupBooksTransactions(LEDGER_ACCOUNT_ID);
const LEDGER_DB = {accounts: 'lgdb-acc', transactions: 'lgdb-tx', postings: 'lgdb-po', reconciliations: 'lgdb-rec'};
const LEDGER_HOSTS = {accounts: 'lghost-acc', transactions: 'lghost-tx', postings: 'lghost-po', reconciliations: 'lghost-rec'};

export const PARITY_LEDGER_BLOCKS: NewBlock[] = [
  // NOT the page name ("Startup books"): the viewer renders the page title
  // itself, so a matching H1 read as a duplicate-title bug in the LX-5 design
  // captures (Devon F5).
  {id: 'lg-h1', type: 'heading', props: {level: 1}, text: [{t: 'Reports'}]},
  {id: 'lg-p1', type: 'paragraph', text: [{t: 'Reports computed by the exporter — they must survive hydration.'}]},
  {id: 'lg-journal', type: 'openbook.ledger/journal-entry' as never, props: {ledgerRows: '', ledgerDraftId: 'lgtx-0'}},
  {id: 'lg-tb', type: 'openbook.ledger/trial-balance' as never, props: {ledgerTbShowZero: false}},
  {id: 'lg-bs', type: 'openbook.ledger/balance-sheet' as never, props: {ledgerBsAsOf: ''}},
  {id: 'lg-is', type: 'openbook.ledger/income-statement' as never, props: {ledgerIsFrom: '', ledgerIsTo: ''}},
  {id: 'lg-reg', type: 'openbook.ledger/account-register' as never, props: {ledgerRegAccount: LEDGER_ACCOUNT_ID.get('Assets:Bank:Checking')}},
  {id: 'lg-h2', type: 'heading', props: {level: 2}, text: [{t: 'Operations'}]},
  {id: 'lg-import', type: 'openbook.ledger/bank-import' as never, props: {ledgerImport: '1'}},
  {id: 'lg-rec', type: 'openbook.ledger/reconcile' as never, props: {ledgerRecId: ''}},
  {id: 'lg-close', type: 'openbook.ledger/period-close' as never, props: {ledgerPeriodStart: ''}},
  {id: 'lg-bean', type: 'openbook.ledger/beancount-export' as never, props: {ledgerBeancount: '1'}},
  // Scoping guard: a block from a plugin nobody has. The hydrated viewer's own
  // install card is the better render here, so LX-5 must NOT preserve this one.
  {id: 'lg-future', type: 'org.example.future/widget', props: {shape: 'hexagon'}},
];

/** A ledger row in the stored shape (a database row page carrying properties). */
const ledgerRow = (id: string, databaseId: string, name: string, properties: Record<string, unknown>): StoredPage =>
  ({
    id, name, databaseId, properties,
    data: {editorjs: {blocks: []}, values: [], names: []} as never,
    hostedDatabaseId: null, parentId: null, deletedAt: null,
    createdAt: '2026-07-04T00:00:00.000Z', updatedAt: '2026-07-04T00:00:00.000Z',
  });

/** The embedded records section (LX-2) for the Startup Books book. */
export function parityLedgerSection(): LedgerExportSection {
  const pages: StoredPage[] = Object.values(LEDGER_HOSTS).map((id) => ledgerRow(id, '', id, {}));
  for (const [name, id] of LEDGER_ACCOUNT_ID) {
    const type = STARTUP_BOOKS_CHART.find((a) => a.name === name)!.type;
    pages.push(ledgerRow(id, LEDGER_DB.accounts, name, {
      [LEDGER_PROP.account.type]: type,
      [LEDGER_PROP.account.status]: 'open',
      [LEDGER_PROP.account.currency]: 'USD',
    }));
  }
  LEDGER_DRAFTS.forEach((tx, i) => {
    const txId = `lgtx-${i}`;
    pages.push(ledgerRow(txId, LEDGER_DB.transactions, tx.description ?? '', {
      [LEDGER_PROP.transaction.date]: String(tx.date),
      [LEDGER_PROP.transaction.description]: tx.description ?? '',
      [LEDGER_PROP.transaction.state]: 'posted',
      [LEDGER_PROP.transaction.entryNo]: i + 1,
    }));
    (tx.postings ?? []).forEach((p, j) => {
      pages.push(ledgerRow(`lgpo-${i}-${j}`, LEDGER_DB.postings, '', {
        [LEDGER_PROP.posting.transaction]: txId,
        [LEDGER_PROP.posting.account]: p.accountId,
        [LEDGER_PROP.posting.amount]: p.amountMinor,
        [LEDGER_PROP.posting.cleared]: 'pending',
      }));
    });
  });
  return {
    settings: {ledgerDb: {hostPageId: LEDGER_HOSTS.accounts, ...LEDGER_DB, hostPages: LEDGER_HOSTS}},
    library: {
      pages,
      databases: (Object.entries(LEDGER_DB) as Array<[keyof typeof LEDGER_DB, string]>).map(([k, id]) => ({
        id, pageId: LEDGER_HOSTS[k], name: `Ledger ${k}`,
        schema: {properties: [], views: []} as never,
        createdAt: '', updatedAt: '',
      })),
    },
    auditHead: null,
  };
}

/** The ledger page as a single-page site bundle — `withRecords` decides whether
 *  the books ride along (records on ⇒ real tables; off ⇒ the LX-3 cards). The
 *  bundle stays database-free so it takes the VIEWER (hydrate) runtime. */
export function parityLedgerSiteBundle(withRecords: boolean): SiteBundle {
  const raw = parityRawSnapshot(PARITY_LEDGER_BLOCKS);
  const space: LibrarySnapshot = {
    pages: [{
      id: 'lg-root', name: 'Startup books', data: raw, hostedDatabaseId: null, databaseId: null,
      parentId: null, properties: {}, deletedAt: null,
      createdAt: '2026-07-04T00:00:00.000Z', updatedAt: '2026-07-04T00:00:00.000Z',
    }],
    databases: [],
  };
  return {
    rootId: 'lg-root',
    pages: [{id: 'lg-root', title: 'Startup books', icon: '📒', snapshot: projectSnapshotForExport(raw)}],
    space,
    ...(withRecords ? {ledger: parityLedgerSection()} : {}),
  };
}

/** The export assets bundle the fixture needs: the artifact document text
 *  keyed by its assetId (no async store — the parity generator is synchronous).
 *  The image rides its inline data-URI, so nothing goes in the image map. */
export function parityExportAssets(): ExportAssets {
  const assets = emptyExportAssets();
  assets.artifactText.set(PARITY_ARTIFACT_ID, PARITY_ARTIFACT_DOC);
  return assets;
}

/** A raw block-doc snapshot (what the store holds / the island carries). */
export function parityRawSnapshot(blocks: NewBlock[] = PARITY_BLOCKS): PageSnapshot {
  return {
    editorjs: {blocks: []},
    values: [],
    names: [],
    editor: 'blocks',
    blockdoc: encodeSnapshot(createDoc(blocks)),
  } as never;
}

/** The projected snapshot the app's export action passes to toHtml (the
 *  projection KEEPS the blockdoc, so the island stays lossless). */
export async function parityExportSnapshot(blocks: NewBlock[] = PARITY_BLOCKS): Promise<PageSnapshot> {
  const raw = parityRawSnapshot(blocks);
  const doc = decodeSnapshot(raw.blockdoc as never);
  return projectSnapshotForExport(raw, undefined, await computeExportCells(doc));
}

const SECOND_PAGE: NewBlock[] = [
  {id: 'p2-p', type: 'paragraph', text: [{t: 'Content of the second page.'}]},
];

/** A two-page, database-free site bundle (mirrors gatherSite's output shape:
 *  projected snapshots in `pages`, raw records in `space`). */
export async function paritySiteBundle(): Promise<SiteBundle> {
  const rootRaw = parityRawSnapshot();
  const secondRaw = parityRawSnapshot(SECOND_PAGE);
  const record = (id: string, name: string, data: PageSnapshot, parentId: string | null) => ({
    id, name, data, hostedDatabaseId: null, databaseId: null, parentId,
    properties: {}, deletedAt: null, createdAt: '2026-07-04T00:00:00.000Z', updatedAt: '2026-07-04T00:00:00.000Z',
  });
  const space: LibrarySnapshot = {
    pages: [record('fx-root', 'Parity fixture', rootRaw, null), record('fx-two', 'Second page', secondRaw, 'fx-root')],
    databases: [],
  };
  return {
    rootId: 'fx-root',
    pages: [
      {id: 'fx-root', title: 'Parity fixture', icon: '🧪', snapshot: await parityExportSnapshot()},
      {id: 'fx-two', title: 'Second page', icon: '', snapshot: await parityExportSnapshot(SECOND_PAGE)},
    ],
    space,
  };
}
