/**
 * Deterministic fixture books for the Beancount reference harness (LGR-13).
 *
 * The parity/bean-check gate needs a 500-transaction book; committing the
 * serialized fixture would be megabytes of noise, so the GENERATOR is the
 * artifact: seeded, pure, no clock — every call reproduces the identical book,
 * so the exported journal is byte-identical across machines and runs (which is
 * itself asserted by the byte-stability tests).
 *
 * Two books:
 *  - {@link buildBeancountMiniBook} — small and hostile: names that need
 *    mangling (spaces, unicode, lowercase, a bare-root name, a mangling
 *    collision), quote/backslash/newline text, a reversal pair, evidence,
 *    a closed period with its closing entry, and a draft (which must NOT
 *    export);
 *  - {@link buildBeancountParityBook} — exactly 500 reported (posted + void)
 *    transactions across two currencies, with reversal pairs, a closed period
 *    (closing entry + balance assertions), a reopened period (void closing
 *    entry + reversal), evidence, and drafts.
 *
 * Exported from the SDK because three consumers must share ONE book: the sdk
 * unit tests, the ui parity gate (which runs the plugin's LGR-8 fold through
 * the real loader), and the CI bean-check job.
 */

import {sumAmounts} from './money';
import type {
  LedgerAccount,
  LedgerAccountType,
  LedgerClearedState,
  LedgerEvidence,
  LedgerPeriod,
  LedgerPosting,
  LedgerTransaction,
} from './ledger';

/** The entity slices {@link buildLedgerBeancount} consumes — one book. */
export interface LedgerBeancountFixtureBook {
  accounts: LedgerAccount[];
  transactions: LedgerTransaction[];
  periods: LedgerPeriod[];
}

/** mulberry32 — tiny deterministic PRNG; good enough to spread fixture data. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `base + days`, as ISO `YYYY-MM-DD` (UTC). */
function isoDay(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** A stable fake row timestamp — index-ordered so creation order is total. */
function stamp(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + index * 1000).toISOString();
}

interface TxSpec {
  date: string;
  description: string;
  postings: Array<{accountId: string; amountMinor: number; memo?: string; cleared?: LedgerClearedState}>;
  state?: 'draft' | 'posted' | 'void';
  reverses?: string | null;
  kind?: 'closing' | null;
  evidence?: LedgerEvidence[];
}

/** Book assembler: sequential ids/entry numbers, balanced-by-construction. */
class BookBuilder {
  readonly accounts: LedgerAccount[] = [];
  readonly transactions: LedgerTransaction[] = [];
  readonly periods: LedgerPeriod[] = [];
  private seq = 0;

  account(name: string, type: LedgerAccountType, currency = 'USD'): LedgerAccount {
    this.seq += 1;
    const account: LedgerAccount = {
      id: `fx-a-${String(this.accounts.length + 1).padStart(2, '0')}`,
      name,
      type,
      status: 'open',
      currency,
      createdAt: stamp(this.seq),
      updatedAt: stamp(this.seq),
    };
    this.accounts.push(account);
    return account;
  }

  tx(spec: TxSpec): LedgerTransaction {
    this.seq += 1;
    const state = spec.state ?? 'posted';
    const id = `fx-t-${String(this.transactions.length + 1).padStart(4, '0')}`;
    const postings: LedgerPosting[] = spec.postings.map((p, i) => ({
      id: `${id}-p${i + 1}`,
      transactionId: id,
      accountId: p.accountId,
      amountMinor: p.amountMinor,
      cleared: p.cleared ?? 'pending',
      reconciliationId: null,
      memo: p.memo ?? null,
    }));
    const drift = sumAmounts(postings.map((p) => p.amountMinor));
    if (state !== 'draft' && drift !== 0) {
      throw new Error(`fixture bug: transaction ${id} is out of balance by ${drift} minor units`);
    }
    const entryNo = state === 'draft' ? null : this.transactions.filter((t) => t.entryNo != null).length + 1;
    const tx: LedgerTransaction = {
      id,
      date: spec.date,
      description: spec.description,
      state,
      postedAt: state === 'draft' ? null : stamp(this.seq),
      postedBy: state === 'draft' ? null : 'https://fixture.book.pub#keeper',
      reverses: spec.reverses ?? null,
      entryNo,
      kind: spec.kind ?? null,
      evidence: spec.evidence ?? [],
      postings,
      createdAt: stamp(this.seq),
      updatedAt: stamp(this.seq),
    };
    this.transactions.push(tx);
    return tx;
  }

  /**
   * Reverse a posted transaction the way the store does: the original flips to
   * `void`, and a reversal posts with every leg negated and `reverses` set.
   */
  reverse(original: LedgerTransaction, date: string): LedgerTransaction {
    original.state = 'void';
    return this.tx({
      date,
      description: `Reversal of ${original.description}`,
      postings: original.postings.map((p) => ({accountId: p.accountId, amountMinor: -p.amountMinor})),
      reverses: original.id,
    });
  }

  /**
   * Close `[start, end]` the way the store does: sweep every income-statement
   * account's reported balance as of `end` into retained earnings via a
   * `closing` entry dated `end`, and record the period. Returns the entry
   * (`null` when nothing needed sweeping).
   */
  closePeriod(start: string, end: string, retainedEarnings: LedgerAccount, incomeStatementAccounts: readonly LedgerAccount[]): {period: LedgerPeriod; closingEntry: LedgerTransaction | null} {
    const legs: Array<{accountId: string; amountMinor: number}> = [];
    for (const account of incomeStatementAccounts) {
      const amounts: number[] = [];
      for (const t of this.transactions) {
        if (t.state === 'draft' || t.date > end) continue;
        for (const p of t.postings) if (p.accountId === account.id) amounts.push(p.amountMinor);
      }
      const balance = sumAmounts(amounts);
      if (balance !== 0) legs.push({accountId: account.id, amountMinor: -balance});
    }
    const sweep = sumAmounts(legs.map((l) => l.amountMinor));
    let closingEntry: LedgerTransaction | null = null;
    if (legs.length > 0) {
      closingEntry = this.tx({
        date: end,
        description: `Closing entry ${start} .. ${end}`,
        postings: [...legs, {accountId: retainedEarnings.id, amountMinor: -sweep}],
        kind: 'closing',
      });
    }
    this.seq += 1;
    const period: LedgerPeriod = {
      id: `fx-per-${String(this.periods.length + 1).padStart(2, '0')}`,
      start,
      end,
      status: 'closed',
      closingEntryId: closingEntry?.id ?? null,
      reopenEntryId: null,
      closedAt: stamp(this.seq),
      closedBy: 'https://fixture.book.pub#keeper',
      reopenedAt: null,
      reopenedBy: null,
    };
    this.periods.push(period);
    return {period, closingEntry};
  }

  /** Reopen a closed period the way the store does: reversal voids the
   *  closing entry; the record flips to `reopened` (range unlocked, no
   *  balance assertions emitted for it). */
  reopenPeriod(period: LedgerPeriod, date: string): void {
    let reversal: LedgerTransaction | null = null;
    if (period.closingEntryId !== null) {
      const original = this.transactions.find((t) => t.id === period.closingEntryId);
      if (original) reversal = this.reverse(original, date);
    }
    this.seq += 1;
    period.status = 'reopened';
    period.reopenEntryId = reversal?.id ?? null;
    period.reopenedAt = stamp(this.seq);
    period.reopenedBy = 'https://fixture.book.pub#keeper';
  }

  book(): LedgerBeancountFixtureBook {
    return {accounts: this.accounts, transactions: this.transactions, periods: this.periods};
  }
}

/**
 * The small hostile book: mangling edge cases, hostile text, a reversal pair,
 * evidence, a closed period, and a draft that must not export.
 */
export function buildBeancountMiniBook(): LedgerBeancountFixtureBook {
  const b = new BookBuilder();
  const bank = b.account('Assets:Bank:Checking', 'asset');
  const bare = b.account('Assets', 'asset'); // bare root → Assets:Assets
  const card = b.account('Liabilities:CreditCard', 'liability');
  const opening = b.account('Equity:OpeningBalances', 'equity');
  const retained = b.account('Equity:RetainedEarnings', 'equity');
  const sales = b.account('Revenue:Sales', 'revenue'); // root remap → Income:Revenue:Sales
  const fees = b.account('Expenses:Bank Fees', 'expense'); // space → Expenses:Bank-Fees
  const feesClash = b.account('Expenses:Bank-Fees', 'expense'); // collision → …-2
  const cafe = b.account('Expenses:café & misc.', 'expense'); // unicode/punct mangle
  const lower = b.account('misc:stuff', 'expense'); // lowercase components

  b.tx({
    date: '2026-01-01',
    description: 'Opening balance',
    postings: [
      {accountId: bank.id, amountMinor: 500_000, cleared: 'cleared'},
      {accountId: opening.id, amountMinor: -500_000},
    ],
  });
  b.tx({
    date: '2026-01-05',
    description: 'He said "hi" \\ and \n typed =SUM(A1)',
    postings: [
      {accountId: bank.id, amountMinor: 123_456, memo: 'gross "wages" \\ note'},
      {accountId: sales.id, amountMinor: -123_456},
    ],
    evidence: [{filename: 'invoice-1.pdf', sha256: 'a'.repeat(64), size: 1234}],
  });
  const fee = b.tx({
    date: '2026-01-07',
    description: 'Wire fee (typo)',
    postings: [
      {accountId: fees.id, amountMinor: 2_500},
      {accountId: bank.id, amountMinor: -2_500},
    ],
  });
  b.reverse(fee, '2026-01-08');
  b.tx({
    date: '2026-01-09',
    description: 'Wire fee',
    postings: [
      {accountId: feesClash.id, amountMinor: 2_500},
      {accountId: bank.id, amountMinor: -2_500, cleared: 'cleared'},
    ],
  });
  b.tx({
    date: '2026-01-15',
    description: 'Coffee + sundries on the card',
    postings: [
      {accountId: cafe.id, amountMinor: 1_800, memo: 'espresso'},
      {accountId: lower.id, amountMinor: 700},
      {accountId: card.id, amountMinor: -2_500},
    ],
  });
  b.closePeriod('2026-01-01', '2026-01-31', retained, [sales, fees, feesClash, cafe, lower]);
  b.tx({
    date: '2026-02-02',
    description: 'A lingering draft (must not export)',
    postings: [
      {accountId: bank.id, amountMinor: 1},
      {accountId: bare.id, amountMinor: 1},
    ],
    state: 'draft',
  });
  return b.book();
}

/** How many reported (posted + void) transactions the parity book carries. */
export const BEANCOUNT_PARITY_TX_COUNT = 500;

/**
 * The 500-transaction parity book: two currencies, reversal pairs, one closed
 * period (with closing entry — its balance assertions gate the close in
 * bean-check), one reopened period, evidence, drafts.
 */
export function buildBeancountParityBook(): LedgerBeancountFixtureBook {
  const rnd = mulberry32(0x1ed6e12);
  const b = new BookBuilder();
  const bank = b.account('Assets:Bank:Checking', 'asset');
  const cash = b.account('Assets:Cash', 'asset');
  const savings = b.account('Assets:Savings', 'asset', 'EUR');
  const card = b.account('Liabilities:CreditCard', 'liability');
  const opening = b.account('Equity:OpeningBalances', 'equity');
  const retained = b.account('Equity:RetainedEarnings', 'equity');
  const revenue = b.account('Income:Revenue', 'revenue');
  const sales = b.account('Revenue:Sales', 'revenue');
  const interest = b.account('Income:Interest', 'revenue', 'EUR');
  const fees = b.account('Expenses:Bank Fees', 'expense');
  const hosting = b.account('Expenses:Hosting', 'expense');
  const office = b.account('Expenses:Office', 'expense');
  const dormant = b.account('Assets:Escrow', 'asset'); // zero postings — open only

  void dormant;
  const amount = (): number => 1 + Math.floor(rnd() * 99_999);
  const cleared = (): LedgerClearedState => (rnd() < 0.3 ? 'cleared' : 'pending');

  b.tx({
    date: '2024-01-01',
    description: 'Opening balance',
    postings: [
      {accountId: bank.id, amountMinor: 2_000_000, cleared: 'cleared'},
      {accountId: opening.id, amountMinor: -2_000_000},
    ],
  });

  // 487 randomized entries. Everything up to 2025-01-31 stays USD-only so both
  // period closes sweep a single currency (the store's closing entry is
  // uniform-currency — a mixed book could not close these ranges at all); the
  // EUR pair trades from February 2025 only.
  const reversalCandidates: LedgerTransaction[] = [];
  for (let i = 0; i < 487; i += 1) {
    const day = Math.floor(rnd() * 540); // 2024-01-01 .. 2025-06-23
    const date = isoDay('2024-01-01', day);
    const inEur = date >= '2025-02-01' && rnd() < 0.15;
    let tx: LedgerTransaction;
    if (inEur) {
      const a = amount();
      tx = b.tx({
        date,
        description: `Interest accrual #${i + 1}`,
        postings: [
          {accountId: savings.id, amountMinor: a, cleared: cleared()},
          {accountId: interest.id, amountMinor: -a},
        ],
      });
    } else if (rnd() < 0.45) {
      const a = amount();
      const into = rnd() < 0.7 ? bank : cash;
      const from = rnd() < 0.6 ? revenue : sales;
      tx = b.tx({
        date,
        description: `Sale #${i + 1} "receipt"`,
        postings: [
          {accountId: into.id, amountMinor: a, cleared: cleared()},
          {accountId: from.id, amountMinor: -a, memo: rnd() < 0.2 ? `order \\ ${i}` : undefined},
        ],
        evidence: rnd() < 0.05 ? [{filename: `receipt-${i}.pdf`, sha256: `${i.toString(16)}`.padStart(64, '0'), size: 100 + i}] : undefined,
      });
    } else if (rnd() < 0.5) {
      const a = amount();
      const b1 = amount();
      const spend = rnd() < 0.5 ? hosting : office;
      tx = b.tx({
        date,
        description: `Vendor bill #${i + 1}`,
        postings: [
          {accountId: spend.id, amountMinor: a, memo: rnd() < 0.15 ? `line "one" #${i}` : undefined},
          {accountId: fees.id, amountMinor: b1},
          {accountId: (rnd() < 0.5 ? bank : card).id, amountMinor: -(a + b1), cleared: cleared()},
        ],
      });
    } else {
      const a = amount();
      tx = b.tx({
        date,
        description: `Card payment #${i + 1}`,
        postings: [
          {accountId: card.id, amountMinor: a},
          {accountId: bank.id, amountMinor: -a, cleared: cleared()},
        ],
      });
    }
    if (reversalCandidates.length < 5 && rnd() < 0.03) reversalCandidates.push(tx);
  }

  // 5 reversal pairs (original flips void; reversal posts) — 10 of the 500.
  for (const original of reversalCandidates) {
    b.reverse(original, isoDay(original.date, 3) <= '2025-06-30' ? isoDay(original.date, 3) : original.date);
  }
  // A guaranteed January-2025 sale, so the Jan-2025 close below always has an
  // income balance to sweep (its closing entry + reversal are counted on).
  b.tx({
    date: '2025-01-15',
    description: 'January retainer',
    postings: [
      {accountId: bank.id, amountMinor: 150_000, cleared: 'cleared'},
      {accountId: revenue.id, amountMinor: -150_000},
    ],
  });
  // Top up to exactly 497 reported: the 2024 closing entry (498), the Jan-2025
  // closing entry (499) and the reopen's reversal (500) complete the book.
  while (b.transactions.filter((t) => t.entryNo != null).length < BEANCOUNT_PARITY_TX_COUNT - 3) {
    const a = amount();
    b.tx({
      date: isoDay('2025-06-24', b.transactions.length % 6),
      description: `Top-up entry ${b.transactions.length}`,
      postings: [
        {accountId: office.id, amountMinor: a},
        {accountId: bank.id, amountMinor: -a},
      ],
    });
  }

  // Close 2024 (USD-only activity ⇒ uniform-currency sweep).
  const incomeStatement = [revenue, sales, interest, fees, hosting, office];
  b.closePeriod('2024-01-01', '2024-12-31', retained, incomeStatement);

  // Close and REOPEN January 2025: the closing entry flips void and its
  // reversal posts — a reopened period must emit NO balance assertions while
  // both halves of the voided close still export.
  const jan = b.closePeriod('2025-01-01', '2025-01-31', retained, incomeStatement);
  if (jan.closingEntry === null) throw new Error('fixture bug: the Jan-2025 close swept nothing');
  b.reopenPeriod(jan.period, '2025-02-03');

  // Drafts never export (two of them, one empty-ish).
  b.tx({date: '2025-06-30', description: 'draft: pending vendor bill', postings: [{accountId: office.id, amountMinor: 4_200}, {accountId: bank.id, amountMinor: -4_200}], state: 'draft'});
  b.tx({date: '2025-07-01', description: 'draft: notes only', postings: [], state: 'draft'});

  const reported = b.transactions.filter((t) => t.entryNo != null).length;
  if (reported !== BEANCOUNT_PARITY_TX_COUNT) {
    throw new Error(`fixture bug: parity book carries ${reported} reported transactions, expected ${BEANCOUNT_PARITY_TX_COUNT}`);
  }
  return b.book();
}
