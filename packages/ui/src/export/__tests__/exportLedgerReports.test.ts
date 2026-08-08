import {describe, it, expect} from 'vitest';
// The mirrored fold sources + the renderer, byte-for-byte (vite `?raw`) — the
// purity assertion below reads what actually compiles into the export bundle.
const foldSources = import.meta.glob('../ledgerFolds.gen/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const rendererSources = import.meta.glob('../exportLedgerReports.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
import {
  LEDGER_PROP,
  STARTUP_BOOKS_CHART,
  formatAmount,
  startupBooksTransactions,
  type LedgerExportSection,
  type PageSnapshot,
  type StoredPage,
} from '@book.dev/sdk';
import {createDoc, encodeSnapshot, type NewBlock} from '../../blockeditor/model';
import {projectSnapshotForExport} from '../../blockeditor/exportBlocks';
import {toHtmlSite} from '../toHtml';
import type {SiteBundle} from '../exportSite';
import {describeLedgerInteractiveBlock, ledgerExportRecords} from '../exportLedgerReports';
import {
  buildAccountRegister,
  buildTrialBalance,
  describeRegisterSummary,
  describeTrialBalanceAssertion,
  formatWithSide,
  type ReportAccount,
  type ReportTransaction,
} from '../ledgerFolds.gen/reports';
import {buildBalanceSheet, buildIncomeStatement, describeNetIncome} from '../ledgerFolds.gen/statements';

/**
 * LX-3 — static ledger report tables in exported HTML.
 *
 * What a passing suite means:
 *  - GOLDEN: exporting the SDK's own Startup Books fixture (same chart, same
 *    entries — `STARTUP_BOOKS_CHART` / `startupBooksTransactions`) with the
 *    records ON renders TB/BS/IS/register/journal tables whose numbers equal
 *    the in-app fold output over the same data. Expected values are computed
 *    from typed records built DIRECTLY from the template constants — never
 *    through the adapter under test — so the adapter + renderer are pinned
 *    end-to-end against the fold ground truth.
 *  - PROPS: the block's persisted props steer the export exactly as they steer
 *    the in-app block — as-of date (`ledgerBsAsOf`), period (`ledgerIsFrom/To`),
 *    account filter (`ledgerRegAccount`), show-zero (`ledgerTbShowZero`),
 *    flat-vs-rolled (`ledgerBsRolled`), journal link (`ledgerDraftId`).
 *  - RECORDS OFF: without a ledger section every ledger block keeps the LX-1
 *    labelled placeholder — no table, no numbers.
 *  - INTERACTIVE: bank-import / reconcile / period-close / beancount-export
 *    are placeholders ALWAYS, labelled as interactive tools.
 *  - PURITY: the fold mirror the renderer compiles in imports no React and no
 *    plugin runtime — the export bundle gains pure arithmetic only.
 */

// ── The Startup Books fixture, twice over ────────────────────────────────────
// Once as the EMBEDDED SECTION (LibrarySnapshot rows keyed by LEDGER_PROP —
// what LX-2 puts in the island), and once as TYPED RECORDS (what the server's
// typed reads would serve) for computing expected fold output independently.

const accountId = new Map(STARTUP_BOOKS_CHART.map((a, i) => [a.name, `acc-${i}`]));
const drafts = startupBooksTransactions(accountId);
const dates = drafts.map((d) => String(d.date));

const expectedAccounts: ReportAccount[] = STARTUP_BOOKS_CHART.map((a, i) => ({
  id: `acc-${i}`,
  name: a.name,
  type: a.type,
}));

const expectedTxs: ReportTransaction[] = drafts.map((t, i) => ({
  id: `tx-${i}`,
  date: String(t.date),
  description: t.description ?? '',
  state: 'posted',
  entryNo: i + 1,
  postings: (t.postings ?? []).map((p, j) => ({
    id: `po-${i}-${j}`,
    accountId: p.accountId,
    amountMinor: p.amountMinor,
    cleared: 'pending',
  })),
}));

const CHECKING = accountId.get('Assets:Bank:Checking')!;

const DB_IDS = {accounts: 'db-acc', transactions: 'db-tx', postings: 'db-po', reconciliations: 'db-rec'};
const HOST_PAGES = {accounts: 'host-acc', transactions: 'host-tx', postings: 'host-po', reconciliations: 'host-rec'};

const storedPage = (id: string, over: Partial<StoredPage> = {}): StoredPage => ({
  id,
  name: id,
  data: {editorjs: {blocks: []}, values: [], names: []} as never,
  hostedDatabaseId: null,
  databaseId: null,
  parentId: null,
  properties: {},
  deletedAt: null,
  createdAt: '',
  updatedAt: '',
  ...over,
});

/** The LX-2 section for the fixture book: rows in the stored LEDGER_PROP shape. */
function fixtureSection(): LedgerExportSection {
  const pages: StoredPage[] = [storedPage('host-root'), ...Object.values(HOST_PAGES).map((id) => storedPage(id))];
  for (const a of expectedAccounts) {
    pages.push(storedPage(a.id, {name: a.name, databaseId: DB_IDS.accounts, properties: {
      [LEDGER_PROP.account.type]: a.type,
      [LEDGER_PROP.account.status]: 'open',
      [LEDGER_PROP.account.currency]: 'USD',
    }}));
  }
  for (const tx of expectedTxs) {
    pages.push(storedPage(tx.id, {name: tx.description, databaseId: DB_IDS.transactions, properties: {
      [LEDGER_PROP.transaction.date]: tx.date,
      [LEDGER_PROP.transaction.description]: tx.description,
      [LEDGER_PROP.transaction.state]: tx.state,
      [LEDGER_PROP.transaction.entryNo]: tx.entryNo,
    }}));
    for (const p of tx.postings) {
      pages.push(storedPage(p.id, {databaseId: DB_IDS.postings, properties: {
        [LEDGER_PROP.posting.transaction]: tx.id,
        [LEDGER_PROP.posting.account]: p.accountId,
        [LEDGER_PROP.posting.amount]: p.amountMinor,
        [LEDGER_PROP.posting.cleared]: p.cleared,
      }}));
    }
  }
  return {
    settings: {ledgerDb: {hostPageId: 'host-root', ...DB_IDS, hostPages: HOST_PAGES}},
    library: {
      pages,
      databases: (Object.entries(DB_IDS) as Array<[keyof typeof DB_IDS, string]>).map(([k, id]) => ({
        id,
        pageId: HOST_PAGES[k],
        name: `Ledger ${k}`,
        schema: {properties: [], views: []} as never,
        createdAt: '',
        updatedAt: '',
      })),
    },
    auditHead: null,
  };
}

// ── The exported document: every ledger block, props configured ─────────────

const DOC_BLOCKS: NewBlock[] = [
  {type: 'heading', text: [{t: 'Startup books'}], props: {level: 1}},
  {type: 'openbook.ledger/journal-entry' as never, props: {ledgerRows: '', ledgerDraftId: 'tx-0'}},
  // A journal block that never posted anything: no table to draw.
  {type: 'openbook.ledger/journal-entry' as never, props: {ledgerRows: ''}},
  {type: 'openbook.ledger/trial-balance' as never, props: {ledgerTbShowZero: false}},
  {type: 'openbook.ledger/trial-balance' as never, props: {ledgerTbShowZero: true}},
  // As-of pinned to the third entry's date — the fold must EXCLUDE later ones.
  {type: 'openbook.ledger/balance-sheet' as never, props: {ledgerBsAsOf: dates[2], ledgerBsRolled: false}},
  // Period pinned to [customer payment .. software license].
  {type: 'openbook.ledger/income-statement' as never, props: {ledgerIsFrom: dates[4], ledgerIsTo: dates[6]}},
  {type: 'openbook.ledger/account-register' as never, props: {ledgerRegAccount: CHECKING}},
  {type: 'openbook.ledger/account-register' as never, props: {ledgerRegAccount: ''}},
  {type: 'openbook.ledger/bank-import' as never, props: {ledgerImport: '1'}},
  {type: 'openbook.ledger/reconcile' as never, props: {ledgerRecId: ''}},
  {type: 'openbook.ledger/period-close' as never, props: {ledgerPeriodStart: ''}},
  {type: 'openbook.ledger/beancount-export' as never, props: {ledgerBeancount: '1'}},
];

const snapshot = (): PageSnapshot =>
  ({editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: encodeSnapshot(createDoc(DOC_BLOCKS))}) as never;

function bundle(withRecords: boolean): SiteBundle {
  const snap = snapshot();
  return {
    rootId: 'root',
    // The crawl (gatherSite) hands toHtmlSite PROJECTED snapshots; the raw
    // block-doc rides only in `space` (the island). Mirror that here.
    pages: [{id: 'root', title: 'Startup books', icon: '', snapshot: projectSnapshotForExport(snap)}],
    space: {pages: [storedPage('root', {data: snap})], databases: []},
    ...(withRecords ? {ledger: fixtureSection()} : {}),
  };
}

/** The nth `<figure class="ob-ledger-report">` for a block type (figures never nest). */
function figures(html: string, type: string): string[] {
  const re = new RegExp(`<figure class="ob-ledger-report" data-block-type="${type.replace('/', '\\/')}">.*?</figure>`, 'gs');
  return html.match(re) ?? [];
}

function placeholders(html: string, type: string): string[] {
  const re = new RegExp(`<div class="ob-plugin-block" data-block-type="${type.replace('/', '\\/')}">.*?</div>`, 'gs');
  return html.match(re) ?? [];
}

const T = (name: string): string => `openbook.ledger/${name}`;

describe('LX-3 — golden: Startup Books export renders fold-exact report tables', () => {
  const html = toHtmlSite(bundle(true));

  it('trial balance: every balance, the totals and the balanced assertion match the fold', () => {
    const tb = buildTrialBalance(expectedAccounts, expectedTxs, {includeZero: false});
    const [fig, figZero] = figures(html, T('trial-balance'));
    expect(fig).toBeTruthy();
    for (const row of tb.rows) {
      expect(fig).toContain(row.name);
      expect(fig).toContain(formatAmount(row.debitMinor > 0 ? row.debitMinor : row.creditMinor));
    }
    expect(fig).toContain(formatAmount(tb.totalDebitMinor));
    expect(fig).toContain(formatAmount(tb.totalCreditMinor));
    expect(tb.balanced).toBe(true);
    expect(fig).toContain(describeTrialBalanceAssertion(tb).text.replace(/—/g, '—'));
    // Show-zero prop honoured: the postings-free Savings account only appears
    // on the block whose ledgerTbShowZero is true.
    expect(fig).not.toContain('Assets:Bank:Savings');
    expect(figZero).toContain('Assets:Bank:Savings');
  });

  it('balance sheet: honours the as-of prop (later entries excluded) and the flat shape', () => {
    const sheet = buildBalanceSheet(expectedAccounts, expectedTxs, {asOf: dates[2]});
    const [fig] = figures(html, T('balance-sheet'));
    expect(fig).toContain(`as of ${dates[2]}`);
    expect(fig).toContain(formatWithSide(sheet.totalAssetsMinor));
    expect(fig).toContain(formatWithSide(sheet.totalLiabilitiesMinor));
    expect(fig).toContain(formatWithSide(sheet.totalEquityMinor));
    expect(fig).toContain(formatWithSide(sheet.liabilitiesAndEquityMinor));
    expect(sheet.balanced).toBe(true);
    // Prop fidelity, not the whole-book number: entries after the as-of date
    // are out, so total assets differ from the unbounded fold.
    const whole = buildBalanceSheet(expectedAccounts, expectedTxs, {});
    expect(sheet.totalAssetsMinor).not.toBe(whole.totalAssetsMinor);
    expect(fig).not.toContain(formatWithSide(whole.totalAssetsMinor));
    // ledgerBsRolled: false — leaf account names verbatim, not the rolled tree.
    expect(fig).toContain('Assets:Bank:Checking');
  });

  it('income statement: honours the period props; revenue/expenses/net income match the fold', () => {
    const statement = buildIncomeStatement(expectedAccounts, expectedTxs, {from: dates[4], to: dates[6]});
    const [fig] = figures(html, T('income-statement'));
    expect(fig).toContain(`${dates[4]} to ${dates[6]}`);
    expect(fig).toContain(formatWithSide(statement.totalRevenueMinor));
    expect(fig).toContain(formatWithSide(statement.totalExpensesMinor));
    expect(fig).toContain(formatWithSide(statement.netIncomeDebitMinor));
    expect(fig).toContain(describeNetIncome(statement));
    // The period really filtered: three entries are dated inside it, and only
    // two touch revenue/expense accounts (the equipment purchase is a pure
    // asset move — in the count, out of the P&L sums).
    expect(statement.transactionCount).toBe(3);
    expect(statement.postingCount).toBe(2);
  });

  it('account register: rows, running balance, totals and closing match the fold', () => {
    const register = buildAccountRegister(CHECKING, expectedAccounts, expectedTxs, {}, []);
    const [fig, figEmpty] = figures(html, T('account-register'));
    expect(fig).toContain('Assets:Bank:Checking');
    for (const row of register.rows) {
      expect(fig).toContain(row.description);
      expect(fig).toContain(formatWithSide(row.runningMinor));
    }
    expect(fig).toContain(formatAmount(register.totalDebitMinor));
    expect(fig).toContain(formatAmount(register.totalCreditMinor));
    expect(fig).toContain(formatWithSide(register.closingMinor));
    expect(fig).toContain(describeRegisterSummary(register));
    // No account chosen: a labelled empty frame, not a fabricated register.
    expect(figEmpty).toContain('No account selected');
  });

  it('journal entry: the posted entry renders as a balanced two-column table; an unlinked block stays a placeholder', () => {
    const [fig] = figures(html, T('journal-entry'));
    const tx = expectedTxs[0];
    expect(fig).toContain(tx.description);
    expect(fig).toContain(tx.date);
    expect(fig).toContain(formatAmount(tx.postings[0].amountMinor));
    expect(fig).toContain('Posted — entry #1');
    expect(fig).toContain('Assets:Bank:Checking');
    expect(fig).toContain('Equity:OwnersInvestment');
    // The second journal block never posted: exactly one table, one placeholder.
    expect(figures(html, T('journal-entry'))).toHaveLength(1);
    expect(placeholders(html, T('journal-entry'))).toHaveLength(1);
  });

  it('interactive-only blocks stay placeholders, labelled as interactive tools', () => {
    for (const name of ['bank-import', 'reconcile', 'period-close', 'beancount-export']) {
      expect(figures(html, T(name))).toHaveLength(0);
      const [card] = placeholders(html, T(name));
      expect(card).toBeTruthy();
      expect(card).toContain('Interactive ledger tool');
    }
    expect(describeLedgerInteractiveBlock(T('trial-balance'))).toBeNull();
  });
});

describe('LX-3 — records OFF: LX-1 placeholders intact', () => {
  const html = toHtmlSite(bundle(false));

  it('every ledger block is a labelled placeholder; no table, no numbers', () => {
    // (The class names themselves live in the stylesheet — check for RENDERED
    // report figures/tables, not the CSS.)
    expect(html).not.toContain('<figure class="ob-ledger-report"');
    expect(html).not.toContain('<table class="ledger-table"');
    for (const name of ['journal-entry', 'trial-balance', 'balance-sheet', 'income-statement', 'account-register']) {
      expect(placeholders(html, T(name)).length).toBeGreaterThan(0);
    }
    // The fixture's numbers cannot appear anywhere without records.
    expect(html).not.toContain('50,000.00');
  });
});

describe('LX-3 — adapter and purity', () => {
  it('a malformed section (no stored ledgerDb ids) adapts to null → placeholders', () => {
    const section = fixtureSection();
    section.settings = {};
    expect(ledgerExportRecords(section)).toBeNull();
    const b = bundle(true);
    b.ledger = section;
    expect(toHtmlSite(b)).not.toContain('<figure class="ob-ledger-report"');
  });

  it('the fold mirror compiled into the export bundle carries no React and no plugin runtime', () => {
    const foldFiles = ['../ledgerFolds.gen/reports.ts', '../ledgerFolds.gen/statements.ts'];
    for (const file of foldFiles) {
      const src = foldSources[file];
      expect(src).toBeTruthy();
      const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      for (const spec of imports) {
        expect(['@book.dev/sdk', './reports', './statements']).toContain(spec);
      }
      expect(src).not.toMatch(/from\s+'react'/);
    }
    // The renderer itself: folds + sdk + the shared placeholder wording only.
    const renderer = rendererSources['../exportLedgerReports.ts'];
    expect(renderer).toBeTruthy();
    expect(renderer).not.toMatch(/from\s+'react'/);
    expect(renderer).not.toMatch(/plugins\//);
  });
});
