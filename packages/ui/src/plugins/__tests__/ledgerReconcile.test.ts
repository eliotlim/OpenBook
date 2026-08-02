import {describe, expect, it} from 'vitest';
import {loadLedgerPlugin} from './ledgerPluginFixture';

/**
 * LGR-11 — the reconciliation fold, driven through the REAL plugin loader
 * against the SHIPPED source.
 *
 * The block is IO and rendering; everything that can be got wrong is in
 * `reconcile.ts`: the direction of the subtraction, the side a typed statement
 * balance is read on, what counts as "cleared", and whether Finish may be
 * offered at all. Those are pinned here rather than inferred from a rendered
 * checklist, because a reconciliation that reaches zero for the wrong reason
 * looks exactly like one that reached zero for the right one.
 */

// Structural mirrors of the plugin's exported shapes (the sources load through
// the runtime loader, so their types are not importable here).
interface ReportAccount {
  id: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
}
interface ReportPosting {
  id: string;
  accountId: string;
  amountMinor: number;
  cleared: 'pending' | 'cleared' | 'reconciled';
  reconciliationId?: string | null;
}
interface ReportTransaction {
  id: string;
  date: string;
  description: string;
  state: 'draft' | 'posted' | 'void';
  entryNo: number | null;
  postings: ReportPosting[];
}
/** Mirrors the plugin's `ReconcileStatus` — `abandoned` is LGR-22's terminal state. */
type ReconcileStatus = 'open' | 'finished' | 'abandoned';
interface Statement {
  id: string;
  accountId: string;
  statementDate: string;
  statementBalanceMinor: number;
  status: ReconcileStatus;
}
interface ReconcileRow {
  postingId: string;
  date: string;
  description: string;
  entryNo: number | null;
  amountMinor: number;
  cleared: string;
  matched: boolean;
  frozen: boolean;
  frozenStatementDate: string | null;
  frozenElsewhere: boolean;
  reversed: boolean;
}
interface ReconcileSheet {
  accountName: string;
  normalSide: 'debit' | 'credit';
  exists: boolean;
  status: ReconcileStatus;
  statementDate: string;
  statementBalanceMinor: number;
  rows: ReconcileRow[];
  clearedBalanceMinor: number;
  differenceMinor: number;
  balanced: boolean;
  canFinish: boolean;
  matchedCount: number;
  unmatchedCount: number;
  unmatchedMinor: number;
  draftCount: number;
  frozenElsewhereCount: number;
}
type BalanceResult = {ok: true; minor: number} | {ok: false; problem: string};

const mod = (): Record<string, unknown> => loadLedgerPlugin().exports;

const BANK = 'acct-bank';
const INCOME = 'acct-income';
const ACCOUNTS: ReportAccount[] = [
  {id: BANK, name: 'Assets:Bank:Checking', type: 'asset'},
  {id: INCOME, name: 'Income:Revenue', type: 'revenue'},
];
/** A credit-normal account, for the side conversion. */
const CARD_ACCOUNTS: ReportAccount[] = [
  {id: BANK, name: 'Liabilities:Card', type: 'liability'},
  {id: INCOME, name: 'Expenses:Meals', type: 'expense'},
];

let seq = 0;
const entry = (
  date: string,
  amountMinor: number,
  cleared: ReportPosting['cleared'] = 'pending',
  over: Partial<ReportTransaction> & {reconciliationId?: string | null} = {},
): ReportTransaction => {
  seq += 1;
  const id = over.id ?? `tx-${seq}`;
  return {
    id,
    date,
    description: over.description ?? `entry ${amountMinor}`,
    state: over.state ?? 'posted',
    entryNo: over.entryNo ?? seq,
    postings: [
      {id: `${id}-bank`, accountId: BANK, amountMinor, cleared, reconciliationId: over.reconciliationId ?? null},
      {id: `${id}-other`, accountId: INCOME, amountMinor: -amountMinor, cleared: 'pending', reconciliationId: null},
    ],
  };
};

const statement = (over: Partial<Statement> = {}): Statement => ({
  id: 'rec-1',
  accountId: BANK,
  statementDate: '2026-03-31',
  statementBalanceMinor: 0,
  status: 'open',
  ...over,
});

const build = (
  s: Statement,
  transactions: ReportTransaction[],
  accounts: ReportAccount[] = ACCOUNTS,
  reconciliations: Statement[] = [s],
): ReconcileSheet =>
  (mod().buildReconcileSheet as (a: Statement, b: ReportAccount[], c: ReportTransaction[], d: Statement[]) => ReconcileSheet)(
    s,
    accounts,
    transactions,
    reconciliations,
  );

describe('LGR-11 — the reconciliation fold (real source through the real loader)', () => {
  describe('the arithmetic: statement − cleared = the difference to explain', () => {
    it('counts only what is ticked, and subtracts in that order', () => {
      const txs = [entry('2026-03-01', 100_000, 'cleared'), entry('2026-03-05', -25_000, 'cleared'), entry('2026-03-20', -999)];
      const sheet = build(statement({statementBalanceMinor: 75_000}), txs);
      expect(sheet.clearedBalanceMinor).toBe(75_000);
      expect(sheet.differenceMinor).toBe(0);
      expect(sheet.balanced).toBe(true);
      expect(sheet.canFinish).toBe(true);
      // The unticked one is visible, counted separately, and NOT in the total —
      // it is the money on the books that the statement does not know about.
      expect(sheet.matchedCount).toBe(2);
      expect(sheet.unmatchedCount).toBe(1);
      expect(sheet.unmatchedMinor).toBe(-999);
      expect(sheet.rows).toHaveLength(3);
    });

    it('reports the difference SIGNED, so its direction is never guessed', () => {
      const txs = [entry('2026-03-01', 100_000, 'cleared')];
      // Bank has more than the books have ticked → still to find.
      const short = build(statement({statementBalanceMinor: 112_500}), txs);
      expect(short.differenceMinor).toBe(12_500);
      expect(short.balanced).toBe(false);
      expect(short.canFinish).toBe(false);
      // Books have more than the bank → a duplicate, or something uncleared.
      const over = build(statement({statementBalanceMinor: 90_000}), txs);
      expect(over.differenceMinor).toBe(-10_000);
      expect(over.canFinish).toBe(false);
    });

    it('DRAFTS are excluded and counted as excluded; void entries still count', () => {
      const txs = [
        entry('2026-03-01', 100_000, 'cleared'),
        entry('2026-03-02', 500, 'cleared', {state: 'draft'}),
        // A reversed original and its reversal both reach the books and offset.
        entry('2026-03-03', 700, 'cleared', {state: 'void'}),
        entry('2026-03-03', -700, 'cleared'),
      ];
      const sheet = build(statement({statementBalanceMinor: 100_000}), txs);
      expect(sheet.draftCount).toBe(1);
      expect(sheet.rows.some((r) => r.date === '2026-03-02')).toBe(false);
      expect(sheet.rows.filter((r) => r.reversed)).toHaveLength(1);
      expect(sheet.differenceMinor).toBe(0);
    });

    it('a `reconciled` posting from an EARLIER statement still counts as cleared', () => {
      // The rule that makes every reconciliation after the first one possible:
      // a statement's closing balance includes money reconciled months ago.
      const txs = [entry('2026-01-10', 50_000, 'reconciled', {reconciliationId: 'rec-0'}), entry('2026-03-01', 25_000, 'cleared')];
      const march = statement({id: 'rec-1', statementBalanceMinor: 75_000});
      const january: Statement = {id: 'rec-0', accountId: BANK, statementDate: '2026-01-31', statementBalanceMinor: 50_000, status: 'finished'};
      const sheet = build(march, txs, ACCOUNTS, [january, march]);
      expect(sheet.differenceMinor).toBe(0);
      expect(sheet.canFinish).toBe(true);
      // …and it is shown as locked, naming the statement that holds it — an id
      // in a cell explains nothing, a date explains everything.
      const frozen = sheet.rows.find((r) => r.frozen)!;
      expect(frozen.frozenElsewhere).toBe(true);
      expect(frozen.frozenStatementDate).toBe('2026-01-31');
      expect(sheet.frozenElsewhereCount).toBe(1);
      expect((mod().isRowLocked as (s: ReconcileSheet, r: ReconcileRow) => boolean)(sheet, frozen)).toBe(true);
    });

    it('NO date filter: a posting after the statement date is still on the checklist', () => {
      // Tidier to hide it, and wrong: a duplicate dated after the statement
      // closes is exactly what this workflow exists to catch, and a difference
      // explained by a row that is not on screen cannot be explained at all.
      const sheet = build(statement({statementBalanceMinor: 0}), [entry('2026-04-15', 4_242)]);
      expect(sheet.rows.map((r) => r.date)).toEqual(['2026-04-15']);
    });

    it('orders the checklist totally, so ticking never reshuffles it', () => {
      const txs = [
        entry('2026-03-05', 300, 'pending', {id: 'tx-b', entryNo: 9}),
        entry('2026-03-01', 100, 'pending', {id: 'tx-a', entryNo: 4}),
        entry('2026-03-05', 200, 'pending', {id: 'tx-c', entryNo: 2}),
      ];
      const first = build(statement(), txs).rows.map((r) => r.postingId);
      const reshuffled = build(statement(), [...txs].reverse()).rows.map((r) => r.postingId);
      expect(first).toEqual(reshuffled);
      // Date first, then entry number — #2 precedes #9 on the same day.
      expect(first).toEqual(['tx-a-bank', 'tx-c-bank', 'tx-b-bank']);
    });

    it('an unknown account folds to a non-existent sheet rather than throwing', () => {
      const sheet = build(statement({accountId: 'acct-gone'}), [entry('2026-03-01', 100)]);
      expect(sheet.exists).toBe(false);
      expect(sheet.rows).toEqual([]);
    });

    it('a stored amount the money core refuses to add FAILS LOUDLY (never a wrong total)', () => {
      const txs = [entry('2026-03-01', 12.5, 'cleared')];
      expect(() => build(statement({statementBalanceMinor: 12}), txs)).toThrow();
    });
  });

  describe('the statement balance is typed on the account’s NORMAL side', () => {
    const parse = (raw: string, side: 'debit' | 'credit'): BalanceResult =>
      (mod().parseStatementBalance as (r: string, s: 'debit' | 'credit') => BalanceResult)(raw, side);

    it('reads a debit-normal balance as-is and a credit-normal one flipped', () => {
      expect(parse('1,250.00', 'debit')).toEqual({ok: true, minor: 125_000});
      // A credit card statement saying "1,250.00" means 1,250.00 OWED, which is
      // a credit balance — the same digits on the opposite side of the ledger.
      expect(parse('1,250.00', 'credit')).toEqual({ok: true, minor: -125_000});
      // An overdrawn current account is typed with its minus sign and lands on
      // the credit side without anything re-signing it downstream.
      expect(parse('-320.55', 'debit')).toEqual({ok: true, minor: -32_055});
      expect(parse('$0', 'debit')).toEqual({ok: true, minor: 0});
    });

    it('parses ONLY through the money core, and explains a refusal', () => {
      for (const bad of ['1e3', '0x10', 'Infinity', 'twelve', '1.234,56']) {
        const result = parse(bad, 'debit');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.problem.length).toBeGreaterThan(0);
      }
      // Blank is not an error the user has made yet — it is an instruction.
      const empty = parse('   ', 'debit');
      expect(empty.ok).toBe(false);
      if (!empty.ok) expect(empty.problem).toMatch(/Enter the closing balance/);
    });

    it('marks an ABNORMAL balance with its side rather than a bare minus', () => {
      // `formatWithSide`'s rule: a magnitude always carries the side it is on.
      // A bare `-250.00` beside `50.00 Dr` puts two notations in one sentence.
      const format = mod().formatOnNormalSide as (m: number, s: 'debit' | 'credit') => string;
      expect(format(-25_000, 'debit')).toBe('250.00 Cr'); // overdrawn current account
      expect(format(25_000, 'credit')).toBe('250.00 Dr'); // credit card in credit
      for (const [minor, side] of [[-25_000, 'debit'], [25_000, 'credit']] as Array<[number, 'debit' | 'credit']>) {
        expect(format(minor, side)).not.toContain('-');
      }
      // …and the sentence built from it carries one notation throughout.
      const describeDifference = mod().describeDifference as (s: ReconcileSheet) => string;
      const overdrawn = build(statement({statementBalanceMinor: -25_000}), [entry('2026-03-01', -30_000, 'cleared')]);
      expect(describeDifference(overdrawn)).toBe('Statement 250.00 Cr − cleared 300.00 Cr = 50.00 Dr still to explain.');
      expect(describeDifference(overdrawn)).not.toContain('-');
    });

    it('says what to TYPE, not what the account is — in the LABEL', () => {
      // LGR-22: the instruction moved into the label itself. "Closing balance
      // (credit-normal account)" stated a property and left the reader to
      // derive what to type from it, at the one moment where the wrong answer
      // costs a difference of exactly twice the balance.
      const describeBalanceLabel = mod().describeBalanceLabel as (s: 'debit' | 'credit') => string;
      expect(describeBalanceLabel('debit')).toBe('Closing balance — as the statement prints it (a positive number is money in the account)');
      expect(describeBalanceLabel('credit')).toBe('Closing balance — as the statement prints it (a positive number is a balance you owe)');
      // What it must NOT do is name the account's normal side as a property and
      // stop there — the exact shape of the copy this replaced.
      for (const side of ['debit', 'credit'] as const) expect(describeBalanceLabel(side)).not.toMatch(/-normal account/);
    });

    it('the label and the 2× hint read the account’s side from ONE source', () => {
      // Two sentences carrying the same fact in different words is how they
      // drift. `describePositiveMeans` is the fact; both are framings of it, so
      // a reworded label cannot leave the diagnostic describing a credit card
      // as a current account.
      const describePositiveMeans = mod().describePositiveMeans as (s: 'debit' | 'credit') => string;
      const describeBalanceLabel = mod().describeBalanceLabel as (s: 'debit' | 'credit') => string;
      const describeGap = mod().describeGap as (s: ReconcileSheet) => string | null;
      for (const [side, accounts] of [['debit', ACCOUNTS], ['credit', CARD_ACCOUNTS]] as Array<['debit' | 'credit', ReportAccount[]]>) {
        const clause = describePositiveMeans(side);
        expect(describeBalanceLabel(side)).toContain(clause);
        // A sign-flipped balance: typed −1,000.00 where +1,000.00 was meant,
        // with the books right, puts the difference at exactly twice.
        const flipped = build(
          statement({statementBalanceMinor: side === 'debit' ? -100_000 : 100_000}),
          [entry('2026-03-01', side === 'debit' ? 100_000 : -100_000, 'cleared')],
          accounts,
        );
        expect(describeGap(flipped)).toContain(clause);
      }
    });

    it('echoes the MEANING, not the digits — the round trip proves nothing', () => {
      // `parseStatementBalance` maps onto the normal side and
      // `formatOnNormalSide` maps straight back, so a formatted echo reprints
      // the user's own keystrokes and is silent about the SIDE — the one fact
      // they can get wrong, at a cost of exactly twice the balance.
      const echo = mod().describeBalanceEcho as (m: number, s: 'debit' | 'credit') => string;
      expect(echo(125_000, 'debit')).toBe('Reading it as 1,250.00 in the account.');
      expect(echo(-125_000, 'credit')).toBe('Reading it as 1,250.00 owed.');
      // The abnormal cases are named too, rather than printed with a minus.
      expect(echo(-32_055, 'debit')).toBe('Reading it as 320.55 overdrawn.');
      expect(echo(32_055, 'credit')).toBe('Reading it as 320.55 in credit.');
      expect(echo(0, 'debit')).toBe('Reading it as an empty account.');
      for (const [minor, side] of [[-32_055, 'debit'], [32_055, 'credit']] as Array<[number, 'debit' | 'credit']>) {
        expect(echo(minor, side)).not.toContain('-');
      }
    });

    it('round-trips through the display formatter on both sides', () => {
      const format = mod().formatOnNormalSide as (m: number, s: 'debit' | 'credit') => string;
      expect(format(125_000, 'debit')).toBe('1,250.00');
      expect(format(-125_000, 'credit')).toBe('1,250.00');
      // What goes into the box comes back out of it, unchanged.
      for (const side of ['debit', 'credit'] as const) {
        const parsed = parse('987.65', side);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expect(format(parsed.minor, side)).toBe('987.65');
      }
    });

    it('a credit-normal account reconciles to zero with the flipped balance', () => {
      // 240.00 spent on a card is a CREDIT of 240.00 in the books; the statement
      // says "240.00 owed". Without the side conversion the difference would be
      // exactly twice the balance, and would never reach zero.
      const txs = [entry('2026-03-01', -24_000, 'cleared')];
      const parsed = parse('240.00', 'credit');
      expect(parsed.ok).toBe(true);
      const sheet = build(statement({statementBalanceMinor: (parsed as {ok: true; minor: number}).minor}), txs, CARD_ACCOUNTS);
      expect(sheet.normalSide).toBe('credit');
      expect(sheet.differenceMinor).toBe(0);
      expect(sheet.canFinish).toBe(true);
    });
  });

  describe('the Finish gate and what it says when it is closed', () => {
    interface FinishBlock {rule: string; live: string | null}
    const describeFinishBlock = (s: ReconcileSheet): FinishBlock | null => (mod().describeFinishBlock as (x: ReconcileSheet) => FinishBlock | null)(s);

    it('canFinish is balanced AND open — never one without the other', () => {
      const balanced = build(statement({statementBalanceMinor: 100}), [entry('2026-03-01', 100, 'cleared')]);
      expect(balanced.canFinish).toBe(true);
      expect(describeFinishBlock(balanced)).toBeNull();

      const out = build(statement({statementBalanceMinor: 101}), [entry('2026-03-01', 100, 'cleared')]);
      expect(out.canFinish).toBe(false);
      expect(describeFinishBlock(out)!.rule).toBe('Finish is available once the difference reads exactly 0.00.');
      // The LIVE state is a SEPARATE clause: a disabled button is out of the tab
      // order, so a screen-reader user reaches it only through the description
      // and needs the figure — while a sighted reader already has it two lines
      // above, and printing it again just makes the eye restate what it read.
      expect(describeFinishBlock(out)!.live).toBe('It is 0.01 Dr now.');

      // A FINISHED one is balanced but must not offer Finish again.
      const done = build(statement({statementBalanceMinor: 100, status: 'finished'}), [
        entry('2026-03-01', 100, 'reconciled', {reconciliationId: 'rec-1'}),
      ]);
      expect(done.balanced).toBe(true);
      expect(done.canFinish).toBe(false);
      expect(describeFinishBlock(done)!.rule).toMatch(/already reconciled/i);
      expect(describeFinishBlock(done)!.live).toBeNull();
      // Every row of a finished sheet is locked, including its own.
      const isRowLocked = mod().isRowLocked as (s: ReconcileSheet, r: ReconcileRow) => boolean;
      expect(done.rows.every((r) => isRowLocked(done, r))).toBe(true);
      // …and its own postings are NOT "frozen elsewhere" — this statement owns them.
      expect(done.frozenElsewhereCount).toBe(0);
    });
  });

  describe('the sentences the live region reads out', () => {
    const describeDifference = (s: ReconcileSheet): string => (mod().describeDifference as (x: ReconcileSheet) => string)(s);
    const describeGap = (s: ReconcileSheet): string | null => (mod().describeGap as (x: ReconcileSheet) => string | null)(s);

    it('states the whole arithmetic, in the order it is checked', () => {
      const out = build(statement({statementBalanceMinor: 112_500}), [entry('2026-03-01', 100_000, 'cleared')]);
      expect(describeDifference(out)).toBe('Statement 1,125.00 − cleared 1,000.00 = 125.00 Dr still to explain.');
      const done = build(statement({statementBalanceMinor: 100_000}), [entry('2026-03-01', 100_000, 'cleared')]);
      // It may only claim what it can PROVE. Reaching zero explains the
      // statement; it says nothing about whether the books are right, and
      // "nothing left to explain" claimed exactly that while an unresolved
      // posting sat in a footnote below the table.
      expect(describeDifference(done)).toBe('Statement 1,000.00 = cleared 1,000.00 — this statement is fully explained.');
      expect(describeDifference(done)).not.toMatch(/nothing left to explain/);
      expect(describeGap(done)).toBeNull();
    });

    it('names BOTH causes for either direction — a ledger has two sides', () => {
      // THE REGRESSION THIS PINS: one cause per branch is wrong, because a
      // doubled CREDIT on a debit-normal account puts the statement ahead
      // exactly as a missing DEBIT does. On the project's own canonical
      // fixture the difference is 950.00 Dr and the cause IS a ticked
      // duplicate, so advice that only says "look for a missing entry" sends
      // the reader hunting for a receipt that does not exist.
      const missing = build(statement({statementBalanceMinor: 112_500}), [entry('2026-03-01', 100_000, 'cleared')]);
      expect(describeGap(missing)).toMatch(/statement is 125\.00 ahead/);
      expect(describeGap(missing)).toMatch(/missing from the books/);
      expect(describeGap(missing)).toMatch(/recorded twice on the other side/);
      // …and with EVERYTHING ticked it must not offer "one you have not ticked
      // yet", which the footer ("nothing unmatched") disproves on the same
      // screen — a smaller copy of the very bug this sentence was rewritten for.
      expect(missing.unmatchedCount).toBe(0);
      expect(describeGap(missing)).not.toMatch(/not ticked yet/);
      // With something genuinely unticked, the clause earns its place.
      const someUnticked = build(statement({statementBalanceMinor: 112_500}), [
        entry('2026-03-01', 100_000, 'cleared'),
        entry('2026-03-02', 4_242),
      ]);
      expect(describeGap(someUnticked)).toMatch(/not ticked yet/);

      const doubled = build(statement({statementBalanceMinor: 90_000}), [entry('2026-03-01', 100_000, 'cleared')]);
      expect(describeGap(doubled)).toMatch(/books are 100\.00 ahead/);
      expect(describeGap(doubled)).toMatch(/recorded twice/);
      expect(describeGap(doubled)).toMatch(/missing from the books on the other side/);
      expect(describeGap(doubled)).not.toMatch(/not cleared the bank yet/);

      // On a CREDIT-normal account the signs invert but the sentence must not:
      // a card statement showing more debt than the books have ticked is still
      // "the statement is ahead".
      const card = build(statement({statementBalanceMinor: -30_000}), [entry('2026-03-01', -24_000, 'cleared')], CARD_ACCOUNTS);
      expect(card.differenceMinor).toBe(-6_000);
      expect(describeGap(card)).toMatch(/statement is 60\.00 ahead/);
    });

    it('a BALANCED sheet still owes a caveat when something on the books is unmatched', () => {
      const describeUnmatchedCaveat = mod().describeUnmatchedCaveat as (s: ReconcileSheet) => string | null;
      // Zero difference, one unticked posting — the canonical duplicate.
      const withDupe = build(statement({statementBalanceMinor: 100_000}), [
        entry('2026-03-01', 100_000, 'cleared'),
        entry('2026-03-02', -95_000),
      ]);
      expect(withDupe.balanced).toBe(true);
      const caveat = describeUnmatchedCaveat(withDupe)!;
      // The AMOUNT, and BOTH possibilities — LGR-22. Naming only the duplicate
      // reading sends the (much more common) "it just hasn't cleared yet" case
      // hunting for an error that is not there; naming only the innocent one is
      // silence at the moment the books are being certified.
      expect(caveat).toMatch(/^1 posting totalling 950\.00 Cr is on the books but not on this statement\./);
      expect(caveat).toMatch(/not cleared the bank yet that is expected/);
      expect(caveat).toMatch(/recorded twice, this account is still out by 950\.00/);
      expect(caveat).toMatch(/finishing here will not correct it/);
      expect(caveat).not.toMatch(/\(s\)/);
      // Plural reads as a sentence too.
      const two = build(statement({statementBalanceMinor: 100_000}), [
        entry('2026-03-01', 100_000, 'cleared'),
        entry('2026-03-02', -95_000),
        entry('2026-03-03', -1_000),
      ]);
      expect(describeUnmatchedCaveat(two)).toMatch(/^2 postings totalling 960\.00 Cr are on the books/);
      expect(describeUnmatchedCaveat(two)).toMatch(/If any were recorded twice/);
      // Nothing unmatched, or not balanced yet ⇒ silence.
      expect(describeUnmatchedCaveat(build(statement({statementBalanceMinor: 100_000}), [entry('2026-03-01', 100_000, 'cleared')]))).toBeNull();
      expect(describeUnmatchedCaveat(build(statement({statementBalanceMinor: 1}), [entry('2026-03-01', 100_000)]))).toBeNull();
    });

    it('names the posting that would close the gap — in BOTH directions', () => {
      const describeSingleCulprit = mod().describeSingleCulprit as (s: ReconcileSheet) => string | null;
      // TICK: one unticked row worth exactly the difference.
      const exact = build(statement({statementBalanceMinor: 100_000}), [
        entry('2026-03-01', 95_000, 'cleared'),
        entry('2026-03-02', 5_000, 'pending', {description: 'Late payment'}),
      ]);
      expect(exact.differenceMinor).toBe(5_000);
      expect(describeSingleCulprit(exact)).toBe('One unticked posting would close this exactly: 2026-03-02 “Late payment”, 50.00 Dr.');
      // TWO unticked rows of the same amount ARE ambiguous — they are two
      // different entries, and pointing at one would be a guess.
      const ambiguous = build(statement({statementBalanceMinor: 100_000}), [
        entry('2026-03-01', 95_000, 'cleared'),
        entry('2026-03-02', 5_000, 'pending', {description: 'One thing'}),
        entry('2026-03-03', 5_000, 'pending', {description: 'Another thing'}),
      ]);
      expect(describeSingleCulprit(ambiguous)).toBeNull();

      // UNTICK — the direction the canonical fixture actually turns on, and the
      // one this was silent about. Two IDENTICAL ticked rows are not ambiguity;
      // they are the signature of a duplicate, and either may be unticked.
      // cleared = 4,664.50; unticking one 950.00 Cr rent raises it to 5,614.50,
      // which is exactly the statement — so the gap is 950.00 Dr.
      const duplicate = build(statement({statementBalanceMinor: 561_450}), [
        entry('2026-02-20', -95_000, 'cleared', {id: 'tx-a', description: 'Rent — February'}),
        entry('2026-02-20', -95_000, 'cleared', {id: 'tx-b', description: 'Rent — February'}),
        entry('2026-03-01', 656_450, 'cleared'),
      ]);
      expect(duplicate.differenceMinor).toBe(95_000);
      expect(describeSingleCulprit(duplicate)).toBe(
        'Unticking either of two identical postings would close this exactly: 2026-02-20 “Rent — February”, 950.00 Cr.',
      );
      // Three identical ones read as a sentence too.
      const triple = build(statement({statementBalanceMinor: 466_450}), [
        entry('2026-02-20', -95_000, 'cleared', {id: 'tx-a', description: 'Rent — February'}),
        entry('2026-02-20', -95_000, 'cleared', {id: 'tx-b', description: 'Rent — February'}),
        entry('2026-02-20', -95_000, 'cleared', {id: 'tx-c', description: 'Rent — February'}),
        entry('2026-03-01', 656_450, 'cleared'),
      ]);
      expect(describeSingleCulprit(triple)).toMatch(/^Unticking any one of 3 identical postings/);
      // …but two ticked rows of the same amount on DIFFERENT days are two
      // different entries again, and silence is correct.
      const notIdentical = build(statement({statementBalanceMinor: 561_450}), [
        entry('2026-02-20', -95_000, 'cleared', {id: 'tx-a', description: 'Rent'}),
        entry('2026-03-20', -95_000, 'cleared', {id: 'tx-b', description: 'Rent'}),
        entry('2026-03-01', 656_450, 'cleared'),
      ]);
      expect(describeSingleCulprit(notIdentical)).toBeNull();

      // Nothing exact, and a balanced sheet, both stay silent.
      expect(describeSingleCulprit(build(statement({statementBalanceMinor: 100_000}), [entry('2026-03-01', 95_000, 'cleared')]))).toBeNull();
      expect(describeSingleCulprit(build(statement({statementBalanceMinor: 95_000}), [entry('2026-03-01', 95_000, 'cleared')]))).toBeNull();
    });

    it('every checklist row has a DISTINCT accessible name, carrying its amount and lock reason', () => {
      const describeRowLabel = mod().describeRowLabel as (s: ReconcileSheet, r: ReconcileRow) => string;
      // The canonical duplicate: same date, same description, same amount.
      const sheet = build(statement({statementBalanceMinor: 0}), [
        entry('2026-02-20', -95_000, 'pending', {id: 'tx-a', entryNo: 6, description: 'Rent — February'}),
        entry('2026-02-20', -95_000, 'pending', {id: 'tx-b', entryNo: 7, description: 'Rent — February'}),
      ]);
      const labels = sheet.rows.map((r) => describeRowLabel(sheet, r));
      expect(new Set(labels).size).toBe(2); // …and they are TELLABLE APART
      expect(labels[0]).toContain('entry #6');
      expect(labels[1]).toContain('entry #7');
      // The amount is what a reconciliation is about; it was absent entirely.
      for (const label of labels) expect(label).toContain('950.00 Cr');

      // A locked row carries its reason IN the name — a disabled checkbox is
      // out of the tab order, so a sibling note is unreachable.
      const january: Statement = {id: 'rec-0', accountId: BANK, statementDate: '2026-01-31', statementBalanceMinor: 0, status: 'finished'};
      const march = statement({id: 'rec-1', statementBalanceMinor: 50_000});
      const locked = build(march, [entry('2026-01-10', 50_000, 'reconciled', {reconciliationId: 'rec-0'})], ACCOUNTS, [january, march]);
      expect(describeRowLabel(locked, locked.rows[0])).toMatch(/Locked by the reconciliation of the 2026-01-31 statement\.$/);
    });

    it('summarises the ticks and the standing lock caveat, and stays silent when empty', () => {
      const describeReconcileSummary = mod().describeReconcileSummary as (s: ReconcileSheet) => string;
      const describeFrozenElsewhere = mod().describeFrozenElsewhere as (s: ReconcileSheet) => string | null;

      const sheet = build(statement({statementBalanceMinor: 100_000}), [entry('2026-03-01', 100_000, 'cleared'), entry('2026-03-02', -450)]);
      expect(describeReconcileSummary(sheet)).toBe('1 posting matched · 1 unmatched (4.50 Cr)');
      expect(describeFrozenElsewhere(sheet)).toBeNull(); // nothing locked ⇒ no notice

      const clean = build(statement({statementBalanceMinor: 100_000}), [entry('2026-03-01', 100_000, 'cleared')]);
      expect(describeReconcileSummary(clean)).toBe('1 posting matched · nothing unmatched');

      // The singular branch is a sentence, not a template with an `(s)` in it.
      const january: Statement = {id: 'rec-0', accountId: BANK, statementDate: '2026-01-31', statementBalanceMinor: 0, status: 'finished'};
      const march = statement({id: 'rec-1', statementBalanceMinor: 50_000});
      const locked = build(march, [entry('2026-01-10', 50_000, 'reconciled', {reconciliationId: 'rec-0'})], ACCOUNTS, [january, march]);
      expect(describeFrozenElsewhere(locked)).toMatch(/^1 posting is locked by an earlier finished statement\./);
      expect(describeFrozenElsewhere(locked)).not.toMatch(/\(s\)/);
    });
  });

  describe('LGR-22 — recovering from a statement that can never balance', () => {
    const describeGap = (s: ReconcileSheet): string | null => (mod().describeGap as (x: ReconcileSheet) => string | null)(s);

    it('recognises the 2× signature of a balance typed on the wrong side', () => {
      // The mechanism: 1,000.00 held, typed as −1,000.00. The books are RIGHT
      // and every row is ticked, so no amount of ticking can move this — the
      // target is out by 2,000.00 and the difference reads exactly twice the
      // balance. Generic advice ("look for a missing entry") sends the reader
      // into books that are already correct.
      const flipped = build(statement({statementBalanceMinor: -100_000}), [entry('2026-03-01', 100_000, 'cleared')]);
      expect(flipped.differenceMinor).toBe(-200_000);
      const gap = describeGap(flipped)!;
      expect(gap).toMatch(/^The difference is 2,000\.00 — exactly twice the closing balance you typed\./);
      expect(gap).toMatch(/signature of a balance entered on the wrong side/);
      // …and it points at the control that fixes it, which is the whole point.
      expect(gap).toMatch(/Amend statement/);
      // It must NOT also serve the generic two-causes advice: that sentence
      // tells the reader to search the books, and here the books are right.
      expect(gap).not.toMatch(/missing from the books/);

      // Same on a credit-normal account, where the signs invert.
      const card = build(statement({statementBalanceMinor: 24_000}), [entry('2026-03-01', -24_000, 'cleared')], CARD_ACCOUNTS);
      expect(describeGap(card)).toMatch(/exactly twice the closing balance you typed/);
      expect(describeGap(card)).toMatch(/a positive number is a balance you owe/);
    });

    it('does NOT fire on an ordinary gap that merely happens to be large', () => {
      // 1,125.00 statement, 1,000.00 cleared: a 125.00 gap. Twice the balance
      // would be 2,250.00 — the heuristic has to be arithmetic, not a vibe.
      const ordinary = build(statement({statementBalanceMinor: 112_500}), [entry('2026-03-01', 100_000, 'cleared')]);
      expect(describeGap(ordinary)).not.toMatch(/twice the closing balance/);
      expect(describeGap(ordinary)).toMatch(/missing from the books/);

      // A ZERO statement balance doubles to zero, which would "equal" every
      // difference if the guard were missing — and "twice nothing" is no signal.
      const emptyTarget = build(statement({statementBalanceMinor: 0}), [entry('2026-03-01', 100_000, 'cleared')]);
      expect(emptyTarget.differenceMinor).toBe(-100_000);
      expect(describeGap(emptyTarget)).not.toMatch(/twice the closing balance/);
    });

    it('survives a balance too large to DOUBLE — generic advice, never a throw', () => {
      // `parseAmount` accepts balances all the way to ±(2^53 − 1) minor units,
      // so any legally typed balance past HALF that ceiling made the unguarded
      // doubling throw MoneyRangeError — and `describeGap` runs OUTSIDE the
      // block's fold try/catch, so the throw took the whole block down on a
      // legal input. The guard must fall through to the generic advice, not
      // crash and not stay silent.
      const HUGE = Number.MAX_SAFE_INTEGER - 1; // typeable, un-doubleable
      const extreme = build(statement({statementBalanceMinor: HUGE}), [entry('2026-03-01', 100_000, 'cleared')]);
      expect(extreme.balanced).toBe(false);
      let gap: string | null = null;
      expect(() => {
        gap = describeGap(extreme);
      }).not.toThrow();
      expect(gap).toMatch(/missing from the books/);
      expect(gap).not.toMatch(/twice the closing balance/);
    });

    it('the generic advice also suspects the TYPED balance, and names the control that fixes it', () => {
      // Parker's transposed-digits case: 1,250.00 typed as 1,205.00 produces an
      // arbitrary 45.00 gap — not the 2× signature — while the books are
      // exactly right. Advice that pointed only at the books sent the reader
      // searching entries that were already correct; the typed target is the
      // third suspect, in BOTH directions, and the sentence points at Amend.
      const transposed = build(statement({statementBalanceMinor: 120_500}), [entry('2026-03-01', 125_000, 'cleared')]);
      expect(transposed.differenceMinor).toBe(-4_500);
      expect(describeGap(transposed)).toMatch(/re-check the closing balance you typed — “Amend statement” corrects it/);
      const otherWay = build(statement({statementBalanceMinor: 125_000}), [entry('2026-03-01', 120_500, 'cleared')]);
      expect(describeGap(otherWay)).toMatch(/re-check the closing balance you typed/);
    });

    it('gap and culprit guidance render ONLY on an open sheet — instructions need their controls', () => {
      // An abandoned sheet is unbalanced almost by definition and reachable
      // through View. Every sentence these two produce is an instruction —
      // tick, untick, amend — and on a non-open sheet none of those controls
      // exist. Worst case before the guard: the 2× hint said "Correct it with
      // 'Amend statement'" on a screen with no Amend button.
      const describeSingleCulprit = mod().describeSingleCulprit as (s: ReconcileSheet) => string | null;
      const rows = [entry('2026-03-01', 100_000, 'cleared'), entry('2026-03-02', 5_000, 'pending', {description: 'Late payment'})];
      // Sanity: the SAME sheet, open, produces both sentences…
      const open = build(statement({statementBalanceMinor: 105_000}), rows);
      const ticked = open.rows.find((r) => !r.matched)!;
      expect(open.differenceMinor).toBe(5_000);
      expect(describeGap(open)).not.toBeNull();
      expect(describeSingleCulprit(open)).toContain(ticked.description);
      // …and abandoned, it produces neither — including the 2× signature.
      const abandoned = build(statement({statementBalanceMinor: 105_000, status: 'abandoned'}), rows);
      expect(describeGap(abandoned)).toBeNull();
      expect(describeSingleCulprit(abandoned)).toBeNull();
      const flippedAbandoned = build(statement({statementBalanceMinor: -100_000, status: 'abandoned'}), [entry('2026-03-01', 100_000, 'cleared')]);
      expect(describeGap(flippedAbandoned)).toBeNull();
    });

    it('a locked row names the REAL reason: frozen, finished sheet, or abandoned sheet', () => {
      const describeRowLabel = mod().describeRowLabel as (s: ReconcileSheet, r: ReconcileRow) => string;
      const rows = [entry('2026-03-01', 100_000, 'cleared')];
      // On an ABANDONED sheet the row is locked because the SHEET is dead, not
      // because anything was reconciled — the fall-through that said "Locked by
      // a finished reconciliation" here asserted the opposite of the truth on
      // every checkbox, exactly where abandon-vs-finish confusion matters most.
      const abandoned = build(statement({statementBalanceMinor: 100_000, status: 'abandoned'}), rows);
      expect(abandoned.rows[0].frozen).toBe(false);
      const abandonedLabel = describeRowLabel(abandoned, abandoned.rows[0]);
      expect(abandonedLabel).toMatch(/This statement was abandoned — nothing here was reconciled/);
      expect(abandonedLabel).not.toMatch(/finished reconciliation/);
      // A finished sheet's own frozen row still names the freezing statement…
      const finished = build(statement({statementBalanceMinor: 100_000, status: 'finished'}), [
        entry('2026-03-01', 100_000, 'reconciled', {reconciliationId: 'rec-1'}),
        entry('2026-03-02', -450, 'pending', {description: 'Bank fee'}),
      ]);
      expect(describeRowLabel(finished, finished.rows[0])).toMatch(/Locked by the reconciliation of the 2026-03-31 statement\.$/);
      // …and its NON-frozen (unmatched) row is locked by the sheet's state,
      // with the reopen path named rather than a frozen-row sentence borrowed.
      expect(finished.rows[1].frozen).toBe(false);
      expect(describeRowLabel(finished, finished.rows[1])).toMatch(/This statement is reconciled — reopen it to change what it matched\.$/);
    });

    it('an ABANDONED sheet offers neither Finish nor Reopen, and locks every row', () => {
      interface FinishBlock {rule: string; live: string | null}
      const describeFinishBlock = mod().describeFinishBlock as (s: ReconcileSheet) => FinishBlock | null;
      const isRowLocked = mod().isRowLocked as (s: ReconcileSheet, r: ReconcileRow) => boolean;
      const LABEL = mod().RECONCILIATION_STATUS_LABEL as Record<string, string>;

      // Balanced by coincidence AND abandoned: `canFinish` must be false on the
      // status alone, because the server's finish requires an OPEN record and a
      // live-looking button here would be a control whose every use is a 409.
      const gone = build(statement({statementBalanceMinor: 100_000, status: 'abandoned'}), [
        entry('2026-03-01', 100_000, 'cleared'),
        entry('2026-03-02', -450),
      ]);
      expect(gone.balanced).toBe(true);
      expect(gone.canFinish).toBe(false);
      const block = describeFinishBlock(gone)!;
      expect(block.rule).toMatch(/was abandoned/);
      // It names the way FORWARD. Reopen does not apply (nothing was frozen),
      // so a screen that only said "abandoned" would be a dead end with no exit.
      expect(block.rule).toMatch(/start a new reconciliation/i);
      expect(block.rule).not.toMatch(/reopen/i);
      expect(block.live).toBeNull();
      // Ticking is refused server-side on a non-open record: every checkbox is
      // locked, including the ones this statement never froze.
      expect(gone.rows.every((r) => isRowLocked(gone, r))).toBe(true);
      expect(gone.rows.every((r) => !r.frozen)).toBe(true); // …and none of them are frozen
      expect(LABEL.abandoned).toBe('Abandoned');
    });

    it('the outstanding-items section is a FINISHED-statement affordance, counted by ONE predicate', () => {
      const heading = mod().describeOutstandingHeading as (s: ReconcileSheet) => string | null;
      const isOutstanding = mod().isOutstanding as (r: ReconcileRow) => boolean;

      const open = build(statement({statementBalanceMinor: 100_000}), [
        entry('2026-03-01', 100_000, 'cleared'),
        entry('2026-03-02', -95_000, 'pending', {description: 'Rent — February'}),
      ]);
      // While open, the live difference and the caveat are already saying this
      // against a number that moves — a second standing section would be noise.
      expect(heading(open)).toBeNull();

      const done = build(statement({statementBalanceMinor: 100_000, status: 'finished'}), [
        entry('2026-03-01', 100_000, 'reconciled', {reconciliationId: 'rec-1'}),
        entry('2026-03-02', -95_000, 'pending', {description: 'Rent — February'}),
      ]);
      expect(heading(done)).toBe('Outstanding items (1 · 950.00 Cr)');
      // THE HEADING AND THE LIST MUST DESCRIBE THE SAME SET. They are computed
      // in two places — the fold's counters and the section's row filter — so
      // this pins them to the one exported predicate rather than to two copies
      // of `!row.matched` free to drift.
      const listed = done.rows.filter(isOutstanding);
      expect(listed).toHaveLength(done.unmatchedCount);
      expect(listed.map((r) => r.description)).toEqual(['Rent — February']);

      // Nothing left over ⇒ no section at all.
      const clean = build(statement({statementBalanceMinor: 100_000, status: 'finished'}), [
        entry('2026-03-01', 100_000, 'reconciled', {reconciliationId: 'rec-1'}),
      ]);
      expect(heading(clean)).toBeNull();
    });

    it('the amend form prefills a value its OWN parser can read back', () => {
      // `formatOnNormalSide` renders an abnormal balance as `250.00 Cr`, which
      // `parseStatementBalance` rejects — a box born holding a value the Save
      // button refuses. The editable form must round-trip on both sides,
      // including overdrawn/in-credit.
      const toInput = mod().statementBalanceInput as (m: number, s: 'debit' | 'credit') => string;
      const parse = mod().parseStatementBalance as (raw: string, s: 'debit' | 'credit') => BalanceResult;
      for (const [minor, side] of [
        [125_000, 'debit'],
        [-32_055, 'debit'], // overdrawn current account
        [-125_000, 'credit'],
        [32_055, 'credit'], // credit card in credit
        [0, 'debit'],
      ] as Array<[number, 'debit' | 'credit']>) {
        const text = toInput(minor, side);
        const back = parse(text, side);
        expect(back.ok).toBe(true);
        if (back.ok) expect(back.minor).toBe(minor);
      }
      // …and the ordinary case is the plain number the statement prints.
      expect(toInput(125_000, 'debit')).toBe('1,250.00');
      expect(toInput(-125_000, 'credit')).toBe('1,250.00');
    });
  });

  describe('the register carries a finished reconciliation through (LGR-11 ⇄ LGR-8)', () => {
    it('names the statement a reconciled posting belongs to', () => {
      interface RegisterRow {
        postingId: string;
        cleared: string;
        reconciledStatementDate: string | null;
      }
      const buildAccountRegister = mod().buildAccountRegister as (
        a: string,
        b: ReportAccount[],
        c: ReportTransaction[],
        d: Record<string, unknown>,
        e: Array<{id: string; statementDate: string}>,
      ) => {rows: RegisterRow[]};

      const txs = [entry('2026-03-01', 100_000, 'reconciled', {reconciliationId: 'rec-1'}), entry('2026-03-02', -450, 'cleared')];
      const rows = buildAccountRegister(BANK, ACCOUNTS, txs, {}, [{id: 'rec-1', statementDate: '2026-03-31'}]).rows;
      expect(rows.map((r) => r.cleared)).toEqual(['reconciled', 'cleared']);
      expect(rows[0].reconciledStatementDate).toBe('2026-03-31');
      // A cleared (not reconciled) posting names no statement — it belongs to none.
      expect(rows[1].reconciledStatementDate).toBeNull();
      // …and a reconciled posting whose statement is outside this read says so
      // by carrying `null`, rather than inventing a date.
      const orphan = buildAccountRegister(BANK, ACCOUNTS, txs, {}, []).rows;
      expect(orphan[0].reconciledStatementDate).toBeNull();
    });

    it('is unaffected when the caller supplies no reconciliations at all (additive)', () => {
      const buildAccountRegister = mod().buildAccountRegister as (
        a: string,
        b: ReportAccount[],
        c: ReportTransaction[],
      ) => {rows: Array<{reconciledStatementDate: string | null}>; closingMinor: number};
      const result = buildAccountRegister(BANK, ACCOUNTS, [entry('2026-03-01', 100_000, 'cleared')]);
      expect(result.closingMinor).toBe(100_000);
      expect(result.rows[0].reconciledStatementDate).toBeNull();
    });
  });
});
