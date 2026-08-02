import {describe, expect, it} from 'vitest';
import {sumAmounts} from '@book.dev/sdk';
import {loadLedgerPlugin} from './ledgerPluginFixture';

/**
 * LGR-8 — the pure report folds: trial balance, account register, and the
 * assertions/labels they render. Everything here is arithmetic on SIGNED
 * INTEGER MINOR UNITS through the host money core, so these tests are the
 * proof that the books add up; the blocks only render what comes out.
 */

// Structural mirrors of the plugin's exported shapes (the sources load through
// the runtime loader, so their types are not importable here).
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
interface TrialBalanceRow {
  accountId: string;
  name: string;
  type: AccountType | null;
  normalSide: 'debit' | 'credit';
  balanceMinor: number;
  debitMinor: number;
  creditMinor: number;
  normalMinor: number;
  abnormal: boolean;
  zero: boolean;
  known: boolean;
}
interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebitMinor: number;
  totalCreditMinor: number;
  differenceMinor: number;
  balanced: boolean;
  accountCount: number;
  hiddenZeroCount: number;
  draftCount: number;
  postedCount: number;
  voidCount: number;
  postingCount: number;
  unknownAccountIds: string[];
  unbalancedEntries: UnbalancedEntry[];
}
interface UnbalancedEntry {
  transactionId: string;
  entryNo: number | null;
  date: string;
  description: string;
  deltaMinor: number;
}
interface RegisterRow {
  postingId: string;
  transactionId: string;
  entryNo: number | null;
  date: string;
  description: string;
  contraNames: string[];
  contra: string;
  amountMinor: number;
  runningMinor: number;
  cleared: ClearedState;
  reversed: boolean;
}
interface AccountRegister {
  accountId: string;
  accountName: string;
  accountType: AccountType | null;
  normalSide: 'debit' | 'credit';
  exists: boolean;
  rows: RegisterRow[];
  openingMinor: number;
  closingMinor: number;
  accountBalanceMinor: number;
  totalDebitMinor: number;
  totalCreditMinor: number;
  draftCount: number;
  filteredOutCount: number;
  postingCount: number;
  filter: {from: string | null; to: string | null; cleared: readonly ClearedState[]};
}

/** The plugin's report exports, through the REAL loader + host modules. */
function reports(): {
  buildTrialBalance: (a: readonly Account[], t: readonly Transaction[], o?: {includeZero?: boolean}) => TrialBalance;
  buildAccountRegister: (
    accountId: string,
    a: readonly Account[],
    t: readonly Transaction[],
    f?: {from?: string; to?: string; cleared?: readonly ClearedState[]},
  ) => AccountRegister;
  accountBalances: (t: readonly Transaction[]) => Map<string, number>;
  describeTrialBalanceAssertion: (tb: TrialBalance) => {ok: boolean; text: string; culprits?: string | null};
  findUnbalancedEntries: (t: readonly Transaction[]) => UnbalancedEntry[];
  describeCulprits: (e: readonly UnbalancedEntry[]) => string | null;
  formatWithSide: (minor: number) => string;
  CLEARED_LABEL: Record<ClearedState, string>;
  MAX_NAMED_CULPRITS: number;
  describeDraftExclusion: (n: number) => string;
  describeRegisterSummary: (r: AccountRegister) => string;
  describeRegisterFilter: (r: AccountRegister) => string;
  describeContra: (names: readonly string[]) => string;
  registerMatchesAccountBalance: (r: AccountRegister) => boolean;
  normalSideFor: (t: AccountType | null) => 'debit' | 'credit';
  isReported: (tx: {state: TxState}) => boolean;
  countDrafts: (t: readonly Transaction[]) => number;
  REPORTED_STATES: readonly TxState[];
  ALL_CLEARED_STATES: readonly ClearedState[];
  } {
  return loadLedgerPlugin().exports as unknown as ReturnType<typeof reports>;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ACCOUNTS: Account[] = [
  {id: 'bank', name: 'Assets:Bank:Checking', type: 'asset'},
  {id: 'cash', name: 'Assets:Cash', type: 'asset'},
  {id: 'card', name: 'Liabilities:CreditCard', type: 'liability'},
  {id: 'equity', name: 'Equity:OpeningBalances', type: 'equity'},
  {id: 'revenue', name: 'Income:Revenue', type: 'revenue'},
  {id: 'hosting', name: 'Expenses:Hosting', type: 'expense'},
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
 * A 500-transaction book whose trial balance MUST sum to exactly zero.
 *
 * Deliberately varied: two-leg and three-leg entries, five accounts, amounts
 * that do not divide evenly (so an off-by-one-cent split would show), a run of
 * drafts that must be ignored, and a reversal pair (void original + posted
 * reversal) — which the fold has to count BOTH of, exactly as the server's own
 * balance query does.
 */
function bigBook(): {transactions: Transaction[]; postedCount: number; draftCount: number} {
  const transactions: Transaction[] = [];
  for (let i = 0; i < 500; i += 1) {
    const day = String((i % 28) + 1).padStart(2, '0');
    const month = String((i % 12) + 1).padStart(2, '0');
    const date = `2026-${month}-${day}`;
    // Amounts chosen so the 3-leg split never divides evenly (1 + 2 = 3 cents
    // must be accounted for exactly, or the book will not balance).
    const gross = 100003 + i * 7;
    const fee = 1 + (i % 3);
    if (i % 5 === 4) {
      // Three-leg: revenue split between the bank and a fee expense.
      transactions.push(
        tx({
          date,
          description: `Sale ${i}`,
          entryNo: i + 1,
          postings: [posting('bank', gross - fee, 'cleared'), posting('hosting', fee), posting('revenue', -gross)],
        }),
      );
    } else if (i % 5 === 3) {
      transactions.push(tx({date, description: `Card spend ${i}`, entryNo: i + 1, postings: [posting('hosting', gross), posting('card', -gross, 'reconciled')]}));
    } else {
      transactions.push(tx({date, description: `Deposit ${i}`, entryNo: i + 1, postings: [posting('bank', gross, 'cleared'), posting('equity', -gross)]}));
    }
  }
  // A reversal pair: the original is void, its reversing entry is posted. Both
  // count, and they cancel — so the trial balance is unmoved.
  const original = tx({date: '2026-06-15', description: 'Mistake', state: 'void', entryNo: 900, postings: [posting('cash', 12345), posting('revenue', -12345)]});
  const reversal = tx({date: '2026-06-15', description: 'Reversal of Mistake', state: 'posted', entryNo: 901, postings: [posting('cash', -12345), posting('revenue', 12345)]});
  transactions.push(original, reversal);
  // Drafts: never on the books, whatever they contain (these do NOT balance —
  // if a draft ever leaked into a report, the assertion would fire).
  const drafts = [
    tx({date: '2026-07-01', description: 'Draft one', state: 'draft', entryNo: null, postings: [posting('bank', 500000)]}),
    tx({date: '2026-07-02', description: 'Draft two', state: 'draft', entryNo: null, postings: [posting('hosting', 900), posting('cash', -100)]}),
  ];
  transactions.push(...drafts);
  return {transactions, postedCount: 501, draftCount: drafts.length};
}

describe('LGR-8 report folds (real plugin source through the real loader)', () => {
  describe('trial balance', () => {
    it('sums a 500-transaction book to exactly zero and asserts it', () => {
      const {buildTrialBalance, describeTrialBalanceAssertion} = reports();
      const {transactions, postedCount, draftCount} = bigBook();
      const tb = buildTrialBalance(ACCOUNTS, transactions);

      expect(tb.differenceMinor).toBe(0);
      expect(tb.balanced).toBe(true);
      expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
      expect(tb.totalDebitMinor).toBeGreaterThan(0); // not trivially zero on both sides
      // Every figure is an exact integer of minor units — no float ever landed.
      for (const row of tb.rows) {
        expect(Number.isSafeInteger(row.balanceMinor)).toBe(true);
        expect(Number.isSafeInteger(row.debitMinor)).toBe(true);
        expect(Number.isSafeInteger(row.creditMinor)).toBe(true);
      }
      // Drafts excluded; posted AND void both counted (the reversal pair).
      expect(tb.draftCount).toBe(draftCount);
      expect(tb.postedCount).toBe(postedCount);
      expect(tb.voidCount).toBe(1);

      const assertion = describeTrialBalanceAssertion(tb);
      expect(assertion.ok).toBe(true);
      expect(assertion.text).toMatch(/^In balance — debits [\d,]+\.\d\d = credits [\d,]+\.\d\d ✓$/);
    });

    it('fires the assertion LOUDLY on a deliberately unbalanced book', () => {
      const {buildTrialBalance, describeTrialBalanceAssertion} = reports();
      // A damaged book: one leg of an otherwise balanced entry has gone
      // missing (the shape a lost/edited posting row leaves behind).
      const damaged: Transaction[] = [
        tx({description: 'Good', postings: [posting('bank', 10000), posting('revenue', -10000)]}),
        tx({description: 'Damaged — credit leg lost', postings: [posting('bank', 2550)]}),
      ];
      const tb = buildTrialBalance(ACCOUNTS, damaged);

      expect(tb.balanced).toBe(false);
      expect(tb.differenceMinor).toBe(2550);
      const assertion = describeTrialBalanceAssertion(tb);
      expect(assertion.ok).toBe(false);
      expect(assertion.text).toContain('THE BOOKS DO NOT BALANCE');
      expect(assertion.text).toContain('debits exceed credits by 25.50');
      // It says what it MEANS (damaged data), not "something went wrong".
      expect(assertion.text).toMatch(/missing or damaged/);

      // The other side reads the other way round.
      const other = buildTrialBalance(ACCOUNTS, [tx({description: 'Damaged — debit leg lost', postings: [posting('revenue', -175)]})]);
      expect(other.differenceMinor).toBe(-175);
      expect(describeTrialBalanceAssertion(other).text).toContain('credits exceed debits by 1.75');
    });

    it('is account-type aware: debit-normal vs credit-normal, and flags abnormal balances', () => {
      const {buildTrialBalance, normalSideFor} = reports();
      expect(normalSideFor('asset')).toBe('debit');
      expect(normalSideFor('expense')).toBe('debit');
      expect(normalSideFor('liability')).toBe('credit');
      expect(normalSideFor('equity')).toBe('credit');
      expect(normalSideFor('revenue')).toBe('credit');

      const tb = buildTrialBalance(ACCOUNTS, [
        tx({postings: [posting('bank', 30000), posting('revenue', -30000)]}),
        tx({postings: [posting('hosting', 5000), posting('card', -5000)]}),
      ]);
      const row = (id: string): TrialBalanceRow => tb.rows.find((r) => r.accountId === id)!;

      // Debit-normal asset: debit column, positive on its normal side.
      expect(row('bank').debitMinor).toBe(30000);
      expect(row('bank').creditMinor).toBe(0);
      expect(row('bank').normalMinor).toBe(30000);
      expect(row('bank').abnormal).toBe(false);
      // Credit-normal revenue: credit column, and the SIGN is flipped for
      // display so a credit balance reads as a positive credit.
      expect(row('revenue').balanceMinor).toBe(-30000);
      expect(row('revenue').creditMinor).toBe(30000);
      expect(row('revenue').normalMinor).toBe(30000);
      expect(row('revenue').abnormal).toBe(false);
      expect(row('card').normalSide).toBe('credit');
      expect(row('card').normalMinor).toBe(5000);

      // An overdrawn bank account is abnormal (debit-normal, credit balance)…
      const odd = buildTrialBalance(ACCOUNTS, [tx({postings: [posting('bank', -2500), posting('revenue', 2500)]})]);
      expect(odd.rows.find((r) => r.accountId === 'bank')!.abnormal).toBe(true);
      expect(odd.rows.find((r) => r.accountId === 'bank')!.normalMinor).toBe(-2500);
      // …and so is a revenue account carrying a debit. Still balanced overall.
      expect(odd.rows.find((r) => r.accountId === 'revenue')!.abnormal).toBe(true);
      expect(odd.balanced).toBe(true);
    });

    it('hides zero-balance accounts by default and counts what it hid', () => {
      const {buildTrialBalance} = reports();
      const transactions = [tx({postings: [posting('bank', 1000), posting('revenue', -1000)]})];

      const lean = buildTrialBalance(ACCOUNTS, transactions);
      expect(lean.rows.map((r) => r.accountId).sort()).toEqual(['bank', 'revenue']);
      expect(lean.hiddenZeroCount).toBe(ACCOUNTS.length - 2);
      expect(lean.accountCount).toBe(ACCOUNTS.length);

      const full = buildTrialBalance(ACCOUNTS, transactions, {includeZero: true});
      expect(full.rows).toHaveLength(ACCOUNTS.length);
      expect(full.hiddenZeroCount).toBe(0);
      // Rows are ordered by account name either way.
      expect(full.rows.map((r) => r.name)).toEqual([...ACCOUNTS.map((a) => a.name)].sort((a, b) => a.localeCompare(b)));
      // An account that nets back to zero is hidden, not dropped from totals.
      const netted = buildTrialBalance(ACCOUNTS, [tx({postings: [posting('cash', 500), posting('revenue', -500)]}), tx({postings: [posting('cash', -500), posting('equity', 500)]})]);
      expect(netted.rows.some((r) => r.accountId === 'cash')).toBe(false);
      expect(netted.balanced).toBe(true);
    });

    it('keeps postings whose account is unknown, so a broken book cannot look balanced', () => {
      const {buildTrialBalance} = reports();
      const tb = buildTrialBalance(ACCOUNTS, [tx({postings: [posting('bank', 700), posting('ghost', -700)]})]);
      expect(tb.unknownAccountIds).toEqual(['ghost']);
      const ghost = tb.rows.find((r) => r.accountId === 'ghost')!;
      expect(ghost.known).toBe(false);
      expect(ghost.name).toBe('Deleted account (ghost)');
      // An account of unknowable type has no normal side, so nothing about its
      // balance can be "abnormal" — flagging it would accuse the data of
      // something the report cannot know.
      expect(ghost.abnormal).toBe(false);
      expect(ghost.creditMinor).toBe(700);
      expect(tb.balanced).toBe(true); // the money is still on the report
    });

    it('excludes drafts from the figures and labels the exclusion', () => {
      const {buildTrialBalance, describeDraftExclusion, isReported, countDrafts, REPORTED_STATES} = reports();
      const transactions = [
        tx({postings: [posting('bank', 1000), posting('revenue', -1000)]}),
        tx({state: 'draft', entryNo: null, postings: [posting('bank', 999999), posting('revenue', -999999)]}),
        tx({state: 'draft', entryNo: null, postings: [posting('cash', 5)]}),
      ];
      const tb = buildTrialBalance(ACCOUNTS, transactions);
      expect(tb.totalDebitMinor).toBe(1000); // the draft's 9,999.99 is nowhere
      expect(tb.rows.some((r) => r.accountId === 'cash')).toBe(false);
      expect(tb.draftCount).toBe(2);
      expect(countDrafts(transactions)).toBe(2);
      expect(REPORTED_STATES).toEqual(['posted', 'void']);
      expect(isReported({state: 'draft'})).toBe(false);
      expect(isReported({state: 'posted'})).toBe(true);
      expect(isReported({state: 'void'})).toBe(true);

      expect(describeDraftExclusion(2)).toBe('Posted entries only — 2 draft entries excluded.');
      expect(describeDraftExclusion(1)).toBe('Posted entries only — 1 draft entry excluded.');
      expect(describeDraftExclusion(0)).toBe('Posted entries only — drafts are excluded.');
    });

    it('names the entries responsible for a nonzero total, capped at three', () => {
      const {buildTrialBalance, describeTrialBalanceAssertion, findUnbalancedEntries} = reports();

      // Two entries have lost a posting; a third is intact. The difference is
      // not spread across the book — it belongs to those two, by name.
      const damaged: Transaction[] = [
        tx({date: '2026-03-04', description: 'Invoice 0041', entryNo: 42, postings: [posting('bank', 25000)]}),
        tx({date: '2026-01-01', description: 'Intact', entryNo: 7, postings: [posting('bank', 100), posting('revenue', -100)]}),
        tx({date: '2026-04-09', description: '', entryNo: 51, postings: [posting('revenue', -900)]}),
      ];
      const tb = buildTrialBalance(ACCOUNTS, damaged);
      expect(tb.balanced).toBe(false);

      // The fold names them in entry-number order, with how far out each is.
      expect(tb.unbalancedEntries.map((e) => e.entryNo)).toEqual([42, 51]);
      expect(tb.unbalancedEntries[0].deltaMinor).toBe(25000);
      expect(tb.unbalancedEntries[1].deltaMinor).toBe(-900);
      expect(findUnbalancedEntries(damaged)).toEqual(tb.unbalancedEntries);

      const assertion = describeTrialBalanceAssertion(tb);
      expect(assertion.ok).toBe(false);
      // The next step, in words: which entries, on what date, and by how much —
      // and a blank description simply drops rather than rendering empty quotes.
      expect(assertion.culprits).toBe('Entry #42 (2026-03-04 “Invoice 0041”) is out by 250.00 Dr. Entry #51 (2026-04-09) is out by 9.00 Cr.');
    });

    it('caps the named culprits and counts the rest', () => {
      const {describeCulprits, MAX_NAMED_CULPRITS} = reports();
      const entry = (n: number): UnbalancedEntry => ({transactionId: `t${n}`, entryNo: n, date: '2026-01-01', description: `E${n}`, deltaMinor: 100});
      expect(describeCulprits([])).toBeNull();
      expect(describeCulprits([entry(1)])).toBe('Entry #1 (2026-01-01 “E1”) is out by 1.00 Dr.');
      const many = [1, 2, 3, 4, 5].map(entry);
      const text = describeCulprits(many) as string;
      expect(text).toContain('Entry #1');
      expect(text).toContain(`Entry #${MAX_NAMED_CULPRITS}`);
      expect(text).not.toContain(`Entry #${MAX_NAMED_CULPRITS + 1}`);
      expect(text).toContain('+ 2 more entries.');
      expect(describeCulprits([...many].slice(0, MAX_NAMED_CULPRITS + 1))).toContain('+ 1 more entry.');
      // A drafts-only book is never a culprit list: drafts are not on the books.
      expect(describeCulprits([])).toBeNull();
    });

    it('a balanced book names nobody', () => {
      const {buildTrialBalance, describeTrialBalanceAssertion} = reports();
      const {transactions} = bigBook();
      const tb = buildTrialBalance(ACCOUNTS, transactions);
      expect(tb.unbalancedEntries).toEqual([]);
      expect(describeTrialBalanceAssertion(tb).culprits).toBeNull();
      // Drafts are excluded from the culprit hunt too — the unbalanced drafts in
      // this fixture must not be accused of breaking the books.
      expect(tb.draftCount).toBeGreaterThan(0);
    });

    it('reports an empty book as empty (not as a broken one)', () => {
      const {buildTrialBalance, describeTrialBalanceAssertion} = reports();
      const tb = buildTrialBalance(ACCOUNTS, []);
      expect(tb.rows).toHaveLength(0);
      expect(tb.postingCount).toBe(0);
      expect(tb.balanced).toBe(true);
      expect(describeTrialBalanceAssertion(tb).ok).toBe(true);
      // No accounts at all is equally quiet.
      expect(buildTrialBalance([], []).balanced).toBe(true);
    });
  });

  describe('account register', () => {
    // A small hand-checkable book on the bank account:
    //   Jan 05  +1,000.00 cleared     → 1,000.00
    //   Feb 10    −250.00 pending     →   750.00
    //   Mar 15    +500.00 reconciled  → 1,250.00
    //   Apr 20    −125.00 cleared     → 1,125.00
    const REGISTER_BOOK: Transaction[] = [
      tx({date: '2026-01-05', description: 'Opening float', entryNo: 1, postings: [posting('bank', 100000, 'cleared'), posting('equity', -100000)]}),
      tx({date: '2026-02-10', description: 'Hosting bill', entryNo: 2, postings: [posting('bank', -25000, 'pending'), posting('hosting', 25000)]}),
      tx({date: '2026-03-15', description: 'Customer payment', entryNo: 3, postings: [posting('bank', 50000, 'reconciled'), posting('revenue', -50000)]}),
      tx({date: '2026-04-20', description: 'Card payoff', entryNo: 4, postings: [posting('bank', -12500, 'cleared'), posting('card', 12500)]}),
      tx({date: '2026-05-01', description: 'Never posted', state: 'draft', entryNo: null, postings: [posting('bank', 77700), posting('revenue', -77700)]}),
    ];

    it('lists postings in date order with a correct running balance', () => {
      const {buildAccountRegister, describeRegisterSummary} = reports();
      const reg = buildAccountRegister('bank', ACCOUNTS, REGISTER_BOOK);

      expect(reg.exists).toBe(true);
      expect(reg.accountName).toBe('Assets:Bank:Checking');
      expect(reg.normalSide).toBe('debit');
      expect(reg.rows.map((r) => r.date)).toEqual(['2026-01-05', '2026-02-10', '2026-03-15', '2026-04-20']);
      expect(reg.rows.map((r) => r.entryNo)).toEqual([1, 2, 3, 4]);
      expect(reg.rows.map((r) => r.amountMinor)).toEqual([100000, -25000, 50000, -12500]);
      expect(reg.rows.map((r) => r.runningMinor)).toEqual([100000, 75000, 125000, 112500]);
      expect(reg.openingMinor).toBe(0);
      expect(reg.closingMinor).toBe(112500);
      expect(reg.totalDebitMinor).toBe(150000);
      expect(reg.totalCreditMinor).toBe(37500);
      // One notation across both blocks: magnitude + side, never a bare sign.
      expect(describeRegisterSummary(reg)).toBe('4 postings · opening 0.00 · closing 1,125.00 Dr');
    });

    it('names the contra side of every entry, including splits', () => {
      const {buildAccountRegister, describeContra} = reports();
      const split = tx({
        date: '2026-06-01',
        description: 'Payroll',
        entryNo: 5,
        postings: [posting('bank', -300000), posting('hosting', 100000), posting('card', 150000), posting('cash', 50000)],
      });
      const reg = buildAccountRegister('bank', ACCOUNTS, [...REGISTER_BOOK, split]);

      expect(reg.rows[0].contra).toBe('Equity:OpeningBalances');
      expect(reg.rows[1].contra).toBe('Expenses:Hosting');
      const payroll = reg.rows[reg.rows.length - 1];
      expect(payroll.contraNames).toEqual(['Expenses:Hosting', 'Liabilities:CreditCard', 'Assets:Cash']);
      expect(payroll.contra).toBe('Expenses:Hosting + 2 more (split)');

      expect(describeContra([])).toBe('—');
      expect(describeContra(['A'])).toBe('A');
      expect(describeContra(['A', 'B'])).toBe('A, B');
      expect(describeContra(['A', 'B', 'C'])).toBe('A + 2 more (split)');
    });

    it('running balance is correct under a DATE-RANGE filter (pre-range postings become the opening balance)', () => {
      const {buildAccountRegister, describeRegisterFilter, describeRegisterSummary, registerMatchesAccountBalance} = reports();
      const reg = buildAccountRegister('bank', ACCOUNTS, REGISTER_BOOK, {from: '2026-02-01', to: '2026-03-31'});

      // Only the two in-range postings show…
      expect(reg.rows.map((r) => r.date)).toEqual(['2026-02-10', '2026-03-15']);
      // …but the running balance is the REAL balance on those dates, because
      // January is carried in rather than dropped.
      expect(reg.openingMinor).toBe(100000);
      expect(reg.rows.map((r) => r.runningMinor)).toEqual([75000, 125000]);
      expect(reg.closingMinor).toBe(125000);
      expect(reg.filteredOutCount).toBe(2);
      expect(reg.filter).toEqual({from: '2026-02-01', to: '2026-03-31', cleared: ['pending', 'cleared', 'reconciled']});
      expect(describeRegisterFilter(reg)).toBe('2026-02-01 → 2026-03-31 · all cleared states · 2 hidden by this filter');
      expect(describeRegisterSummary(reg)).toBe('2 postings · opening 1,000.00 Dr · closing 1,250.00 Dr');
      // A filtered closing balance is NOT the account balance, and says so.
      expect(registerMatchesAccountBalance(reg)).toBe(false);
      expect(reg.accountBalanceMinor).toBe(112500);

      // Bounds are inclusive on both ends.
      const exact = buildAccountRegister('bank', ACCOUNTS, REGISTER_BOOK, {from: '2026-02-10', to: '2026-04-20'});
      expect(exact.rows).toHaveLength(3);
      expect(exact.closingMinor).toBe(112500);
      // Open-ended ranges work either way round.
      expect(buildAccountRegister('bank', ACCOUNTS, REGISTER_BOOK, {from: '2026-03-01'}).openingMinor).toBe(75000);
      expect(buildAccountRegister('bank', ACCOUNTS, REGISTER_BOOK, {to: '2026-02-28'}).closingMinor).toBe(75000);
      // A range with nothing in it still carries the opening balance forward.
      const empty = buildAccountRegister('bank', ACCOUNTS, REGISTER_BOOK, {from: '2026-08-01', to: '2026-08-31'});
      expect(empty.rows).toHaveLength(0);
      expect(empty.openingMinor).toBe(112500);
      expect(empty.closingMinor).toBe(112500);
    });

    it('running balance is correct under a CLEARED-STATE filter (a bank-statement view)', () => {
      const {buildAccountRegister, describeRegisterFilter} = reports();

      // Cleared only: the pending bill and the reconciled receipt drop out.
      const clearedOnly = buildAccountRegister('bank', ACCOUNTS, REGISTER_BOOK, {cleared: ['cleared']});
      expect(clearedOnly.rows.map((r) => r.amountMinor)).toEqual([100000, -12500]);
      expect(clearedOnly.rows.map((r) => r.runningMinor)).toEqual([100000, 87500]);
      expect(clearedOnly.closingMinor).toBe(87500);
      expect(clearedOnly.filteredOutCount).toBe(2);
      // Display labels, not the raw enum ids.
      expect(describeRegisterFilter(clearedOnly)).toBe('All dates · Cleared · 2 hidden by this filter');

      // Cleared + reconciled — the "has actually settled" balance.
      const settled = buildAccountRegister('bank', ACCOUNTS, REGISTER_BOOK, {cleared: ['cleared', 'reconciled']});
      expect(settled.rows.map((r) => r.runningMinor)).toEqual([100000, 150000, 137500]);
      expect(settled.closingMinor).toBe(137500);

      // Pending only.
      const pending = buildAccountRegister('bank', ACCOUNTS, REGISTER_BOOK, {cleared: ['pending']});
      expect(pending.rows.map((r) => r.amountMinor)).toEqual([-25000]);
      expect(pending.closingMinor).toBe(-25000);

      // An empty list means "no filter", never "no rows" — an unticked-all UI
      // must not silently render an empty register.
      expect(buildAccountRegister('bank', ACCOUNTS, REGISTER_BOOK, {cleared: []}).rows).toHaveLength(4);
    });

    it('combines both filters, and the cleared filter also gates the opening balance', () => {
      const {buildAccountRegister} = reports();
      const reg = buildAccountRegister('bank', ACCOUNTS, REGISTER_BOOK, {from: '2026-03-01', cleared: ['cleared']});
      // January's 1,000.00 is cleared and before the range → opening balance.
      // February's pending bill is filtered out of the opening balance too.
      expect(reg.openingMinor).toBe(100000);
      expect(reg.rows.map((r) => r.amountMinor)).toEqual([-12500]); // March is reconciled, not cleared
      expect(reg.rows.map((r) => r.runningMinor)).toEqual([87500]);
      expect(reg.closingMinor).toBe(87500);
    });

    it('unfiltered, the register closes on exactly the trial-balance figure for that account', () => {
      const {buildAccountRegister, buildTrialBalance, accountBalances, registerMatchesAccountBalance} = reports();
      const {transactions} = bigBook();
      const tb = buildTrialBalance(ACCOUNTS, transactions, {includeZero: true});
      const balances = accountBalances(transactions);

      for (const account of ACCOUNTS) {
        const reg = buildAccountRegister(account.id, ACCOUNTS, transactions);
        const row = tb.rows.find((r) => r.accountId === account.id)!;
        expect(reg.closingMinor).toBe(row.balanceMinor);
        expect(reg.closingMinor).toBe(balances.get(account.id) ?? 0);
        expect(reg.accountBalanceMinor).toBe(row.balanceMinor);
        expect(registerMatchesAccountBalance(reg)).toBe(true);
        expect(reg.openingMinor).toBe(0);
        expect(reg.filteredOutCount).toBe(0);
      }
      // And the account registers' closing balances still sum to zero across
      // the whole book — the trial balance, rebuilt from the registers.
      // (Summed with the host money core, not `+`: the test holds itself to the
      // same discipline the report code does.)
      expect(sumAmounts(ACCOUNTS.map((a) => buildAccountRegister(a.id, ACCOUNTS, transactions).closingMinor))).toBe(0);
    });

    it('excludes drafts, counts them for the label, and marks reversed entries', () => {
      const {buildAccountRegister, describeDraftExclusion} = reports();
      const reg = buildAccountRegister('bank', ACCOUNTS, REGISTER_BOOK);
      expect(reg.rows.some((r) => r.description === 'Never posted')).toBe(false);
      expect(reg.rows.map((r) => r.amountMinor)).not.toContain(77700);
      expect(reg.draftCount).toBe(1);
      expect(describeDraftExclusion(reg.draftCount)).toBe('Posted entries only — 1 draft entry excluded.');
      // A draft on another account is not counted against this one.
      expect(buildAccountRegister('card', ACCOUNTS, REGISTER_BOOK).draftCount).toBe(0);

      // A reversal pair: both legs appear (they must, or the balance is wrong)
      // and the void original is marked so the row is readable.
      const original = tx({date: '2026-07-01', description: 'Oops', state: 'void', entryNo: 10, postings: [posting('bank', 4200), posting('revenue', -4200)]});
      const reversal = tx({date: '2026-07-02', description: 'Reversal of Oops', entryNo: 11, postings: [posting('bank', -4200), posting('revenue', 4200)]});
      const withReversal = buildAccountRegister('bank', ACCOUNTS, [...REGISTER_BOOK, original, reversal]);
      expect(withReversal.rows.slice(-2).map((r) => r.reversed)).toEqual([true, false]);
      expect(withReversal.closingMinor).toBe(112500); // the pair cancels
    });

    it('answers usefully for no account, an unknown account, and an account with no postings', () => {
      const {buildAccountRegister, describeRegisterSummary} = reports();

      const ghost = buildAccountRegister('nope', ACCOUNTS, REGISTER_BOOK);
      expect(ghost.exists).toBe(false);
      expect(ghost.rows).toHaveLength(0);
      expect(ghost.closingMinor).toBe(0);

      const quiet = buildAccountRegister('cash', ACCOUNTS, REGISTER_BOOK);
      expect(quiet.exists).toBe(true);
      expect(quiet.postingCount).toBe(0);
      expect(quiet.rows).toHaveLength(0);
      expect(describeRegisterSummary(quiet)).toBe('0 postings · opening 0.00 · closing 0.00');
      expect(buildAccountRegister('', ACCOUNTS, REGISTER_BOOK).exists).toBe(false);
    });

    it('orders same-day postings deterministically (date, entry number, then ids)', () => {
      const {buildAccountRegister} = reports();
      const sameDay: Transaction[] = [
        tx({id: 'tB', date: '2026-09-09', description: 'second', entryNo: 21, postings: [posting('bank', 200), posting('revenue', -200)]}),
        tx({id: 'tA', date: '2026-09-09', description: 'first', entryNo: 20, postings: [posting('bank', 100), posting('revenue', -100)]}),
        tx({id: 'tC', date: '2026-09-08', description: 'earlier day', entryNo: 99, postings: [posting('bank', 50), posting('revenue', -50)]}),
      ];
      const reg = buildAccountRegister('bank', ACCOUNTS, sameDay);
      expect(reg.rows.map((r) => r.description)).toEqual(['earlier day', 'first', 'second']);
      expect(reg.rows.map((r) => r.runningMinor)).toEqual([50, 150, 350]);
      // Re-running on a shuffled input gives the identical order.
      const shuffled = buildAccountRegister('bank', ACCOUNTS, [sameDay[2], sameDay[0], sameDay[1]]);
      expect(shuffled.rows.map((r) => r.postingId)).toEqual(reg.rows.map((r) => r.postingId));
    });
  });

  describe('shared notation', () => {
    it('formatWithSide is one grammar for both blocks: magnitude + side, bare at zero', () => {
      const {formatWithSide, CLEARED_LABEL} = reports();
      expect(formatWithSide(0)).toBe('0.00');
      expect(formatWithSide(123456)).toBe('1,234.56 Dr');
      expect(formatWithSide(-25000)).toBe('250.00 Cr');
      // The magnitude comes from the money core, never Math.abs — the extremes
      // round-trip exactly.
      expect(formatWithSide(-Number.MAX_SAFE_INTEGER)).toContain('Cr');
      // Cleared states have display labels, so user copy never shows enum ids.
      expect(CLEARED_LABEL.pending).toBe('Pending');
      expect(CLEARED_LABEL.reconciled).toBe('Reconciled');
    });
  });

  describe('money discipline', () => {
    it('refuses to total stored amounts that are not safe integers of minor units', () => {
      const {buildTrialBalance, buildAccountRegister} = reports();
      const rotten = [tx({postings: [{id: 'bad', accountId: 'bank', amountMinor: 10.5, cleared: 'pending'}, posting('revenue', -1050)]})];
      // Loud, typed failure — never a rounded or NaN total quietly rendered.
      expect(() => buildTrialBalance(ACCOUNTS, rotten)).toThrow(/safe integer/i);
      expect(() => buildAccountRegister('bank', ACCOUNTS, rotten)).toThrow(/safe integer/i);
    });
  });
});
