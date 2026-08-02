import {describe, expect, it} from 'vitest';
import {negateAmount, sumAmounts} from '@book.dev/sdk';
import {LEDGER_PLUGIN_FILES, ledgerManifestSource, loadLedgerPlugin} from './ledgerPluginFixture';

/**
 * LGR-9 — the pure statement folds: the colon-hierarchy rollup, the balance
 * sheet's accounting identity, the income statement's net income, and the
 * reconciliation that ties the two together.
 *
 * Everything here runs the SHIPPED plugin sources through the REAL loader (see
 * `ledgerPluginFixture`), and every amount is signed integer minor units through
 * the host money core — these tests are the proof that the statements add up.
 */

type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
type ClearedState = 'pending' | 'cleared' | 'reconciled';
type TxState = 'draft' | 'posted' | 'void';

interface Account {
  id: string;
  name: string;
  type: AccountType;
}
interface Posting {
  id: string;
  accountId: string;
  amountMinor: number;
  cleared: ClearedState;
}
interface Transaction {
  id: string;
  date: string;
  description: string;
  state: TxState;
  entryNo: number | null;
  postings: Posting[];
}
interface HierarchyNode {
  path: string;
  label: string;
  depth: number;
  accountId: string | null;
  ownMinor: number;
  rolledMinor: number;
  children: HierarchyNode[];
  accountCount: number;
  parentIsAccount: boolean;
}
interface HierarchyRow {
  key: string;
  path: string;
  label: string;
  depth: number;
  minor: number;
  kind: 'node' | 'direct';
  hasChildren: boolean;
  collapsed: boolean;
  accountId: string | null;
  accountCount: number;
  parentIsAccount: boolean;
}
interface StatementSection {
  key: string;
  title: string;
  nodes: HierarchyNode[];
  totalMinor: number;
  accountCount: number;
}
interface UnbalancedEntry {
  transactionId: string;
  entryNo: number | null;
  date: string;
  description: string;
  deltaMinor: number;
}
interface BalanceSheet {
  asOf: string;
  assets: StatementSection;
  liabilities: StatementSection;
  equity: StatementSection;
  unclassified: StatementSection;
  currentEarningsMinor: number;
  totalAssetsMinor: number;
  totalLiabilitiesMinor: number;
  totalEquityMinor: number;
  liabilitiesAndEquityMinor: number;
  differenceMinor: number;
  balanced: boolean;
  unclassifiedMinor: number;
  unknownAccountIds: string[];
  unbalancedEntries: UnbalancedEntry[];
  draftCount: number;
  postedCount: number;
  voidCount: number;
  postingCount: number;
  afterCount: number;
  accountCount: number;
}
interface IncomeStatement {
  from: string;
  to: string;
  revenue: StatementSection;
  expenses: StatementSection;
  totalRevenueMinor: number;
  totalExpensesMinor: number;
  netIncomeMinor: number;
  netIncomeDebitMinor: number;
  profit: boolean;
  unclassifiedMinor: number;
  unknownAccountIds: string[];
  draftCount: number;
  transactionCount: number;
  postingCount: number;
  outsideCount: number;
  accountCount: number;
}
interface NetIncomeReconciliation {
  from: string;
  to: string;
  netIncomeMinor: number;
  openingEquityMinor: number;
  closingEquityMinor: number;
  equityDeltaMinor: number;
  otherEquityMovementsMinor: number;
  reconciles: boolean;
  cleanPeriod: boolean;
  unclassifiedMinor: number;
}

/** The plugin's statement exports, through the REAL loader + host modules. */
function statements(): {
  buildHierarchy: (items: readonly {accountId: string; name: string; minor: number}[]) => HierarchyNode[];
  flattenHierarchy: (nodes: readonly HierarchyNode[], collapsed?: ReadonlySet<string>) => HierarchyRow[];
  leafRows: (nodes: readonly HierarchyNode[]) => HierarchyRow[];
  hierarchyLeaves: (nodes: readonly HierarchyNode[]) => Array<{path: string; accountId: string; ownMinor: number}>;
  hierarchyRolledTotal: (nodes: readonly HierarchyNode[]) => number;
  hierarchyLeafTotal: (nodes: readonly HierarchyNode[]) => number;
  hierarchyParentPaths: (nodes: readonly HierarchyNode[]) => string[];
  splitAccountPath: (name: string) => string[];
  buildBalanceSheet: (a: readonly Account[], t: readonly Transaction[], o?: {asOf?: string}) => BalanceSheet;
  buildIncomeStatement: (a: readonly Account[], t: readonly Transaction[], o?: {from?: string; to?: string}) => IncomeStatement;
  reconcileNetIncome: (a: readonly Account[], t: readonly Transaction[], o?: {from?: string; to?: string}) => NetIncomeReconciliation;
  describeBalanceSheetAssertion: (s: BalanceSheet, o?: {truncated?: boolean}) => {ok: boolean; text: string; culprits?: string | null; unclassified?: string | null};
  describeBalanceSheetScope: (s: BalanceSheet, o: {truncated: boolean; rolled: boolean}) => string;
  describeAsOfExclusion: (s: BalanceSheet) => string | null;
  describeNetIncome: (s: IncomeStatement) => string;
  describeIncomeScope: (s: IncomeStatement, o: {truncated: boolean; rolled: boolean; unclassified?: boolean}) => string;
  describeReconciliation: (r: NetIncomeReconciliation) => string;
  describePeriod: (from: string, to: string) => string;
  describeUnclassified: (s: BalanceSheet) => string | null;
  describeCurrentEarnings: (s: BalanceSheet, o?: {truncated?: boolean}) => string;
  describeIncomeUnclassified: (s: IncomeStatement) => string | null;
  latestPeriod: (t: readonly Transaction[]) => {from: string; to: string} | null;
  formatCredit: (minor: number) => string;
  transactionsAsOf: (t: readonly Transaction[], asOf: string) => Transaction[];
  transactionsInRange: (t: readonly Transaction[], from: string, to: string) => Transaction[];
  transactionsBefore: (t: readonly Transaction[], from: string) => Transaction[];
  latestReportedDate: (t: readonly Transaction[]) => string | null;
  startOfYear: (date: string) => string;
  defaultAsOf: () => string;
  defaultPeriod: () => {from: string; to: string};
  parseCollapsed: (raw: string) => Set<string>;
  serializeCollapsed: (paths: ReadonlySet<string>) => string;
  CURRENT_EARNINGS_LABEL: string;
  directPostingsLabel: (label: string) => string;
  HIERARCHY_SEPARATOR: string;
  buildTrialBalance: (a: readonly Account[], t: readonly Transaction[], o?: {includeZero?: boolean}) => {balanced: boolean; differenceMinor: number};
  } {
  return loadLedgerPlugin().exports as unknown as ReturnType<typeof statements>;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * A chart with real depth AND the awkward case: `Expenses` is both a grouping
 * node and an account in its own right, and `Liabilities:Loans:Bank:Term` is
 * four levels deep.
 */
const ACCOUNTS: Account[] = [
  {id: 'a1', name: 'Assets:Bank:Checking', type: 'asset'},
  {id: 'a2', name: 'Assets:Bank:Savings', type: 'asset'},
  {id: 'a3', name: 'Assets:Cash', type: 'asset'},
  {id: 'l1', name: 'Liabilities:CreditCard', type: 'liability'},
  {id: 'l2', name: 'Liabilities:Loans:Bank:Term', type: 'liability'},
  {id: 'e1', name: 'Equity:OpeningBalances', type: 'equity'},
  {id: 'r1', name: 'Income:Revenue:Product', type: 'revenue'},
  {id: 'r2', name: 'Income:Revenue:Services', type: 'revenue'},
  {id: 'x0', name: 'Expenses', type: 'expense'},
  {id: 'x1', name: 'Expenses:Hosting', type: 'expense'},
  {id: 'x2', name: 'Expenses:Hosting:CDN', type: 'expense'},
  {id: 'x3', name: 'Expenses:Office:Supplies', type: 'expense'},
];

let seq = 0;
const posting = (accountId: string, amountMinor: number, cleared: ClearedState = 'pending'): Posting => ({
  id: `p${(seq += 1)}`,
  accountId,
  amountMinor,
  cleared,
});

const tx = (over: Partial<Transaction> & {postings: Posting[]}): Transaction => ({
  id: `t${(seq += 1)}`,
  date: '2026-01-01',
  description: 'entry',
  state: 'posted',
  entryNo: seq,
  ...over,
});

/**
 * A 500-POSTED-ENTRY book spanning a full year, arranged so the statements have
 * something real to say:
 *
 *  · January: 20 opening-balance entries — the ONLY direct equity postings in
 *    the whole book, so any period starting in February has no equity movement
 *    other than earnings (the `cleanPeriod` the reconciliation test needs).
 *  · February–December: 480 trading entries across four shapes, including
 *    three-leg splits whose fees do not divide evenly (an off-by-one-cent split
 *    would break the identity), postings to the parent-that-is-an-account
 *    (`Expenses`), and a four-level-deep liability.
 *  · A mid-year reversal pair (void original + posted reversal): both count and
 *    they cancel, exactly as the server's own balance query treats them.
 *  · Two drafts that do NOT balance — if one ever leaked into a statement, the
 *    identity would fire.
 */
function bigBook(): {transactions: Transaction[]; postedCount: number; draftCount: number} {
  const transactions: Transaction[] = [];
  for (let i = 0; i < 20; i += 1) {
    const day = String((i % 28) + 1).padStart(2, '0');
    const amount = 500000 + i * 13;
    transactions.push(
      tx({date: `2026-01-${day}`, description: `Opening ${i}`, entryNo: i + 1, postings: [posting('a1', amount, 'cleared'), posting('e1', -amount)]}),
    );
  }
  for (let i = 0; i < 480; i += 1) {
    const month = String((i % 11) + 2).padStart(2, '0');
    const day = String((i % 28) + 1).padStart(2, '0');
    const date = `2026-${month}-${day}`;
    const gross = 100003 + i * 7;
    const fee = 1 + (i % 3);
    const entryNo = 100 + i;
    if (i % 4 === 0) {
      transactions.push(tx({date, description: `Sale ${i}`, entryNo, postings: [posting('a1', gross - fee, 'cleared'), posting('x2', fee), posting('r1', -gross)]}));
    } else if (i % 4 === 1) {
      transactions.push(tx({date, description: `Service ${i}`, entryNo, postings: [posting('a2', gross, 'cleared'), posting('r2', -gross)]}));
    } else if (i % 4 === 2) {
      transactions.push(tx({date, description: `Card ${i}`, entryNo, postings: [posting('x1', gross), posting('l1', -gross, 'reconciled')]}));
    } else {
      transactions.push(tx({date, description: `Office ${i}`, entryNo, postings: [posting('x3', gross - fee), posting('x0', fee), posting('l2', -gross)]}));
    }
  }
  const original = tx({date: '2026-06-15', description: 'Mistake', state: 'void', entryNo: 900, postings: [posting('a3', 12345), posting('r1', -12345)]});
  const reversal = tx({date: '2026-06-15', description: 'Reversal of Mistake', state: 'posted', entryNo: 901, postings: [posting('a3', -12345), posting('r1', 12345)]});
  transactions.push(original, reversal);
  const drafts = [
    tx({date: '2026-07-01', description: 'Draft one', state: 'draft', entryNo: null, postings: [posting('a1', 500000)]}),
    tx({date: '2026-07-02', description: 'Draft two', state: 'draft', entryNo: null, postings: [posting('x1', 900), posting('a3', -100)]}),
  ];
  transactions.push(...drafts);
  // 20 opening + 480 trading + the posted half of the reversal pair.
  return {transactions, postedCount: 501, draftCount: drafts.length};
}

/** The three as-of dates the identity is pinned at, including mid-year. */
const AS_OF_DATES = ['2026-01-15', '2026-06-30', '2026-12-31'];

describe('LGR-9 statement folds (real plugin source through the real loader)', () => {
  describe('colon hierarchy rollup', () => {
    it('sums leaves into ancestors at arbitrary depth, and the tree total equals the flat total', () => {
      const {buildHierarchy, hierarchyRolledTotal, hierarchyLeafTotal, hierarchyLeaves} = statements();
      const nodes = buildHierarchy([
        {accountId: 'l2', name: 'Liabilities:Loans:Bank:Term', minor: -400000},
        {accountId: 'l3', name: 'Liabilities:Loans:Bank:Revolving', minor: -150000},
        {accountId: 'l4', name: 'Liabilities:Loans:Shareholder', minor: -25000},
        {accountId: 'l1', name: 'Liabilities:CreditCard', minor: -7500},
      ]);

      expect(nodes).toHaveLength(1);
      const liabilities = nodes[0];
      expect(liabilities.path).toBe('Liabilities');
      expect(liabilities.depth).toBe(0);
      expect(liabilities.accountId).toBeNull(); // a pure grouping node
      expect(liabilities.ownMinor).toBe(0);
      expect(liabilities.rolledMinor).toBe(-582500);
      expect(liabilities.accountCount).toBe(4);

      const loans = liabilities.children.find((c) => c.label === 'Loans')!;
      expect(loans.rolledMinor).toBe(-575000);
      expect(loans.accountCount).toBe(3);
      const bank = loans.children.find((c) => c.label === 'Bank')!;
      expect(bank.depth).toBe(2);
      expect(bank.rolledMinor).toBe(-550000);
      const term = bank.children.find((c) => c.label === 'Term')!;
      expect(term.depth).toBe(3); // four levels deep, arbitrary depth
      expect(term.path).toBe('Liabilities:Loans:Bank:Term');
      expect(term.ownMinor).toBe(-400000);
      expect(term.rolledMinor).toBe(-400000);
      expect(term.children).toHaveLength(0);

      // THE INVARIANT: every account counted exactly once, whichever way you
      // count — through the tree, or straight down the flat list.
      expect(hierarchyRolledTotal(nodes)).toBe(-582500);
      expect(hierarchyLeafTotal(nodes)).toBe(hierarchyRolledTotal(nodes));
      expect(hierarchyLeaves(nodes).map((l) => l.path)).toEqual([
        'Liabilities:CreditCard',
        'Liabilities:Loans:Bank:Revolving',
        'Liabilities:Loans:Bank:Term',
        'Liabilities:Loans:Shareholder',
      ]);
    });

    it('handles a parent that is ALSO a real account — counted once, and split out on its own row', () => {
      const {buildHierarchy, flattenHierarchy, leafRows, hierarchyRolledTotal, hierarchyLeafTotal, directPostingsLabel} = statements();
      const nodes = buildHierarchy([
        {accountId: 'x0', name: 'Expenses', minor: 700},
        {accountId: 'x1', name: 'Expenses:Hosting', minor: 30000},
        {accountId: 'x2', name: 'Expenses:Hosting:CDN', minor: 2500},
      ]);

      const expenses = nodes[0];
      expect(expenses.accountId).toBe('x0');
      expect(expenses.parentIsAccount).toBe(true);
      // Own vs rolled are BOTH available and are different numbers.
      expect(expenses.ownMinor).toBe(700);
      expect(expenses.rolledMinor).toBe(33200);
      expect(expenses.accountCount).toBe(3);
      // A leaf account that gained a child is a parent-account too.
      const hosting = expenses.children[0];
      expect(hosting.parentIsAccount).toBe(true);
      expect(hosting.ownMinor).toBe(30000);
      expect(hosting.rolledMinor).toBe(32500);

      // Counted ONCE: neither dropped (money lost) nor double-counted (section
      // inflated, identity broken).
      expect(hierarchyRolledTotal(nodes)).toBe(33200);
      expect(hierarchyLeafTotal(nodes)).toBe(33200);

      // Expanded, the parent's own money gets its OWN row — the subtotal row and
      // the direct-postings row are two different figures on two different lines.
      const rows = flattenHierarchy(nodes);
      expect(rows.map((r) => [r.label, r.minor, r.kind])).toEqual([
        ['Expenses', 33200, 'node'],
        ['Posted to Expenses itself', 700, 'direct'],
        ['Hosting', 32500, 'node'],
        ['Posted to Hosting itself', 30000, 'direct'],
        ['CDN', 2500, 'node'],
      ]);
      // The visible label is the EXPLANATION, not a term of art — the gloss used
      // to be SrOnly-only, i.e. hidden from everyone who could see the row.
      expect(directPostingsLabel('Hosting')).toBe('Posted to Hosting itself');
      // Keys are namespaced by kind, so a node and its direct row can never
      // collide through a separator an account name might legally contain.
      expect(rows.map((r) => r.key)).toEqual(['node:Expenses', 'direct:Expenses', 'node:Expenses:Hosting', 'direct:Expenses:Hosting', 'node:Expenses:Hosting:CDN']);
      expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);

      // The flat, accounts-only view: same money, no grouping rows at all.
      expect(leafRows(nodes).map((r) => [r.label, r.minor])).toEqual([
        ['Expenses', 700],
        ['Expenses:Hosting', 30000],
        ['Expenses:Hosting:CDN', 2500],
      ]);
      expect(sumAmounts(leafRows(nodes).map((r) => r.minor))).toBe(hierarchyRolledTotal(nodes));
    });

    it('collapsing a parent hides its subtree but never changes its subtotal', () => {
      const {buildHierarchy, flattenHierarchy, hierarchyParentPaths} = statements();
      const nodes = buildHierarchy([
        {accountId: 'x0', name: 'Expenses', minor: 700},
        {accountId: 'x1', name: 'Expenses:Hosting', minor: 30000},
        {accountId: 'x2', name: 'Expenses:Hosting:CDN', minor: 2500},
        {accountId: 'x3', name: 'Expenses:Office:Supplies', minor: 4000},
      ]);

      expect(hierarchyParentPaths(nodes).sort()).toEqual(['Expenses', 'Expenses:Hosting', 'Expenses:Office']);

      const open = flattenHierarchy(nodes);
      const shut = flattenHierarchy(nodes, new Set(['Expenses']));
      expect(shut.map((r) => r.label)).toEqual(['Expenses']);
      expect(shut[0].collapsed).toBe(true);
      expect(shut[0].hasChildren).toBe(true);
      expect(shut[0].accountCount).toBe(4);
      // The FIGURE is identical open or shut — expanding is a disclosure, never
      // a recomputation.
      expect(shut[0].minor).toBe(open[0].minor);
      expect(shut[0].minor).toBe(37200);

      // A partly-open tree: only the named subtree closes.
      const partial = flattenHierarchy(nodes, new Set(['Expenses:Hosting']));
      expect(partial.map((r) => r.label)).toEqual(['Expenses', 'Posted to Expenses itself', 'Hosting', 'Office', 'Supplies']);
      expect(partial.find((r) => r.label === 'Hosting')!.minor).toBe(32500);
      // Collapsing a path that is not a parent is a no-op, not a hidden row.
      expect(flattenHierarchy(nodes, new Set(['Expenses:Office:Supplies'])).map((r) => r.label)).toEqual(open.map((r) => r.label));
    });

    it('parses odd account names without losing their money', () => {
      const {splitAccountPath, buildHierarchy, hierarchyRolledTotal, HIERARCHY_SEPARATOR} = statements();
      expect(HIERARCHY_SEPARATOR).toBe(':');
      expect(splitAccountPath('Expenses:Hosting')).toEqual(['Expenses', 'Hosting']);
      expect(splitAccountPath('Assets: Bank :Checking')).toEqual(['Assets', 'Bank', 'Checking']);
      expect(splitAccountPath('Expenses:')).toEqual(['Expenses']);
      expect(splitAccountPath('Cash')).toEqual(['Cash']);
      expect(splitAccountPath('::')).toEqual(['::']);
      expect(splitAccountPath('')).toEqual(['(unnamed account)']);

      // Whatever the names look like, the section total is the sum of the inputs.
      const nodes = buildHierarchy([
        {accountId: 'a', name: '', minor: 100},
        {accountId: 'b', name: '::', minor: 200},
        {accountId: 'c', name: 'Expenses:', minor: 400},
        {accountId: 'd', name: 'Expenses:Hosting', minor: 800},
      ]);
      expect(hierarchyRolledTotal(nodes)).toBe(1500);

      // Two accounts sharing one name collapse into one node — the money is
      // summed, never silently dropped.
      const duplicates = buildHierarchy([
        {accountId: 'z9', name: 'Assets:Cash', minor: 300},
        {accountId: 'z1', name: 'Assets:Cash', minor: 700},
      ]);
      expect(hierarchyRolledTotal(duplicates)).toBe(1000);
      expect(duplicates[0].children[0].accountId).toBe('z1');
    });

    it('an empty section is an empty tree, not a crash', () => {
      const {buildHierarchy, flattenHierarchy, leafRows, hierarchyRolledTotal} = statements();
      expect(buildHierarchy([])).toEqual([]);
      expect(flattenHierarchy([])).toEqual([]);
      expect(leafRows([])).toEqual([]);
      expect(hierarchyRolledTotal([])).toBe(0);
    });
  });

  describe('balance sheet', () => {
    it('balances (A = L + E) on the 500-entry book at three as-of dates, including mid-year', () => {
      const {buildBalanceSheet, describeBalanceSheetAssertion} = statements();
      const {transactions, postedCount, draftCount} = bigBook();

      for (const asOf of AS_OF_DATES) {
        const sheet = buildBalanceSheet(ACCOUNTS, transactions, {asOf});
        expect(sheet.asOf).toBe(asOf);
        expect(sheet.differenceMinor).toBe(0);
        expect(sheet.balanced).toBe(true);
        // Not trivially zero on both sides — there is real money in here.
        expect(sheet.totalAssetsMinor).toBeGreaterThan(0);
        expect(sheet.liabilitiesAndEquityMinor).toBeLessThan(0);
        // The identity, stated as an equality of magnitudes on opposite sides.
        expect(sumAmounts([sheet.totalAssetsMinor, sheet.liabilitiesAndEquityMinor])).toBe(0);
        // Equity is the ACCOUNTS plus the computed current earnings.
        expect(sumAmounts([sheet.equity.totalMinor, sheet.currentEarningsMinor])).toBe(sheet.totalEquityMinor);
        // Every figure is an exact integer of minor units.
        expect(Number.isSafeInteger(sheet.totalAssetsMinor)).toBe(true);
        expect(Number.isSafeInteger(sheet.totalEquityMinor)).toBe(true);

        const assertion = describeBalanceSheetAssertion(sheet);
        expect(assertion.ok).toBe(true);
        expect(assertion.text).toMatch(/^Balances — assets [\d,]+\.\d\d Dr = liabilities \+ equity [\d,]+\.\d\d Cr ✓$/);
        expect(assertion.culprits).toBeNull();
        expect(assertion.unclassified).toBeNull();
      }

      // The three dates are genuinely different positions, not the same book
      // three times — mid-year is strictly between the other two.
      const [early, mid, late] = AS_OF_DATES.map((asOf) => buildBalanceSheet(ACCOUNTS, transactions, {asOf}));
      expect(early.totalAssetsMinor).toBeLessThan(mid.totalAssetsMinor);
      expect(mid.totalAssetsMinor).toBeLessThan(late.totalAssetsMinor);
      expect(early.postingCount).toBeLessThan(mid.postingCount);
      // Mid-year has not seen the whole book, and says how much it is holding back.
      expect(mid.afterCount).toBeGreaterThan(0);
      expect(late.afterCount).toBe(0);

      // Drafts out, posted AND void in.
      expect(late.draftCount).toBe(draftCount);
      expect(late.postedCount).toBe(postedCount);
      expect(late.voidCount).toBe(1);

      // The whole book, with no as-of at all, balances too.
      expect(buildBalanceSheet(ACCOUNTS, transactions).balanced).toBe(true);
      expect(buildBalanceSheet(ACCOUNTS, transactions).afterCount).toBe(0);
    });

    it('agrees with the trial balance: both are the statement that every entry sums to zero', () => {
      const {buildBalanceSheet, buildTrialBalance} = statements();
      const {transactions} = bigBook();
      const sheet = buildBalanceSheet(ACCOUNTS, transactions, {asOf: '2026-12-31'});
      const tb = buildTrialBalance(ACCOUNTS, transactions);
      expect(tb.balanced).toBe(true);
      expect(sheet.balanced).toBe(true);
      // Σ over every section (including revenue/expenses, folded into equity as
      // current earnings) is the trial balance's own difference.
      expect(sumAmounts([sheet.totalAssetsMinor, sheet.liabilitiesAndEquityMinor])).toBe(tb.differenceMinor);
    });

    it('rolls the hierarchy up inside each section, at depth, with leaf and rolled both available', () => {
      const {buildBalanceSheet, hierarchyRolledTotal, hierarchyLeafTotal, flattenHierarchy, leafRows} = statements();
      const {transactions} = bigBook();
      const sheet = buildBalanceSheet(ACCOUNTS, transactions, {asOf: '2026-12-31'});

      // Assets: `Assets` groups `Bank` (which groups two accounts) and `Cash`.
      const assets = sheet.assets.nodes[0];
      expect(assets.path).toBe('Assets');
      expect(assets.accountCount).toBe(3);
      const bank = assets.children.find((c) => c.label === 'Bank')!;
      expect(bank.accountCount).toBe(2);
      expect(bank.rolledMinor).toBe(sumAmounts(bank.children.map((c) => c.rolledMinor)));

      // Four levels deep on the liability side.
      const loanTerm = sheet.liabilities.nodes[0].children.find((c) => c.label === 'Loans')!.children[0].children[0];
      expect(loanTerm.path).toBe('Liabilities:Loans:Bank:Term');
      expect(loanTerm.depth).toBe(3);

      // Both views of every section total the same, and match the section total.
      for (const s of [sheet.assets, sheet.liabilities, sheet.equity]) {
        expect(hierarchyRolledTotal(s.nodes)).toBe(s.totalMinor);
        expect(hierarchyLeafTotal(s.nodes)).toBe(s.totalMinor);
        expect(sumAmounts(leafRows(s.nodes).map((r) => r.minor))).toBe(s.totalMinor);
        // The rolled view's ROOT rows also total the section (nested rows are
        // already inside their parents' subtotals and must not be re-added).
        expect(sumAmounts(flattenHierarchy(s.nodes).filter((r) => r.depth === 0).map((r) => r.minor))).toBe(s.totalMinor);
      }
    });

    it('AS-OF is inclusive on the boundary date and excludes the day after — asserted at both ends', () => {
      const {buildBalanceSheet, transactionsAsOf, describeAsOfExclusion} = statements();
      const book: Transaction[] = [
        tx({date: '2026-03-30', description: 'Before', entryNo: 1, postings: [posting('a1', 1000), posting('e1', -1000)]}),
        tx({date: '2026-03-31', description: 'ON the boundary', entryNo: 2, postings: [posting('a1', 2000), posting('e1', -2000)]}),
        tx({date: '2026-04-01', description: 'The day after', entryNo: 3, postings: [posting('a1', 4000), posting('e1', -4000)]}),
      ];

      // The boundary posting IS in the position…
      const onBoundary = buildBalanceSheet(ACCOUNTS, book, {asOf: '2026-03-31'});
      expect(onBoundary.totalAssetsMinor).toBe(3000);
      expect(onBoundary.afterCount).toBe(1);
      expect(describeAsOfExclusion(onBoundary)).toBe('1 posted entry is dated after 2026-03-31 and excluded from this position.');
      // …and the day after is NOT.
      expect(onBoundary.postingCount).toBe(4);

      // One day earlier drops the boundary entry: the bound moved, not the data.
      const dayBefore = buildBalanceSheet(ACCOUNTS, book, {asOf: '2026-03-30'});
      expect(dayBefore.totalAssetsMinor).toBe(1000);
      expect(dayBefore.afterCount).toBe(2);
      expect(describeAsOfExclusion(dayBefore)).toBe('2 posted entries are dated after 2026-03-30 and excluded from this position.');

      // One day later picks the next one up, and nothing is held back.
      const dayAfter = buildBalanceSheet(ACCOUNTS, book, {asOf: '2026-04-01'});
      expect(dayAfter.totalAssetsMinor).toBe(7000);
      expect(dayAfter.afterCount).toBe(0);
      expect(describeAsOfExclusion(dayAfter)).toBeNull();

      // The scoping primitive itself, at both ends.
      expect(transactionsAsOf(book, '2026-03-31').map((t) => t.description)).toEqual(['Before', 'ON the boundary']);
      expect(transactionsAsOf(book, '2026-03-30').map((t) => t.description)).toEqual(['Before']);
      expect(transactionsAsOf(book, '').map((t) => t.description)).toHaveLength(3);
      // Every as-of date balances — the identity is not a property of the whole
      // book, it holds at every instant of it.
      for (const asOf of ['2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02']) {
        expect(buildBalanceSheet(ACCOUNTS, book, {asOf}).balanced).toBe(true);
      }
    });

    it('fires the identity LOUDLY on a deliberately damaged book, and names the entries responsible', () => {
      const {buildBalanceSheet, describeBalanceSheetAssertion} = statements();
      const {transactions} = bigBook();

      // Damage: two mid-year entries lose a leg — the shape an edited/lost
      // posting row leaves behind. The server cannot produce this; a damaged
      // table can.
      const damaged = transactions.map((t) =>
        t.description === 'Sale 100'
          ? {...t, postings: t.postings.filter((p) => p.accountId !== 'r1')}
          : t.description === 'Card 102'
            ? {...t, postings: t.postings.filter((p) => p.accountId !== 'l1')}
            : t,
      );
      const sheet = buildBalanceSheet(ACCOUNTS, damaged, {asOf: '2026-12-31'});

      expect(sheet.balanced).toBe(false);
      expect(sheet.differenceMinor).not.toBe(0);
      const assertion = describeBalanceSheetAssertion(sheet);
      expect(assertion.ok).toBe(false);
      expect(assertion.text).toContain('THE BALANCE SHEET DOES NOT BALANCE');
      // It says what it MEANS — damaged data — not "something went wrong".
      expect(assertion.text).toMatch(/missing or damaged/);
      // …and it names the next step: WHICH entries, on what date, by how much.
      expect(assertion.culprits).toContain('Sale 100');
      expect(assertion.culprits).toContain('Card 102');
      expect(sheet.unbalancedEntries).toHaveLength(2);
      expect(assertion.unclassified).toBeNull();

      // The other side of the sentence reads the other way round.
      const other = buildBalanceSheet(ACCOUNTS, [tx({description: 'Lost debit leg', entryNo: 5, postings: [posting('e1', -175)]})], {asOf: '2026-12-31'});
      expect(other.differenceMinor).toBe(-175);
      expect(describeBalanceSheetAssertion(other).text).toContain('liabilities + equity exceed assets by 1.75');
      const oneWay = buildBalanceSheet(ACCOUNTS, [tx({description: 'Lost credit leg', entryNo: 6, postings: [posting('a1', 2550)]})], {asOf: '2026-12-31'});
      expect(describeBalanceSheetAssertion(oneWay).text).toContain('assets exceed liabilities + equity by 25.50');

      // A damaged entry dated AFTER the as-of date cannot break an earlier
      // position — the report is only responsible for what it is showing.
      const later = buildBalanceSheet(ACCOUNTS, damaged, {asOf: '2026-01-31'});
      expect(later.balanced).toBe(true);
    });

    it('discloses balances on deleted accounts instead of folding them into a side it cannot know', () => {
      const {buildBalanceSheet, describeBalanceSheetAssertion, describeUnclassified} = statements();
      const book = [
        tx({description: 'Good', entryNo: 1, postings: [posting('a1', 10000), posting('e1', -10000)]}),
        tx({description: 'Ghost', entryNo: 2, postings: [posting('ghost', 700), posting('e1', -700)]}),
      ];
      const sheet = buildBalanceSheet(ACCOUNTS, book, {asOf: '2026-12-31'});

      // Every entry balances, so nobody is a culprit — but the identity STILL
      // fails, because 7.00 belongs to no asset, liability or equity line.
      expect(sheet.unbalancedEntries).toEqual([]);
      expect(sheet.unclassifiedMinor).toBe(700);
      expect(sheet.unknownAccountIds).toEqual(['ghost']);
      expect(sheet.unclassified.accountCount).toBe(1);
      expect(sheet.unclassified.nodes[0].label).toBe('Deleted account (ghost)');
      expect(sheet.balanced).toBe(false);
      expect(sheet.differenceMinor).toBe(-700);

      const assertion = describeBalanceSheetAssertion(sheet);
      expect(assertion.ok).toBe(false);
      expect(assertion.culprits).toBeNull(); // no entry is at fault
      expect(assertion.unclassified).toContain('1 account was deleted');
      expect(assertion.unclassified).toContain('7.00 Dr');
      expect(assertion.unclassified).toContain('NOT in the identity above');
      expect(describeUnclassified(sheet)).toBe(assertion.unclassified);
      // A healthy book names no cause at all.
      expect(describeUnclassified(buildBalanceSheet(ACCOUNTS, [book[0]], {asOf: '2026-12-31'}))).toBeNull();
    });

    it('names a damaged chart even when the stranded postings net to zero', () => {
      const {buildBalanceSheet, describeBalanceSheetAssertion, describeUnclassified} = statements();
      // ONE compound entry across TWO deleted accounts. It balances, the stranded
      // money nets to zero, and the identity is satisfied — so gating the
      // disclosure on the AMOUNT printed a green ✓ over a chart that has lost two
      // rows. It is gated on accounts MISSING instead.
      const book = [tx({description: 'Both legs stranded', entryNo: 1, postings: [posting('ghostA', 5000), posting('ghostB', -5000)]})];
      const sheet = buildBalanceSheet(ACCOUNTS, book, {asOf: '2026-12-31'});

      expect(sheet.balanced).toBe(true);
      expect(sheet.unclassifiedMinor).toBe(0);
      expect(sheet.unknownAccountIds).toEqual(['ghostA', 'ghostB']);
      expect(sheet.unclassified.accountCount).toBe(2);

      const assertion = describeBalanceSheetAssertion(sheet);
      expect(assertion.ok).toBe(true); // the identity really does hold
      expect(assertion.unclassified).toContain('2 accounts were deleted');
      expect(assertion.unclassified).toContain('net to 0.00');
      expect(assertion.unclassified).toContain('the chart of accounts is damaged');
      expect(describeUnclassified(sheet)).toBe(assertion.unclassified);
    });

    it('explains why the named causes do not add up to the headline difference', () => {
      const {buildBalanceSheet, describeBalanceSheetAssertion} = statements();
      // Both causes at once: an entry out by 250.00 Dr, and 700.00 Dr stranded
      // and EXCLUDED — so the difference is 450.00 Cr, not 950.00 Dr. A reader
      // who tries that sum and fails concludes the report cannot add.
      const book = [
        tx({date: '2026-03-04', description: 'Invoice 0041', entryNo: 41, postings: [posting('a1', 25000)]}),
        tx({date: '2026-04-10', description: 'Stranded', entryNo: 60, postings: [posting('ghost', 70000), posting('r1', -70000)]}),
      ];
      const sheet = buildBalanceSheet(ACCOUNTS, book, {asOf: '2026-12-31'});
      expect(sheet.differenceMinor).toBe(-45000);

      const assertion = describeBalanceSheetAssertion(sheet);
      expect(assertion.text).toContain('liabilities + equity exceed assets by 450.00');
      expect(assertion.culprits).toContain('is out by 250.00 Dr');
      expect(assertion.unclassified).toContain('not meant to add up');
      expect(assertion.unclassified).toContain('out by 250.00 Dr');
      expect(assertion.unclassified).toContain('to 450.00 Cr');
    });

    it('a ✓ over a truncated read says what it is worth — and what it is not', () => {
      const {buildBalanceSheet, describeBalanceSheetAssertion} = statements();
      const {transactions} = bigBook();
      const sheet = buildBalanceSheet(ACCOUNTS, transactions, {asOf: '2026-12-31'});
      expect(sheet.balanced).toBe(true);

      // Untruncated: the bare, earned ✓.
      const whole = describeBalanceSheetAssertion(sheet, {truncated: false});
      expect(whole.text).toMatch(/✓$/);
      expect(whole.text).not.toContain('PARTIAL');

      // Truncated: ANY subset of balanced entries balances, so the ✓ is
      // uninformative — and this is the line a reader screenshots as proof.
      const partial = describeBalanceSheetAssertion(sheet, {truncated: true});
      expect(partial.ok).toBe(true);
      expect(partial.text).toContain('PARTIAL READ ONLY');
      expect(partial.text).toContain('not evidence that the whole book does');

      // The failing branch says it too, rather than implying the difference is final.
      const damaged = buildBalanceSheet(ACCOUNTS, [tx({description: 'Lost leg', entryNo: 9, postings: [posting('a1', 2550)]})], {asOf: '2026-12-31'});
      expect(describeBalanceSheetAssertion(damaged, {truncated: true}).text).toContain('may be larger still');
      expect(describeBalanceSheetAssertion(damaged, {truncated: false}).text).not.toContain('may be larger still');
    });

    it('the computed equity line states the SPAN it covers, not a period it does not have', () => {
      const {buildBalanceSheet, describeCurrentEarnings, CURRENT_EARNINGS_LABEL} = statements();
      const {transactions} = bigBook();
      // "Current earnings" is a period word and this figure has no period: it
      // sums from the first posted entry with no fiscal reset until LGR-12, so on
      // a multi-year book it is years of accumulated earnings.
      const sheet = buildBalanceSheet(ACCOUNTS, transactions, {asOf: '2026-06-30'});
      const note = describeCurrentEarnings(sheet);
      expect(note).toBe('Revenue less expenses from the first posted entry through 2026-06-30 — not an account; nothing has been closed to retained earnings.');
      expect(describeCurrentEarnings(buildBalanceSheet(ACCOUNTS, transactions))).toContain('through the last posted entry');
      // TRUNCATED: the entries a partial read drops are precisely the OLDEST
      // ones, so "from the first posted entry" is the one claim about this span
      // it cannot make — the same reasoning that made the identity's ✓
      // truncation-aware, applied to the span beside it.
      const partial = describeCurrentEarnings(sheet, {truncated: true});
      expect(partial).toBe('Revenue less expenses from the earliest entry in this partial read through 2026-06-30 — not an account; nothing has been closed to retained earnings.');
      expect(partial).not.toContain('from the first posted entry');
      expect(note).not.toContain('partial read');
      expect(describeCurrentEarnings(sheet, {truncated: false})).toBe(note);
      // The row is still distinguishable from the real `Equity:RetainedEarnings`
      // account the starter chart ships.
      expect(CURRENT_EARNINGS_LABEL).not.toContain('Retained');
    });

    it('captions honestly — the scope sentence never claims more than the read supports', () => {
      const {buildBalanceSheet, describeBalanceSheetScope} = statements();
      const {transactions} = bigBook();
      const sheet = buildBalanceSheet(ACCOUNTS, transactions, {asOf: '2026-06-30'});

      expect(describeBalanceSheetScope(sheet, {truncated: false, rolled: true})).toContain('Rolled up by account hierarchy as at 2026-06-30');
      expect(describeBalanceSheetScope(sheet, {truncated: false, rolled: false})).toContain('Every account name, ungrouped');
      // Truncated: it must NOT say "all postings", and must say what is missing.
      const truncated = describeBalanceSheetScope(sheet, {truncated: true, rolled: true});
      expect(truncated).toContain('NOT the whole book');
      expect(truncated).not.toContain('from all ');
      // No as-of date at all reads as the whole book, not as "as at ".
      const wholeBook = describeBalanceSheetScope(buildBalanceSheet(ACCOUNTS, transactions), {truncated: false, rolled: true});
      expect(wholeBook).toContain('across the whole book');
      // …and it must not then refer to a date it never named. "on or before that
      // date" left "that date" pointing at nothing.
      expect(wholeBook).not.toContain('that date');
      expect(wholeBook).toContain('posted postings in the book');
      expect(describeBalanceSheetScope(sheet, {truncated: false, rolled: true})).toContain('on or before that date');
    });

    it('reports an empty book as empty, not as a broken one', () => {
      const {buildBalanceSheet, describeBalanceSheetAssertion} = statements();
      const empty = buildBalanceSheet(ACCOUNTS, [], {asOf: '2026-12-31'});
      expect(empty.postingCount).toBe(0);
      expect(empty.balanced).toBe(true);
      expect(empty.totalAssetsMinor).toBe(0);
      expect(describeBalanceSheetAssertion(empty).ok).toBe(true);
      expect(buildBalanceSheet([], []).balanced).toBe(true);
      // A book of nothing BUT drafts is still an empty position.
      const draftsOnly = buildBalanceSheet(ACCOUNTS, [tx({state: 'draft', entryNo: null, postings: [posting('a1', 99999)]})], {asOf: '2026-12-31'});
      expect(draftsOnly.totalAssetsMinor).toBe(0);
      expect(draftsOnly.draftCount).toBe(1);
      expect(draftsOnly.balanced).toBe(true);
    });

    it('never puts a ✓ over a read of ZERO postings — nothing balances vacuously', () => {
      const {buildBalanceSheet, describeBalanceSheetAssertion} = statements();
      // The degenerate limit of the truncated-✓ case above: no entries trivially
      // satisfy the identity, so "assets 0.00 = liabilities + equity 0.00 ✓" is a
      // certificate of soundness issued over a read of nothing — and it sits
      // directly above the empty state that says nothing was posted at all. The
      // today-default makes this the OPENING state of any future-dated book.
      const empty = describeBalanceSheetAssertion(buildBalanceSheet(ACCOUNTS, [], {asOf: '2026-08-02'}));
      expect(empty.text).not.toContain('✓');
      expect(empty.text).toBe('Nothing to balance — no posted entries on or before 2026-08-02.');
      // Not an alarm either: an empty position is empty, not damaged.
      expect(empty.ok).toBe(true);
      expect(empty.culprits).toBeNull();
      // Truncation cannot turn nothing into a ✓ by the other door.
      expect(describeBalanceSheetAssertion(buildBalanceSheet(ACCOUNTS, [], {asOf: '2026-08-02'}), {truncated: true}).text).not.toContain('✓');
      // No as-of date at all: still nothing to balance, and no date named that
      // the sheet never had.
      const wholeBook = describeBalanceSheetAssertion(buildBalanceSheet(ACCOUNTS, []));
      expect(wholeBook.text).toBe('Nothing to balance — no posted entries in this book.');
      // Drafts are not posted: a book of nothing but drafts is still nothing to balance.
      const draftsOnly = buildBalanceSheet(ACCOUNTS, [tx({state: 'draft', entryNo: null, postings: [posting('a1', 99999)]})], {asOf: '2026-12-31'});
      expect(draftsOnly.postingCount).toBe(0);
      expect(describeBalanceSheetAssertion(draftsOnly).text).not.toContain('✓');
      // …and a book with real postings still earns the ✓ it always did.
      const real = buildBalanceSheet(ACCOUNTS, bigBook().transactions, {asOf: '2026-12-31'});
      expect(real.postingCount).toBeGreaterThan(0);
      expect(describeBalanceSheetAssertion(real).text).toMatch(/✓$/);
    });
  });

  describe('income statement', () => {
    it('totals revenue and expenses over a period, with a net income that is revenue less expenses', () => {
      const {buildIncomeStatement, describeNetIncome, describePeriod} = statements();
      const {transactions} = bigBook();
      const statement = buildIncomeStatement(ACCOUNTS, transactions, {from: '2026-04-01', to: '2026-09-30'});

      expect(statement.from).toBe('2026-04-01');
      expect(statement.to).toBe('2026-09-30');
      // Revenue is credit-normal (negative debit-positive), expenses debit-normal.
      expect(statement.totalRevenueMinor).toBeLessThan(0);
      expect(statement.totalExpensesMinor).toBeGreaterThan(0);
      // Net income is the CREDIT-positive bottom line, and its debit-positive
      // twin is the exact negation (the view never re-signs).
      expect(statement.netIncomeMinor).toBe(negateAmount(statement.netIncomeDebitMinor));
      expect(statement.netIncomeDebitMinor).toBe(sumAmounts([statement.totalRevenueMinor, statement.totalExpensesMinor]));
      expect(Number.isSafeInteger(statement.netIncomeMinor)).toBe(true);
      expect(statement.profit).toBe(statement.netIncomeMinor >= 0);
      expect(statement.draftCount).toBe(2);
      expect(statement.outsideCount).toBeGreaterThan(0);

      expect(describePeriod('2026-04-01', '2026-09-30')).toBe('from 2026-04-01 to 2026-09-30');
      expect(describePeriod('', '')).toBe('across the whole book');
      expect(describePeriod('2026-01-01', '')).toBe('from 2026-01-01 onwards');
      expect(describePeriod('', '2026-01-01')).toBe('up to 2026-01-01');

      // A profit and a loss read as different sentences, never as a signed number.
      const profitable = buildIncomeStatement(ACCOUNTS, [tx({date: '2026-05-01', entryNo: 1, postings: [posting('a1', 30000), posting('r1', -30000)]})], {from: '2026-01-01', to: '2026-12-31'});
      expect(profitable.netIncomeMinor).toBe(30000);
      expect(describeNetIncome(profitable)).toBe('Net profit of 300.00 from 2026-01-01 to 2026-12-31.');
      const lossy = buildIncomeStatement(ACCOUNTS, [tx({date: '2026-05-01', entryNo: 1, postings: [posting('x1', 4500), posting('a1', -4500)]})], {from: '2026-01-01', to: '2026-12-31'});
      expect(lossy.netIncomeMinor).toBe(-4500);
      expect(lossy.profit).toBe(false);
      expect(describeNetIncome(lossy)).toBe('NET LOSS of 45.00 from 2026-01-01 to 2026-12-31.');
      // Break-even is neither, and says so.
      const flat = buildIncomeStatement(ACCOUNTS, [tx({date: '2026-05-01', entryNo: 1, postings: [posting('x1', 1000), posting('r1', -1000)]})], {from: '2026-01-01', to: '2026-12-31'});
      expect(flat.netIncomeMinor).toBe(0);
      expect(describeNetIncome(flat)).toContain('Broke even');
    });

    it('the period is inclusive at BOTH ends', () => {
      const {buildIncomeStatement, transactionsInRange} = statements();
      const book: Transaction[] = [
        tx({date: '2026-02-28', description: 'Day before', entryNo: 1, postings: [posting('a1', 1000), posting('r1', -1000)]}),
        tx({date: '2026-03-01', description: 'ON the from bound', entryNo: 2, postings: [posting('a1', 2000), posting('r1', -2000)]}),
        tx({date: '2026-03-31', description: 'ON the to bound', entryNo: 3, postings: [posting('a1', 4000), posting('r1', -4000)]}),
        tx({date: '2026-04-01', description: 'Day after', entryNo: 4, postings: [posting('a1', 8000), posting('r1', -8000)]}),
      ];

      const march = buildIncomeStatement(ACCOUNTS, book, {from: '2026-03-01', to: '2026-03-31'});
      // Both boundary entries are IN; both neighbours are OUT.
      expect(march.netIncomeMinor).toBe(6000);
      expect(march.outsideCount).toBe(2);
      expect(transactionsInRange(book, '2026-03-01', '2026-03-31').map((t) => t.description)).toEqual(['ON the from bound', 'ON the to bound']);

      // Move each bound by one day and watch exactly one entry cross it.
      expect(buildIncomeStatement(ACCOUNTS, book, {from: '2026-03-02', to: '2026-03-31'}).netIncomeMinor).toBe(4000);
      expect(buildIncomeStatement(ACCOUNTS, book, {from: '2026-03-01', to: '2026-03-30'}).netIncomeMinor).toBe(2000);
      expect(buildIncomeStatement(ACCOUNTS, book, {from: '2026-02-28', to: '2026-03-31'}).netIncomeMinor).toBe(7000);
      expect(buildIncomeStatement(ACCOUNTS, book, {from: '2026-03-01', to: '2026-04-01'}).netIncomeMinor).toBe(14000);
      // Open-ended either way, and open at both ends.
      expect(buildIncomeStatement(ACCOUNTS, book, {from: '2026-03-01'}).netIncomeMinor).toBe(14000);
      expect(buildIncomeStatement(ACCOUNTS, book, {to: '2026-03-01'}).netIncomeMinor).toBe(3000);
      expect(buildIncomeStatement(ACCOUNTS, book).netIncomeMinor).toBe(15000);
      expect(buildIncomeStatement(ACCOUNTS, book).outsideCount).toBe(0);
    });

    it('rolls revenue and expenses up the hierarchy, including the parent-that-is-an-account', () => {
      const {buildIncomeStatement, hierarchyRolledTotal, hierarchyLeafTotal, flattenHierarchy, leafRows} = statements();
      const {transactions} = bigBook();
      const statement = buildIncomeStatement(ACCOUNTS, transactions, {from: '2026-02-01', to: '2026-12-31'});

      // `Expenses` is an account AND the parent of Hosting/Office.
      const expenses = statement.expenses.nodes[0];
      expect(expenses.path).toBe('Expenses');
      expect(expenses.parentIsAccount).toBe(true);
      expect(expenses.ownMinor).toBeGreaterThan(0);
      expect(expenses.rolledMinor).toBeGreaterThan(expenses.ownMinor);
      expect(expenses.accountCount).toBe(4);

      // Revenue nests two levels: Income → Revenue → {Product, Services}.
      const revenue = statement.revenue.nodes[0];
      expect(revenue.path).toBe('Income');
      expect(revenue.children[0].path).toBe('Income:Revenue');
      expect(revenue.children[0].children.map((c) => c.label)).toEqual(['Product', 'Services']);

      for (const s of [statement.revenue, statement.expenses]) {
        expect(hierarchyRolledTotal(s.nodes)).toBe(s.totalMinor);
        expect(hierarchyLeafTotal(s.nodes)).toBe(s.totalMinor);
        expect(sumAmounts(leafRows(s.nodes).map((r) => r.minor))).toBe(s.totalMinor);
      }
      // Expanded, the parent's own postings are on their own row and are NOT
      // added again to the section total.
      const rows = flattenHierarchy(statement.expenses.nodes);
      const direct = rows.find((r) => r.kind === 'direct')!;
      expect(direct.path).toBe('Expenses');
      expect(direct.minor).toBe(expenses.ownMinor);
      expect(sumAmounts(rows.filter((r) => r.depth === 0).map((r) => r.minor))).toBe(statement.expenses.totalMinor);
    });

    it('excludes drafts and says what the period is holding back', () => {
      const {buildIncomeStatement, describeIncomeScope} = statements();
      const book: Transaction[] = [
        tx({date: '2026-05-01', description: 'Real', entryNo: 1, postings: [posting('a1', 30000), posting('r1', -30000)]}),
        tx({date: '2026-05-02', description: 'Draft', state: 'draft', entryNo: null, postings: [posting('a1', 999999), posting('r1', -999999)]}),
        tx({date: '2026-11-01', description: 'Later', entryNo: 2, postings: [posting('a1', 100), posting('r1', -100)]}),
      ];
      const statement = buildIncomeStatement(ACCOUNTS, book, {from: '2026-05-01', to: '2026-05-31'});
      expect(statement.netIncomeMinor).toBe(30000); // the draft's 9,999.99 is nowhere
      expect(statement.draftCount).toBe(1);
      expect(statement.outsideCount).toBe(1);
      expect(statement.transactionCount).toBe(1);
      expect(statement.postingCount).toBe(1); // revenue/expense legs only

      expect(describeIncomeScope(statement, {truncated: false, rolled: true})).toContain('Revenue and expenses rolled up by account hierarchy from 2026-05-01 to 2026-05-31');
      expect(describeIncomeScope(statement, {truncated: false, rolled: false})).toContain('Every revenue and expense account name, ungrouped');
      expect(describeIncomeScope(statement, {truncated: true, rolled: true})).toContain('NOT the whole book');
    });

    it('never claims completeness that deleted-account balances deny', () => {
      const {buildIncomeStatement, describeIncomeScope, describeIncomeUnclassified} = statements();
      // `postingCount` counts only postings on accounts that still EXIST, so
      // money on a deleted revenue account is out of Total revenue, out of Total
      // expenses AND out of net income. "all N postings in the period" would be
      // a completeness claim over figures that are short.
      const book: Transaction[] = [
        tx({date: '2026-05-01', description: 'Known', entryNo: 1, postings: [posting('a1', 30000), posting('r1', -30000)]}),
        tx({date: '2026-05-02', description: 'Stranded revenue', entryNo: 2, postings: [posting('a1', 4000), posting('ghost', -4000)]}),
      ];
      const statement = buildIncomeStatement(ACCOUNTS, book, {from: '2026-05-01', to: '2026-05-31'});
      expect(statement.unclassifiedMinor).toBe(-4000);
      expect(statement.unknownAccountIds).toEqual(['ghost']);
      // The 40.00 is in NEITHER total nor in net income.
      expect(statement.totalRevenueMinor).toBe(-30000);
      expect(statement.netIncomeMinor).toBe(30000);

      const caption = describeIncomeScope(statement, {truncated: false, rolled: true, unclassified: true});
      expect(caption).toContain('that still have an account — NOT every posting in the period');
      expect(caption).not.toContain('from all ');
      // Truncation is the louder caveat and still wins the clause.
      expect(describeIncomeScope(statement, {truncated: true, rolled: true, unclassified: true})).toContain('NOT the whole book');
      // …and an intact chart is captioned exactly as before.
      expect(describeIncomeScope(statement, {truncated: false, rolled: true, unclassified: false})).toContain('from all ');

      // The notice says what it costs THESE figures, not just the tie.
      const notice = describeIncomeUnclassified(statement) as string;
      expect(notice).toContain('40.00 Cr');
      expect(notice).toContain('excluded from Total revenue, Total expenses AND net income');
      // Intact chart, no notice.
      expect(describeIncomeUnclassified(buildIncomeStatement(ACCOUNTS, [book[0]], {from: '2026-05-01', to: '2026-05-31'}))).toBeNull();
      // Deleted accounts whose postings net to zero are still named.
      const netted = buildIncomeStatement(ACCOUNTS, [tx({date: '2026-05-03', entryNo: 3, postings: [posting('ghostA', 900), posting('ghostB', -900)]})], {from: '2026-05-01', to: '2026-05-31'});
      expect(netted.unclassifiedMinor).toBe(0);
      expect(describeIncomeUnclassified(netted)).toContain('2 deleted accounts');
    });
  });

  describe('net income ⇄ equity reconciliation', () => {
    it('net income for a period IS the equity delta across it, on the 500-entry book', () => {
      const {reconcileNetIncome, buildIncomeStatement, buildBalanceSheet, describeReconciliation} = statements();
      const {transactions} = bigBook();

      // February onwards has no direct equity postings (the opening balances are
      // all in January), so the equity movement is net income and nothing else.
      const rec = reconcileNetIncome(ACCOUNTS, transactions, {from: '2026-02-01', to: '2026-12-31'});
      expect(rec.cleanPeriod).toBe(true);
      expect(rec.otherEquityMovementsMinor).toBe(0);
      expect(rec.reconciles).toBe(true);
      // THE ACCEPTANCE CRITERION: net income == the equity delta over the period.
      expect(rec.equityDeltaMinor).toBe(rec.netIncomeMinor);
      expect(rec.netIncomeMinor).not.toBe(0);
      // The same figure the income statement puts on screen.
      expect(buildIncomeStatement(ACCOUNTS, transactions, {from: '2026-02-01', to: '2026-12-31'}).netIncomeMinor).toBe(rec.netIncomeMinor);
      // …and the ends really are the two balance sheets' equity totals.
      const closing = buildBalanceSheet(ACCOUNTS, transactions, {asOf: '2026-12-31'});
      expect(rec.closingEquityMinor).toBe(negateAmount(closing.totalEquityMinor));
      expect(sumAmounts([rec.openingEquityMinor, rec.equityDeltaMinor])).toBe(rec.closingEquityMinor);
      expect(describeReconciliation(rec)).toContain('which is this net income exactly');
    });

    it('holds as an identity over EVERY sub-period, including ones with direct equity postings', () => {
      const {reconcileNetIncome} = statements();
      const {transactions} = bigBook();
      const periods: Array<[string, string]> = [
        ['2026-01-01', '2026-01-31'], // opening balances only — equity moves, no earnings
        ['2026-01-01', '2026-06-30'],
        ['2026-04-01', '2026-09-30'],
        ['2026-06-15', '2026-06-15'], // one day, and it is the reversal pair's day
        ['2026-07-01', '2026-12-31'],
        ['2026-01-01', '2026-12-31'],
      ];
      for (const [from, to] of periods) {
        const rec = reconcileNetIncome(ACCOUNTS, transactions, {from, to});
        // equity delta = net income + whatever was posted directly to equity.
        expect(rec.reconciles).toBe(true);
        expect(rec.equityDeltaMinor).toBe(sumAmounts([rec.netIncomeMinor, rec.otherEquityMovementsMinor]));
      }

      // January is NOT a clean period — it is where every contribution lands, and
      // the sentence says so instead of pretending the delta is all earnings.
      const january = reconcileNetIncome(ACCOUNTS, transactions, {from: '2026-01-01', to: '2026-01-31'});
      expect(january.cleanPeriod).toBe(false);
      expect(january.otherEquityMovementsMinor).toBeGreaterThan(0);
      expect(january.netIncomeMinor).toBe(0); // no trading in January
      expect(january.openingEquityMinor).toBe(0);
    });

    it('reads as a sentence a human can check the two statements against each other with', () => {
      const {reconcileNetIncome, describeReconciliation, formatCredit} = statements();
      const book: Transaction[] = [
        tx({date: '2026-01-01', description: 'Founder capital', entryNo: 1, postings: [posting('a1', 1000000), posting('e1', -1000000)]}),
        tx({date: '2026-06-01', description: 'Sale', entryNo: 2, postings: [posting('a1', 40000), posting('r1', -40000)]}),
        tx({date: '2026-06-02', description: 'Hosting', entryNo: 3, postings: [posting('x1', 15000), posting('a1', -15000)]}),
      ];

      const clean = reconcileNetIncome(ACCOUNTS, book, {from: '2026-02-01', to: '2026-12-31'});
      expect(clean.netIncomeMinor).toBe(25000);
      expect(clean.equityDeltaMinor).toBe(25000);
      expect(clean.openingEquityMinor).toBe(1000000);
      expect(clean.closingEquityMinor).toBe(1025000);
      expect(describeReconciliation(clean)).toBe(
        'Ties to the balance sheet: equity moved 250.00 Cr from 2026-02-01 to 2026-12-31, which is this net income exactly — nothing was contributed or drawn.',
      );

      const withCapital = reconcileNetIncome(ACCOUNTS, book, {from: '2026-01-01', to: '2026-12-31'});
      expect(withCapital.cleanPeriod).toBe(false);
      expect(withCapital.otherEquityMovementsMinor).toBe(1000000);
      expect(withCapital.equityDeltaMinor).toBe(1025000);
      expect(describeReconciliation(withCapital)).toContain('this net income plus 10,000.00 Cr posted directly to equity accounts');

      // A profit is a CREDIT to equity — the grammar never renders one as `Dr`.
      expect(formatCredit(25000)).toBe('250.00 Cr');
      expect(formatCredit(-25000)).toBe('250.00 Dr');
      expect(formatCredit(0)).toBe('0.00');
    });

    it('discloses deleted-account balances rather than quietly breaking the tie', () => {
      const {reconcileNetIncome} = statements();
      const book: Transaction[] = [tx({date: '2026-05-01', description: 'Ghost income', entryNo: 1, postings: [posting('ghost', 700), posting('r1', -700)]})];
      const rec = reconcileNetIncome(ACCOUNTS, book, {from: '2026-01-01', to: '2026-12-31'});
      expect(rec.unclassifiedMinor).toBe(700);
      // Revenue is still revenue; the tie still holds on the classified side.
      expect(rec.netIncomeMinor).toBe(700);
      expect(rec.equityDeltaMinor).toBe(700);
      expect(rec.reconciles).toBe(true);
    });
  });

  describe('defaults and control persistence', () => {
    it('defaults BOTH blocks to the wall clock — never to the book, and never past it', () => {
      const {defaultAsOf, defaultPeriod, startOfYear} = statements();
      const today = new Date();
      const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

      // The default is the CLOCK, and it takes no book at all — so no future-dated
      // entry can pull money that has not happened into the opening position, and
      // a balance sheet and a P&L in one document are never on two dates.
      expect(defaultAsOf()).toBe(iso);
      expect(defaultPeriod()).toEqual({from: startOfYear(iso), to: iso});
      expect(defaultPeriod().to).toBe(defaultAsOf());
      expect(startOfYear('2026-06-15')).toBe('2026-01-01');
    });

    it('offers the latest period as a RECOVERY, computed from posted entries only', () => {
      const {latestPeriod, latestReportedDate} = statements();
      const {transactions} = bigBook();

      // Drafts are not on the books, so they never move the recovery either.
      expect(latestReportedDate(transactions)).toBe('2026-12-28');
      expect(latestPeriod(transactions)).toEqual({from: '2026-01-01', to: '2026-12-28'});

      // Nothing to recover to on an empty book — the empty state must then say
      // "post an entry", not offer a button that does nothing.
      expect(latestPeriod([])).toBeNull();
      const draftsOnly = [tx({date: '2027-01-01', state: 'draft', entryNo: null, postings: [posting('a1', 1)]})];
      expect(latestReportedDate(draftsOnly)).toBeNull();
      expect(latestPeriod(draftsOnly)).toBeNull();
    });

    it('a wall-clock as-at date still shows a book that stopped months ago', () => {
      const {buildBalanceSheet} = statements();
      const {transactions} = bigBook();
      // The claim the old latest-entry default rested on — "today opens empty" —
      // is false: `transactionsAsOf` is `tx.date <= asOf`, so any later date shows
      // the same, complete position.
      const atLatest = buildBalanceSheet(ACCOUNTS, transactions, {asOf: '2026-12-28'});
      const muchLater = buildBalanceSheet(ACCOUNTS, transactions, {asOf: '2029-11-01'});
      expect(muchLater.totalAssetsMinor).toBe(atLatest.totalAssetsMinor);
      expect(muchLater.postingCount).toBe(atLatest.postingCount);
      expect(muchLater.balanced).toBe(true);
      // It is empty ONLY when every entry is future-dated — the one case the
      // recovery action exists for.
      const future = buildBalanceSheet(ACCOUNTS, transactions, {asOf: '2025-01-01'});
      expect(future.postingCount).toBe(0);
      expect(future.afterCount).toBeGreaterThan(0);
    });

    it('round-trips collapsed paths through the block props — no separator to guess about', () => {
      const {parseCollapsed, serializeCollapsed} = statements();
      // Every delimiter is a bet that the delimiter cannot occur in an account
      // name, and the bet keeps losing. A comma is legal, and so is a NEWLINE:
      // `isValidLedgerAccountName` only requires non-blank colon-segments, so a
      // newline-joined `Cloud\nHosting` split into two paths that matched
      // nothing and silently re-expanded a subtree the reader had closed.
      const paths = new Set(['Expenses', 'Expenses:Meals, Entertainment', 'Assets:Cloud\nHosting', 'X\ndirect', 'Assets:Bank']);
      expect(parseCollapsed(serializeCollapsed(paths))).toEqual(paths);
      expect(parseCollapsed(serializeCollapsed(paths)).size).toBe(5);
      // Sorted output, so the persisted value does not churn with click order.
      expect(serializeCollapsed(new Set(['B', 'A']))).toBe(serializeCollapsed(new Set(['A', 'B'])));
      // Unreadable reads as "nothing collapsed" — the safe direction: an
      // unexpectedly open tree shows too much, a closed one HIDES rows and with
      // them the arithmetic of the subtotals above.
      expect(parseCollapsed('')).toEqual(new Set());
      expect(parseCollapsed('   ')).toEqual(new Set());
      expect(parseCollapsed('not json at all')).toEqual(new Set());
      expect(parseCollapsed('{"Assets":true}')).toEqual(new Set());
      expect(parseCollapsed('["Assets", 7, null, ""]')).toEqual(new Set(['Assets']));
    });
  });

  describe('money discipline', () => {
    it('refuses to total stored amounts that are not safe integers of minor units', () => {
      const {buildBalanceSheet, buildIncomeStatement, reconcileNetIncome, buildHierarchy} = statements();
      const rotten = [tx({date: '2026-05-01', postings: [{id: 'bad', accountId: 'a1', amountMinor: 10.5, cleared: 'pending'}, posting('r1', -1050)]})];
      // Loud, typed failure — never a rounded or NaN statement quietly rendered.
      expect(() => buildBalanceSheet(ACCOUNTS, rotten, {asOf: '2026-12-31'})).toThrow(/safe integer/i);
      expect(() => buildIncomeStatement(ACCOUNTS, rotten, {from: '2026-01-01', to: '2026-12-31'})).toThrow(/safe integer/i);
      expect(() => reconcileNetIncome(ACCOUNTS, rotten, {from: '2026-01-01', to: '2026-12-31'})).toThrow(/safe integer/i);
      // The rollup holds the same line — an unaddable balance never becomes a subtotal.
      expect(() => buildHierarchy([{accountId: 'a', name: 'Assets:Cash', minor: 1.5}])).toThrow(/safe integer/i);
    });

    it('keeps every statement figure an exact integer of minor units across the whole book', () => {
      const {buildBalanceSheet, buildIncomeStatement, hierarchyLeaves} = statements();
      const {transactions} = bigBook();
      const sheet = buildBalanceSheet(ACCOUNTS, transactions, {asOf: '2026-12-31'});
      const statement = buildIncomeStatement(ACCOUNTS, transactions, {from: '2026-01-01', to: '2026-12-31'});

      const figures = [
        sheet.totalAssetsMinor,
        sheet.totalLiabilitiesMinor,
        sheet.totalEquityMinor,
        sheet.currentEarningsMinor,
        sheet.liabilitiesAndEquityMinor,
        sheet.differenceMinor,
        statement.totalRevenueMinor,
        statement.totalExpensesMinor,
        statement.netIncomeMinor,
        ...[sheet.assets, sheet.liabilities, sheet.equity, statement.revenue, statement.expenses].flatMap((s) => hierarchyLeaves(s.nodes).map((l) => l.ownMinor)),
      ];
      for (const figure of figures) expect(Number.isSafeInteger(figure)).toBe(true);
      // And the balance sheet's current earnings IS the whole-book net income,
      // by two independent routes.
      expect(sheet.currentEarningsMinor).toBe(statement.netIncomeDebitMinor);
    });
  });

  describe('packaging', () => {
    it('every shipped source is storable inline as JSONB — no NUL anywhere', () => {
      // Plugin sources are stored INLINE as JSONB (`server/src/pluginRoutes.ts`
      // → `plugins.files`), and Postgres refuses a NUL inside a JSON string. So a
      // single stray NUL in ONE module makes the WHOLE package fail to install
      // with a 500 — which surfaces as every ledger e2e failing at once, in the
      // install helper, nowhere near the file that caused it. This happened
      // during LGR-9 (a template-literal key carried a literal NUL), and the
      // grep that would have found it does not even print: a file with a NUL is
      // "binary" to grep, so it matches silently.
      // The MANIFEST too: it is stored as JSONB beside the sources and would
      // 500 the install identically, but the glob in the fixture only covers
      // `src/**` — so it has to be named explicitly or it is checked by nobody.
      for (const [path, source] of Object.entries({...LEDGER_PLUGIN_FILES, 'openbook.json': ledgerManifestSource})) {
        // eslint-disable-next-line no-control-regex
        expect(source, `${path} contains a NUL byte and would break plugin install`).not.toMatch(/\u0000/);
      }
      // The glob really is picking the LGR-9 modules up (this is what makes the
      // check above cover them at all).
      expect(Object.keys(LEDGER_PLUGIN_FILES)).toEqual(expect.arrayContaining(['src/statements.ts', 'src/statementShell.tsx', 'src/balanceSheet.tsx', 'src/incomeStatement.tsx']));
    });
  });
});
