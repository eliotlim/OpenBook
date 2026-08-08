/**
 * LX-3: static ledger REPORT tables for the HTML export.
 *
 * When a site export carries the ledger records (LX-2's `ledger` island
 * section), the five ledger report blocks render as REAL tables computed by
 * the exact pure folds the in-app blocks use (`buildTrialBalance`,
 * `buildBalanceSheet`, `buildIncomeStatement`, `buildAccountRegister` — see
 * `./ledgerFolds.gen/`, a build-time mirror of the plugin's pure modules), so
 * the exported numbers match what the exporting user saw by construction.
 *
 * Three layers:
 *  1. ADAPTER — {@link ledgerExportRecords}: the embedded `LibrarySnapshot`
 *     rows (StoredPage properties keyed by the SDK's stable `LEDGER_PROP`
 *     ids) → the folds' `ReportAccount`/`ReportTransaction`/... input slices,
 *     coerced exactly the way the server's own row→entity projections coerce
 *     (`accountFromRow`/`postingFromRow`/`transactionFromRow` in
 *     server/ledger.ts) so the folds see the same values the API serves.
 *  2. RENDERERS — {@link renderLedgerReportBlock}: pure string → HTML table
 *     per report type, honouring the block's persisted props (as-of date,
 *     period, account/date/cleared filters, show-zero, rolled/collapsed) so
 *     the export shows the report the way the user had configured it.
 *  3. WORDS — the fold's own assertion/summary sentences ride under each
 *     table, so an exported trial balance still SAYS whether it balances.
 *
 * Fail-shut: any fold error (e.g. a stored amount the money core refuses to
 * add) returns `null` and the caller falls back to the LX-1 placeholder card —
 * a wrong number rendered confidently is worse than a labelled placeholder.
 *
 * The four INTERACTIVE ledger tools (bank import, reconcile, period close,
 * Beancount export) have no meaningful static render — records or not, they
 * stay placeholder cards, labelled as interactive
 * ({@link describeLedgerInteractiveBlock}).
 */
import type {LedgerExportSection, StoredPage} from '@book.dev/sdk';
import {LEDGER_PROP, formatAmount, isValidCurrencyCode, negateAmount, sumAmounts} from '@book.dev/sdk';
import {
  ALL_CLEARED_STATES,
  buildAccountRegister,
  buildTrialBalance,
  describeRegisterSummary,
  describeTrialBalanceAssertion,
  formatWithSide,
  type ReportAccount,
  type ReportClearedState,
  type ReportPosting,
  type ReportReconciliation,
  type ReportTransaction,
} from './ledgerFolds.gen/reports';
import {
  CURRENT_EARNINGS_LABEL,
  buildBalanceSheet,
  buildIncomeStatement,
  describeBalanceSheetAssertion,
  describeClosingExclusion,
  describeNetIncome,
  flattenHierarchy,
  leafRows,
  startOfYear,
  type HierarchyRow,
  type StatementSection,
} from './ledgerFolds.gen/statements';
import {describeUnknownBlock} from '../blockeditor/unknownBlock';

/** The type prefix of every block the first-party ledger plugin registers. */
const LEDGER_PREFIX = 'openbook.ledger/';

/** Whether a block type belongs to the first-party ledger plugin. */
export const isLedgerBlockType = (type: string): boolean => type.startsWith(LEDGER_PREFIX);

/**
 * The identity of the block being rendered: its plugin type and its stable
 * block id. Both ride into the static markup so the hydrating viewer can find
 * this render and PRESERVE it (LX-5) instead of drawing an install-plugin card
 * over real numbers.
 */
export interface LedgerBlockRef {
  type: string;
  id: string;
}

// ── Adapter: LibrarySnapshot rows → fold inputs ──────────────────────────────

/** The typed report inputs recovered from an embedded ledger section. */
export interface LedgerExportRecords {
  accounts: ReportAccount[];
  transactions: ReportTransaction[];
  reconciliations: ReportReconciliation[];
  /** The single ISO-4217 code every account row carries (`lp_currency`;
   *  absent → USD, the seeded default — one currency per account is enforced
   *  at write time), or `null` when the rows mix codes or carry a malformed
   *  one: the tables still render, the currency caption is simply omitted —
   *  a statement handed to an accountant must state its currency, but a
   *  guessed currency would be worse than none. */
  currency: string | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Recover the folds' typed inputs from the embedded records, or `null` when
 * the section is malformed (no stored `ledgerDb` ids — nothing to key the four
 * databases by). Coercions mirror the server's row→entity projections: the
 * fold must see the same values `ledgerListAccounts`/`ledgerListTransactions`
 * would have served the in-app report.
 */
export function ledgerExportRecords(section: LedgerExportSection): LedgerExportRecords | null {
  const ledgerDb = (section.settings ?? {}).ledgerDb as Record<string, unknown> | undefined;
  if (!ledgerDb || typeof ledgerDb !== 'object') return null;
  const dbIds = {
    accounts: str(ledgerDb.accounts),
    transactions: str(ledgerDb.transactions),
    postings: str(ledgerDb.postings),
    reconciliations: str(ledgerDb.reconciliations),
  };
  if (!dbIds.accounts || !dbIds.transactions || !dbIds.postings) return null;

  // A section can carry valid ledgerDb ids yet a missing/malformed library
  // (a hand-built or truncated export). Null — per-block placeholders — never
  // a TypeError that escapes toHtmlSite and crashes the WHOLE export. Rows
  // that are not object-shaped (or carry no properties bag) are equally
  // untrusted input, not a reason to throw.
  const pages = section.library?.pages;
  if (!Array.isArray(pages)) return null;
  const rowsOf = (dbId: string): StoredPage[] =>
    pages.filter((p) => typeof p === 'object' && p !== null && p.databaseId === dbId);
  const propsOf = (row: StoredPage): Record<string, unknown> =>
    row.properties && typeof row.properties === 'object' ? row.properties : {};

  const accounts: ReportAccount[] = rowsOf(dbIds.accounts).map((row) => ({
    id: row.id,
    name: row.name ?? '',
    type: (str(propsOf(row)[LEDGER_PROP.account.type]) || 'asset') as ReportAccount['type'],
    evidenceRequired: propsOf(row)[LEDGER_PROP.account.evidenceRequired] === true,
  }));

  const postingsByTx = new Map<string, ReportPosting[]>();
  for (const row of rowsOf(dbIds.postings)) {
    const props = propsOf(row);
    const amount = props[LEDGER_PROP.posting.amount];
    const posting: ReportPosting = {
      id: row.id,
      accountId: str(props[LEDGER_PROP.posting.account]),
      amountMinor: typeof amount === 'number' ? amount : Number(amount ?? 0),
      cleared: (str(props[LEDGER_PROP.posting.cleared]) || 'pending') as ReportClearedState,
      reconciliationId: strOrNull(props[LEDGER_PROP.posting.reconciliation]),
    };
    const txId = str(props[LEDGER_PROP.posting.transaction]);
    const list = postingsByTx.get(txId);
    if (list) list.push(posting);
    else postingsByTx.set(txId, [posting]);
  }

  const transactions: ReportTransaction[] = rowsOf(dbIds.transactions).map((row) => {
    const props = propsOf(row);
    const entryNo = props[LEDGER_PROP.transaction.entryNo];
    const evidence = props[LEDGER_PROP.transaction.evidence];
    return {
      id: row.id,
      date: str(props[LEDGER_PROP.transaction.date]),
      description: str(props[LEDGER_PROP.transaction.description]),
      state: (str(props[LEDGER_PROP.transaction.state]) || 'draft') as ReportTransaction['state'],
      entryNo: typeof entryNo === 'number' && Number.isFinite(entryNo) ? entryNo : null,
      reverses: strOrNull(props[LEDGER_PROP.transaction.reverses]),
      kind: props[LEDGER_PROP.transaction.kind] === 'closing' ? ('closing' as const) : null,
      evidence: Array.isArray(evidence) ? (evidence as ReportTransaction['evidence']) : [],
      postings: postingsByTx.get(row.id) ?? [],
    };
  });

  const reconciliations: ReportReconciliation[] = dbIds.reconciliations
    ? rowsOf(dbIds.reconciliations).map((row) => ({
      id: row.id,
      statementDate: str(propsOf(row)[LEDGER_PROP.reconciliation.statementDate]),
    }))
    : [];

  // Fail shut on ORPHAN postings: a posting keyed to a transaction the section
  // does not hold (bad/absent `lp_transaction`) means the books arrived
  // incomplete — every total computed without it would be a wrong number
  // rendered confidently. Refuse the whole section: placeholders, not totals.
  const txIds = new Set(transactions.map((t) => t.id));
  for (const txId of postingsByTx.keys()) {
    if (!txIds.has(txId)) return null;
  }

  // Resolve the report currency from the account rows. `null` (mixed or
  // malformed codes) omits the caption gracefully — never a crash, never a
  // guess. No accounts at all keeps the seeded USD default.
  const codes = new Set(rowsOf(dbIds.accounts).map((row) => str(propsOf(row)[LEDGER_PROP.account.currency]) || 'USD'));
  const only = codes.size === 0 ? 'USD' : codes.size === 1 ? [...codes][0] : null;
  const currency = only !== null && isValidCurrencyCode(only) ? only : null;

  return {accounts, transactions, reconciliations, currency};
}

// ── Interactive-only blocks ──────────────────────────────────────────────────

/** Ledger blocks with no meaningful static render — placeholders ALWAYS. */
const INTERACTIVE_BLOCKS = new Set(
  ['bank-import', 'reconcile', 'period-close', 'beancount-export'].map((t) => LEDGER_PREFIX + t),
);

/**
 * The placeholder wording for an interactive-only ledger tool, or `null` for
 * any other type. These four act on the LIVE books (import, match, close,
 * download) — a static page cannot do any of that, records or no records, so
 * the honest card says "interactive", not "missing plugin".
 */
export function describeLedgerInteractiveBlock(type: string): {label: string; hint: string} | null {
  if (!INTERACTIVE_BLOCKS.has(type)) return null;
  return {
    label: describeUnknownBlock(type).label,
    hint: 'Interactive ledger tool — it works on the live books and has no static view. Open the page in OpenBook to use it.',
  };
}

// ── Records-off report blocks ────────────────────────────────────────────────

/** The five ledger REPORT block types (the ones LX-3 renders as tables). */
const REPORT_BLOCKS = new Set(
  ['journal-entry', 'trial-balance', 'balance-sheet', 'income-statement', 'account-register'].map((t) => LEDGER_PREFIX + t),
);

/**
 * The placeholder wording for a ledger REPORT block when the export carries no
 * usable books (no LX-2 section, or a malformed one), or `null` for any other
 * type. The ledger is FIRST-PARTY — the generic "requires the Ledger plugin —
 * install the plugin" line (describeUnknownBlock) is the wrong diagnosis here:
 * nothing is missing from the app, the books just weren't included in this
 * export. Same "open in OpenBook" register as the interactive tools' card.
 */
export function describeLedgerReportBlock(type: string): {label: string; hint: string} | null {
  if (!REPORT_BLOCKS.has(type)) return null;
  return {
    label: describeUnknownBlock(type).label,
    hint: 'Ledger report — the books weren\'t included in this export. Open the page in OpenBook to see it.',
  };
}

// ── Render helpers ───────────────────────────────────────────────────────────

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]!);

/**
 * LX-5 — the attribute marking a static render the hydrating viewer must KEEP
 * rather than replace with its own missing-plugin card. The viewer itself never
 * reads the name: the export's boot script harvests
 * `[data-ob-keep-static][data-block-id]` nodes out of the static body BEFORE it
 * swaps in the viewer host and hands them to `mount` keyed by block id, so the
 * viewer bundle gains no ledger knowledge (and no ledger bytes) at all. The
 * value documents WHY this node is authoritative.
 */
export const KEEP_STATIC_ATTR = 'data-ob-keep-static';

/**
 * `data-block-id` plus the keep marker, for a ledger block whose static render
 * (a real report table, or the exporter's own honest placeholder wording) is
 * authoritative on the hydrate path. A block with no id gets neither attribute:
 * without a key the viewer could not match the node to a block, and a marker
 * nothing can claim is just noise.
 */
export function keepStaticAttrs(id: string): string {
  return id ? ` data-block-id="${esc(id)}" ${KEEP_STATIC_ATTR}="ledger"` : '';
}

/** Local-clock ISO date — byte-for-byte the plugin's `todayIso` (model.ts), so
 *  a defaulted as-of/period resolves exactly as the in-app block resolves it. */
function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Mirror of the statement blocks' collapsed-path codec (statementShell.tsx):
 *  a JSON string array; anything unreadable reads as "nothing collapsed". */
function parseCollapsed(raw: string): Set<string> {
  if (raw.trim() === '') return new Set<string>();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter((p): p is string => typeof p === 'string' && p !== ''));
  } catch {
    return new Set<string>();
  }
}

/** Mirror of the register block's cleared-prop codec (register.tsx). */
function parseClearedProp(raw: string): ReportClearedState[] {
  const wanted = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const kept = ALL_CLEARED_STATES.filter((state) => wanted.includes(state));
  return kept.length > 0 ? [...kept] : [...ALL_CLEARED_STATES];
}

const propStr = (props: Record<string, unknown>, key: string): string => str(props[key]);
const propBool = (props: Record<string, unknown>, key: string, fallback: boolean): boolean =>
  typeof props[key] === 'boolean' ? (props[key] as boolean) : fallback;

/** A debit/credit cell pair from one signed debit-positive amount. */
const drCrCells = (minor: number): string =>
  `<td class="num">${minor > 0 ? formatAmount(minor) : ''}</td><td class="num">${minor < 0 ? formatAmount(negateAmount(minor)) : ''}</td>`;

const note = (text: string, alarm = false): string =>
  `<p class="ob-ledger-note${alarm ? ' is-alarm' : ''}">${esc(text)}</p>`;

/** The report frame: caption (+ subtitle, + currency) around table + notes.
 *  `currency` (Devon 1) rides in the caption — "Amounts in USD" — because a
 *  statement handed to an accountant must state its currency; `null` (mixed
 *  books, malformed code, or a frame with no amounts) omits it gracefully.
 *  The figure carries the block's identity and the LX-5 keep marker, so the
 *  hydrating viewer re-attaches this table instead of replacing it. */
function frame(block: LedgerBlockRef, title: string, sub: string, body: string, currency: string | null = null): string {
  return (
    `<figure class="ob-ledger-report" data-block-type="${esc(block.type)}"${keepStaticAttrs(block.id)}>` +
    `<figcaption class="ob-ledger-title">${esc(title)}${sub ? ` <span class="ob-ledger-sub">${esc(sub)}</span>` : ''}` +
    `${currency ? `<span class="ob-ledger-currency">Amounts in ${esc(currency)}</span>` : ''}</figcaption>` +
    body +
    '</figure>'
  );
}

/** A statement section's rows (rolled hierarchy or flat leaves) as `<tr>`s. */
function sectionRows(section: StatementSection, rolled: boolean, collapsed: ReadonlySet<string>, emptyText: string): string {
  const rows: HierarchyRow[] = rolled ? flattenHierarchy(section.nodes, collapsed) : leafRows(section.nodes);
  const head = `<tr class="ledger-section"><th colspan="2">${esc(section.title)}</th></tr>`;
  if (rows.length === 0) return `${head}<tr><td colspan="2" class="ledger-empty">${esc(emptyText)}</td></tr>`;
  return (
    head +
    rows
      .map(
        (r) =>
          `<tr><td style="padding-left:${10 + r.depth * 16}px">${esc(r.label)}</td>` +
          `<td class="num">${esc(formatWithSide(r.minor))}</td></tr>`,
      )
      .join('')
  );
}

const totalRow = (label: string, value: string): string =>
  `<tr class="ledger-total"><td>${esc(label)}</td><td class="num">${esc(value)}</td></tr>`;

// ── The report renderers ─────────────────────────────────────────────────────

/**
 * Render one ledger REPORT block as a static HTML table, or `null` when this
 * type has no table render (interactive tools, an unlinkable journal entry) or
 * the fold refused the stored data — the caller then falls back to the LX-1
 * placeholder card. Props are the block's persisted props (the projection
 * carries them verbatim under `data.props`, LX-1).
 */
export function renderLedgerReportBlock(
  block: LedgerBlockRef,
  props: Record<string, unknown>,
  records: LedgerExportRecords,
): string | null {
  if (!isLedgerBlockType(block.type)) return null;
  try {
    switch (block.type.slice(LEDGER_PREFIX.length)) {
    case 'trial-balance':
      return trialBalanceTable(block, props, records);
    case 'balance-sheet':
      return balanceSheetTable(block, props, records);
    case 'income-statement':
      return incomeStatementTable(block, props, records);
    case 'account-register':
      return accountRegisterTable(block, props, records);
    case 'journal-entry':
      return journalEntryTable(block, props, records);
    default:
      return null;
    }
  } catch {
    // A stored amount the money core refuses to add (or any other fold throw):
    // fail shut to the labelled placeholder rather than render a wrong number.
    return null;
  }
}

function trialBalanceTable(block: LedgerBlockRef, props: Record<string, unknown>, records: LedgerExportRecords): string {
  const tb = buildTrialBalance(records.accounts, records.transactions, {
    includeZero: propBool(props, 'ledgerTbShowZero', false),
  });
  const body = tb.rows
    .map((r) => `<tr><td>${esc(r.name)}</td>${drCrCells(r.balanceMinor)}</tr>`)
    .join('');
  const assertion = describeTrialBalanceAssertion(tb);
  const table =
    '<table class="ledger-table"><thead><tr><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>' +
    `<tbody>${body}</tbody>` +
    `<tfoot><tr class="ledger-total"><td>Total</td><td class="num">${formatAmount(tb.totalDebitMinor)}</td><td class="num">${formatAmount(tb.totalCreditMinor)}</td></tr></tfoot></table>`;
  const notes =
    note(assertion.text, !assertion.ok) +
    (assertion.ok || !assertion.culprits ? '' : note(assertion.culprits, true));
  return frame(block, 'Trial balance', '', table + notes, records.currency);
}

function balanceSheetTable(block: LedgerBlockRef, props: Record<string, unknown>, records: LedgerExportRecords): string {
  // Same defaulting as the in-app block: an empty prop means "today", resolved
  // at render (export) time on the local clock.
  const asOf = propStr(props, 'ledgerBsAsOf') || todayIso();
  const rolled = propBool(props, 'ledgerBsRolled', true);
  const collapsed = parseCollapsed(propStr(props, 'ledgerBsCollapsed'));
  const sheet = buildBalanceSheet(records.accounts, records.transactions, {asOf});
  const rows =
    sectionRows(sheet.assets, rolled, collapsed, 'No asset accounts.') +
    totalRow('Total assets', formatWithSide(sheet.totalAssetsMinor)) +
    sectionRows(sheet.liabilities, rolled, collapsed, 'No liability accounts.') +
    totalRow('Total liabilities', formatWithSide(sheet.totalLiabilitiesMinor)) +
    sectionRows(sheet.equity, rolled, collapsed, 'No equity accounts.') +
    `<tr><td>${esc(CURRENT_EARNINGS_LABEL)}</td><td class="num">${esc(formatWithSide(sheet.currentEarningsMinor))}</td></tr>` +
    totalRow('Total equity', formatWithSide(sheet.totalEquityMinor)) +
    (sheet.unclassified.accountCount > 0
      ? sectionRows(sheet.unclassified, rolled, collapsed, '') : '') +
    totalRow('Total liabilities + equity', formatWithSide(sheet.liabilitiesAndEquityMinor));
  const assertion = describeBalanceSheetAssertion(sheet);
  const notes =
    note(assertion.text, !assertion.ok) +
    (assertion.ok || !assertion.culprits ? '' : note(assertion.culprits, true)) +
    (assertion.unclassified ? note(assertion.unclassified, true) : '');
  return frame(block, 'Balance sheet', `as of ${asOf}`, `<table class="ledger-table"><tbody>${rows}</tbody></table>${notes}`, records.currency);
}

function incomeStatementTable(block: LedgerBlockRef, props: Record<string, unknown>, records: LedgerExportRecords): string {
  // Same defaulting as the in-app block: year-to-date on the local clock.
  const today = todayIso();
  const from = propStr(props, 'ledgerIsFrom') || startOfYear(today);
  const to = propStr(props, 'ledgerIsTo') || today;
  const rolled = propBool(props, 'ledgerIsRolled', true);
  const collapsed = parseCollapsed(propStr(props, 'ledgerIsCollapsed'));
  const statement = buildIncomeStatement(records.accounts, records.transactions, {from, to});
  const rows =
    sectionRows(statement.revenue, rolled, collapsed, 'No revenue in this period.') +
    totalRow('Total revenue', formatWithSide(statement.totalRevenueMinor)) +
    sectionRows(statement.expenses, rolled, collapsed, 'No expenses in this period.') +
    totalRow('Total expenses', formatWithSide(statement.totalExpensesMinor)) +
    totalRow(statement.profit ? 'Net income' : 'Net loss', formatWithSide(statement.netIncomeDebitMinor));
  const closing = describeClosingExclusion(statement.closingCount);
  const notes =
    note(describeNetIncome(statement)) +
    (statement.unclassifiedMinor !== 0 ? note(`Unclassified (deleted accounts): ${formatWithSide(statement.unclassifiedMinor)} is outside these figures.`, true) : '') +
    (closing ? note(closing) : '');
  return frame(block, 'Income statement', `${from} to ${to}`, `<table class="ledger-table"><tbody>${rows}</tbody></table>${notes}`, records.currency);
}

function accountRegisterTable(block: LedgerBlockRef, props: Record<string, unknown>, records: LedgerExportRecords): string {
  const accountId = propStr(props, 'ledgerRegAccount');
  if (accountId === '') {
    return frame(block, 'Account register', '', note('No account selected — open the page in OpenBook to pick one.'));
  }
  const from = propStr(props, 'ledgerRegFrom');
  const to = propStr(props, 'ledgerRegTo');
  const cleared = parseClearedProp(propStr(props, 'ledgerRegCleared'));
  const register = buildAccountRegister(accountId, records.accounts, records.transactions, {from, to, cleared}, records.reconciliations);
  if (!register.exists) {
    return frame(block, 'Account register', '', note(`Unknown account (${accountId}) — it may have been deleted since this block was configured.`, true));
  }
  const opening = register.filter.from !== null
    ? `<tr><td colspan="4">Opening balance</td><td class="num"></td><td class="num"></td><td class="num">${esc(formatWithSide(register.openingMinor))}</td></tr>`
    : '';
  const body = register.rows
    .map(
      (r) =>
        `<tr><td>${esc(r.date)}</td><td class="num">${r.entryNo === null ? '' : `#${r.entryNo}`}</td>` +
        `<td>${esc(r.description)}${r.reversed ? ' <span class="ledger-reversed">(reversed)</span>' : ''}</td>` +
        `<td>${esc(r.contra)}</td>${drCrCells(r.amountMinor)}` +
        `<td class="num">${esc(formatWithSide(r.runningMinor))}</td></tr>`,
    )
    .join('');
  const table =
    '<table class="ledger-table"><thead><tr><th>Date</th><th class="num">Entry</th><th>Description</th><th>Contra account</th>' +
    '<th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead>' +
    `<tbody>${opening}${body}</tbody>` +
    `<tfoot><tr class="ledger-total"><td colspan="4">Totals</td><td class="num">${formatAmount(register.totalDebitMinor)}</td>` +
    `<td class="num">${formatAmount(register.totalCreditMinor)}</td><td class="num">${esc(formatWithSide(register.closingMinor))}</td></tr></tfoot></table>`;
  const range = register.filter.from || register.filter.to
    ? `${register.filter.from ?? '…'} to ${register.filter.to ?? '…'}`
    : '';
  return frame(block, 'Account register', [register.accountName, range].filter(Boolean).join(' — '), table + note(describeRegisterSummary(register)), records.currency);
}

function journalEntryTable(block: LedgerBlockRef, props: Record<string, unknown>, records: LedgerExportRecords): string | null {
  // The block persists its draft's id (`ledgerDraftId`); posting keeps the id,
  // so a posted entry is found under the same key. No id, or an id the books
  // don't hold (never posted / trimmed) → null → the LX-1 placeholder.
  const id = propStr(props, 'ledgerDraftId');
  if (id === '') return null;
  const tx = records.transactions.find((t) => t.id === id);
  if (!tx) return null;
  // Every posting amount goes through the money core BEFORE any cell renders:
  // a non-integer (NaN from a corrupt stored row) THROWS here → the caller's
  // try/catch → the labelled placeholder. The raw `> 0`/`< 0` filters below
  // would have rendered NaN as blank/blank AND silently dropped it from the
  // Total row — a wrong number with no alarm, breaking the fail-shut
  // invariant every other renderer upholds via its fold's own `sumAmounts`.
  const amounts = tx.postings.map((p) => p.amountMinor);
  sumAmounts(amounts);
  const nameById = new Map(records.accounts.map((a) => [a.id, a.name]));
  const body = tx.postings
    .map((p) => `<tr><td>${esc(nameById.get(p.accountId) ?? `Deleted account (${p.accountId})`)}</td>${drCrCells(p.amountMinor)}</tr>`)
    .join('');
  const debits = sumAmounts(amounts.filter((n) => n > 0));
  const credits = negateAmount(sumAmounts(amounts.filter((n) => n < 0)));
  const table =
    '<table class="ledger-table"><thead><tr><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>' +
    `<tbody>${body}</tbody>` +
    `<tfoot><tr class="ledger-total"><td>Total</td><td class="num">${formatAmount(debits)}</td><td class="num">${formatAmount(credits)}</td></tr></tfoot></table>`;
  const state =
    tx.state === 'posted'
      ? note(`Posted${tx.entryNo === null ? '' : ` — entry #${tx.entryNo}`}.`)
      : tx.state === 'void'
        ? note('Reversed — this entry was voided by a reversal.')
        : note('Draft — not yet posted; drafts are excluded from every report.');
  return frame(block, 'Journal entry', `${tx.date}${tx.description ? ` — ${tx.description}` : ''}`, table + state, records.currency);
}
