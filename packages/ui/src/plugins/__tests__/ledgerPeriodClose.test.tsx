import React from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {storedLedgerPlugin as storedPlugin, loadLedgerPlugin} from './ledgerPluginFixture';
import type {DataClient, LedgerPeriod} from '@book.dev/sdk';
import {syncPlugins} from '../host';
import {getCustomBlock} from '../../blockeditor/registry';

/**
 * LGR-12 — the period model, the statement folds across a close, and the
 * period-close BLOCK, all through the REAL loader on the SHIPPED sources.
 *
 * The two fold suites here are the spec's own acceptance criteria:
 *
 *  - THE DAY-AFTER-CLOSE BALANCE SHEET (fixture test): after the closing entry,
 *    every flow account reads zero (current earnings = 0) and retained earnings
 *    holds the swept total — with the closing entry treated as an ORDINARY
 *    posted transaction by the balance-sheet fold, because that is what it is.
 *  - THE INCOME STATEMENT ACROSS A CLOSED PERIOD: the closing entry (and the
 *    reversal a reopen posts) is EXCLUDED — with it counted, every closed
 *    period reports a net income of exactly zero — and the exclusion is
 *    disclosed, never silent. The net-income ⇄ equity reconciliation stays an
 *    exact identity with `cleanPeriod` truthful across the close.
 *
 * The block tests pin what the store cannot: the read-only-page gating
 * (`pageReadOnly` — the document's real lock, NOT `editor.readOnly`, which is
 * deliberately false on read-only pages), the confirm-before-act steps, and
 * that the warn-not-block notice never disables the close button.
 */

type Fold = {
  buildBalanceSheet: (a: unknown[], t: unknown[], o?: {asOf?: string}) => {
    currentEarningsMinor: number;
    totalEquityMinor: number;
    equity: {totalMinor: number};
  };
  buildIncomeStatement: (a: unknown[], t: unknown[], o?: {from?: string; to?: string}) => {
    netIncomeMinor: number;
    closingCount: number;
    transactionCount: number;
  };
  reconcileNetIncome: (a: unknown[], t: unknown[], o?: {from?: string; to?: string}) => {
    reconciles: boolean;
    cleanPeriod: boolean;
    netIncomeMinor: number;
    equityDeltaMinor: number;
  };
  excludeClosingEntries: (t: unknown[]) => {kept: unknown[]; closingCount: number};
  describeClosingExclusion: (n: number) => string | null;
  describeCurrentEarnings: (s: unknown, o?: {truncated?: boolean; closedThrough?: string | null}) => string;
  describeClosedPeriodMarker: (p: unknown[], from: string, to: string) => string | null;
  latestCloseThrough: (p: unknown[], asOf: string) => string | null;
  defaultCloseRange: (p: unknown[], today: string) => {start: string; end: string};
  nextDayIso: (d: string) => string;
  describePeriodStatus: (p: unknown) => string;
  describeOpenReconciliationWarning: (o: Array<{statementDate: string; accountName: string}>) => string | null;
};

const fold = (): Fold => loadLedgerPlugin().exports as unknown as Fold;

const ACCOUNTS = [
  {id: 'cash', name: 'Assets:Cash', type: 'asset'},
  {id: 'sales', name: 'Income:Sales', type: 'revenue'},
  {id: 'rent', name: 'Expenses:Rent', type: 'expense'},
  {id: 'retained', name: 'Equity:RetainedEarnings', type: 'equity'},
];

let seq = 0;
const entry = (
  date: string,
  legs: Array<[string, number]>,
  over: Record<string, unknown> = {},
): Record<string, unknown> => {
  const id = `t${(seq += 1)}`;
  return {
    id,
    date,
    description: `entry ${id}`,
    state: 'posted',
    entryNo: seq,
    postings: legs.map(([accountId, amountMinor]) => ({id: `p${(seq += 1)}`, accountId, amountMinor, cleared: 'pending'})),
    ...over,
  };
};

/**
 * A quarter of trading plus its close, exactly as the server writes it:
 * sales 10 000 Cr, rent 4 000 Dr, then the `kind: 'closing'` entry dated on
 * the period end sweeping both into retained earnings (6 000 Cr profit).
 */
function closedQuarterBook(): Record<string, unknown>[] {
  return [
    entry('2026-01-15', [['cash', 10_000], ['sales', -10_000]]),
    entry('2026-02-10', [['rent', 4_000], ['cash', -4_000]]),
    entry('2026-03-31', [['sales', 10_000], ['rent', -4_000], ['retained', -6_000]], {kind: 'closing', description: 'Closing entry — 2026-01-01 to 2026-03-31'}),
  ];
}

const CLOSED_PERIOD: LedgerPeriod = {
  id: 'per-1',
  start: '2026-01-01',
  end: '2026-03-31',
  status: 'closed',
  closingEntryId: 't-close',
  reopenEntryId: null,
  closedAt: '2026-04-01T00:00:00.000Z',
  closedBy: 'tester',
  reopenedAt: null,
  reopenedBy: null,
};

afterEach(async () => {
  cleanup();
  await syncPlugins({listPlugins: async () => []} as unknown as DataClient);
  vi.restoreAllMocks();
});

describe('LGR-12 — day-after-close balance sheet (the spec AC, at the fold)', () => {
  it('shows zeroed flow accounts and updated retained earnings the day after the close', () => {
    const book = closedQuarterBook();
    const sheet = fold().buildBalanceSheet(ACCOUNTS, book, {asOf: '2026-04-01'});
    // Every income-statement balance was swept: current earnings reads ZERO…
    expect(sheet.currentEarningsMinor).toBe(0);
    // …and the equity SECTION holds the 6 000 profit (debit-positive: −6 000),
    // so total equity is unchanged by the close — the sweep moved money within
    // equity, from the computed line into the real account.
    expect(sheet.equity.totalMinor).toBe(-6_000);
    expect(sheet.totalEquityMinor).toBe(-6_000);
    // Control: the day BEFORE the close the same book has it the other way.
    const before = fold().buildBalanceSheet(ACCOUNTS, book, {asOf: '2026-03-30'});
    expect(before.currentEarningsMinor).toBe(-6_000);
    expect(before.equity.totalMinor).toBe(0);
    expect(before.totalEquityMinor).toBe(-6_000);
  });
});

describe('LGR-12 — income statement across a closed period', () => {
  it('excludes the closing entry (else every closed period reports zero) and discloses it', () => {
    const book = closedQuarterBook();
    const statement = fold().buildIncomeStatement(ACCOUNTS, book, {from: '2026-01-01', to: '2026-03-31'});
    expect(statement.netIncomeMinor).toBe(6_000); // the real quarter, not 0
    expect(statement.closingCount).toBe(1);
    expect(statement.transactionCount).toBe(2); // the two trading entries
    expect(fold().describeClosingExclusion(statement.closingCount)).toMatch(/1 period-close entry/);
    expect(fold().describeClosingExclusion(0)).toBeNull();
  });

  it('excludes the reversal a reopen posts, symmetrically', () => {
    const book = closedQuarterBook();
    const closingId = (book[2] as {id: string}).id;
    book.push(entry('2026-03-31', [['sales', -10_000], ['rent', 4_000], ['retained', 6_000]], {reverses: closingId, description: 'Reversal of closing entry'}));
    (book[2] as {state: string}).state = 'void';
    const {closingCount} = fold().excludeClosingEntries(book);
    expect(closingCount).toBe(2); // the closing entry AND its reversal
    const statement = fold().buildIncomeStatement(ACCOUNTS, book, {from: '2026-01-01', to: '2026-03-31'});
    expect(statement.netIncomeMinor).toBe(6_000); // unchanged through close + reopen
  });

  it('keeps the net-income ⇄ equity identity exact and cleanPeriod truthful across the close', () => {
    const book = closedQuarterBook();
    const rec = fold().reconcileNetIncome(ACCOUNTS, book, {from: '2026-01-01', to: '2026-03-31'});
    expect(rec.reconciles).toBe(true);
    expect(rec.netIncomeMinor).toBe(6_000);
    expect(rec.equityDeltaMinor).toBe(6_000);
    // The closing entry's retained-earnings leg is NOT a contribution or draw.
    expect(rec.cleanPeriod).toBe(true);
  });

  it('the current-earnings note names the close instead of claiming nothing was closed', () => {
    const book = closedQuarterBook();
    const sheet = fold().buildBalanceSheet(ACCOUNTS, book, {asOf: '2026-04-01'});
    const note = fold().describeCurrentEarnings(sheet, {closedThrough: fold().latestCloseThrough([CLOSED_PERIOD], '2026-04-01')});
    expect(note).toMatch(/since the 2026-03-31 period close/);
    expect(note).toMatch(/closed to retained earnings/);
    expect(note).not.toMatch(/nothing has been closed/);
    // A close dated AFTER the as-of has zeroed nothing this sheet can see.
    expect(fold().latestCloseThrough([CLOSED_PERIOD], '2026-02-01')).toBeNull();
    expect(fold().describeCurrentEarnings(sheet, {closedThrough: null})).toMatch(/nothing has been closed/);
  });
});

describe('LGR-12 — period model helpers', () => {
  it('marks a range that crosses a closed period, display-only, and stays silent otherwise', () => {
    expect(fold().describeClosedPeriodMarker([CLOSED_PERIOD], '2026-03-01', '2026-06-30')).toMatch(/2026-01-01 – 2026-03-31/);
    expect(fold().describeClosedPeriodMarker([CLOSED_PERIOD], '', '')).toMatch(/closed period/);
    expect(fold().describeClosedPeriodMarker([CLOSED_PERIOD], '2026-04-01', '')).toBeNull();
    expect(fold().describeClosedPeriodMarker([{...CLOSED_PERIOD, status: 'reopened'}], '', '')).toBeNull();
  });

  it('defaults the close form to the day after the last close, through today', () => {
    expect(fold().defaultCloseRange([CLOSED_PERIOD], '2026-08-02')).toEqual({start: '2026-04-01', end: '2026-08-02'});
    expect(fold().defaultCloseRange([], '2026-08-02')).toEqual({start: '2026-01-01', end: '2026-08-02'});
    // Reopened periods do not anchor the default — their range is open again.
    expect(fold().defaultCloseRange([{...CLOSED_PERIOD, status: 'reopened'}], '2026-08-02')).toEqual({start: '2026-01-01', end: '2026-08-02'});
    expect(fold().nextDayIso('2026-02-28')).toBe('2026-03-01'); // calendar-correct
    expect(fold().nextDayIso('2026-12-31')).toBe('2027-01-01');
  });

  it('warns about open reconciliations BY NAME — a notice, never a gate', () => {
    expect(fold().describeOpenReconciliationWarning([])).toBeNull();
    const warning = fold().describeOpenReconciliationWarning([{statementDate: '2026-03-31', accountName: 'Assets:Bank:Checking'}]);
    expect(warning).toMatch(/Assets:Bank:Checking \(statement 2026-03-31\)/);
    expect(warning).toMatch(/Closing does not wait/);
  });

  it('states each period row status, reopen evidence included', () => {
    expect(fold().describePeriodStatus(CLOSED_PERIOD)).toMatch(/Closed — closing entry posted/);
    expect(fold().describePeriodStatus({...CLOSED_PERIOD, closingEntryId: null})).toMatch(/nothing to close/);
    expect(fold().describePeriodStatus({...CLOSED_PERIOD, status: 'reopened', reopenEntryId: 'rev-12345678'})).toMatch(/voided by reversal rev-1234/);
  });
});

// ── The block ─────────────────────────────────────────────────────────────────

function fakeClient(opts: {periods?: LedgerPeriod[]; closeFails?: boolean} = {}) {
  const close = vi.fn(async () => ({
    period: CLOSED_PERIOD,
    closingEntry: {entryNo: 9},
    openReconciliations: [],
  }));
  const reopen = vi.fn(async () => ({
    period: {...CLOSED_PERIOD, status: 'reopened', reopenEntryId: 'rev-1'},
    reversal: {entryNo: 10},
  }));
  if (opts.closeFails) close.mockRejectedValue(new Error('the ledger refused the close'));
  const client = {
    listPlugins: async () => [storedPlugin()],
    subscribeRows: () => () => {},
    ledgerInfo: async () => ({
      exists: true,
      hostPageId: 'host',
      databases: {accounts: 'db-a', transactions: 'db-t', postings: 'db-p', reconciliations: 'db-r'},
    }),
    ledgerListAccounts: async () => [
      {id: 'bank', name: 'Assets:Bank:Checking', type: 'asset', status: 'open', currency: 'USD', createdAt: '', updatedAt: ''},
    ],
    ledgerListTransactions: async () => [],
    ledgerListReconciliations: async () => [
      {id: 'rec-1', accountId: 'bank', statementDate: '2026-03-31', statementBalanceMinor: 1, status: 'open', createdAt: '', updatedAt: ''},
    ],
    ledgerListPeriods: async () => opts.periods ?? [CLOSED_PERIOD],
    ledgerClosePeriod: close,
    ledgerReopenPeriod: reopen,
  } as unknown as DataClient;
  return {client, close, reopen};
}

async function mountBlock(client: DataClient, pageReadOnly: boolean): Promise<void> {
  await syncPlugins(client);
  const def = getCustomBlock('openbook.ledger/period-close');
  expect(def).toBeDefined();
  const props = new Map<string, unknown>();
  const block = {get: (key: string) => (key === 'props' ? props : key === 'id' ? 'blk-periods' : undefined)} as never;
  // `editor.readOnly` is FALSE on purpose, including in the read-only-page
  // test: the host hands a custom block an operable editor on a read-only page
  // and the document's real lock arrives as `pageReadOnly` — gating on the
  // editor is the exact defect class LGR-23 is closing.
  const editor = {readOnly: false, doc: {transact: (fn: () => void) => fn()}} as never;
  render(React.createElement(def!.render, {block, editor, pageReadOnly}));
  await screen.findByText(/Closing a period sweeps revenue and expenses/);
}

const el = <T extends HTMLElement>(selector: string): T => {
  const found = document.querySelector<T>(selector);
  expect(found, selector).not.toBeNull();
  return found!;
};

describe('LGR-12 — period-close block', () => {
  it('lists periods and closes through confirm — with the open-reconciliation WARNING never gating', async () => {
    const {client, close} = fakeClient();
    await mountBlock(client, false);
    expect(screen.getByText('2026-01-01 – 2026-03-31')).toBeDefined();

    fireEvent.click(el('[data-ledger-period-close]'));
    // The confirm states what will happen, and the warning NAMES the open
    // reconciliation — while the confirm button stays enabled (warn-not-block).
    expect(el('[data-ledger-period-open-recs]').textContent).toMatch(/Assets:Bank:Checking/);
    const confirm = el<HTMLButtonElement>('[data-ledger-period-close-confirm]');
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    await screen.findByText(/closing entry #9 posted to retained earnings/);
  });

  it('reopens through its own confirm, naming the void-by-reversal', async () => {
    const {client, reopen} = fakeClient();
    await mountBlock(client, false);
    fireEvent.click(el('[data-ledger-period-reopen]'));
    expect(screen.getByText(/closing entry is voided by a reversal/)).toBeDefined();
    fireEvent.click(el('[data-ledger-period-reopen-confirm]'));
    await waitFor(() => expect(reopen).toHaveBeenCalledWith(CLOSED_PERIOD.id));
    await screen.findByText(/voided by reversal #10/);
  });

  it('a refused close is reported and the flow stays open to retry', async () => {
    const {client, close} = fakeClient({closeFails: true});
    await mountBlock(client, false);
    fireEvent.click(el('[data-ledger-period-close]'));
    fireEvent.click(el('[data-ledger-period-close-confirm]'));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    await screen.findByText(/the ledger refused the close/);
    expect(document.querySelector('[data-ledger-period-close-confirm]')).not.toBeNull();
  });

  it('on a read-only page every write control is dead, visibly, with the reason wired via aria-describedby', async () => {
    const {client, close, reopen} = fakeClient();
    await mountBlock(client, true);
    const locked = el('[data-ledger-periods-locked]');
    expect(locked.textContent).toMatch(/read-only/);
    for (const selector of ['[data-ledger-period-close]', '[data-ledger-period-reopen]', '[data-ledger-period-start]', '[data-ledger-period-end]']) {
      const control = el<HTMLButtonElement | HTMLInputElement>(selector);
      expect(control.disabled, selector).toBe(true);
      expect(control.getAttribute('aria-describedby'), selector).toBe(locked.id);
    }
    fireEvent.click(el('[data-ledger-period-close]'));
    fireEvent.click(el('[data-ledger-period-reopen]'));
    expect(close).not.toHaveBeenCalled();
    expect(reopen).not.toHaveBeenCalled();
  });
});
