import {formatAmount, negateAmount, sumAmounts} from '@book.dev/plugin-sdk';

/**
 * Pure report folds (LGR-8) — no React, no IO, no host calls.
 *
 * WHY A FOLD AND NOT A FORMULA: `expr`/rollup cannot aggregate ACROSS database
 * rows (proved in `docs/ledger/platform-audit.md`), so every ledger report is
 * computed here in JS from the transactions the plugin already reads, and the
 * blocks only render what these functions return. Keeping the arithmetic in one
 * dependency-free module is also what makes it unit-testable through the real
 * loader — the report blocks own no numbers of their own.
 *
 * MONEY DISCIPLINE: amounts are SIGNED INTEGER MINOR UNITS (LGR-2) and every
 * one of them is added with `sumAmounts` / flipped with `negateAmount` and
 * rendered with `formatAmount`. No `Number()`, no `parseFloat`, no `Math.*`,
 * and no `+`/`-` on an amount anywhere — here or (especially) in the view.
 * `sumAmounts` throws {@link MoneyRangeError} on a stored value that is not a
 * safe integer, which is deliberate: a report must fail loudly rather than
 * quietly show a wrong total.
 *
 * SIGN CONVENTION: a posting's `amountMinor` is DEBIT-POSITIVE (the ledger's
 * own convention — every entry sums to zero). Account balances therefore come
 * out debit-positive too; the display side of "is that normal for this account"
 * is {@link normalSideFor} + `normalMinor`/`abnormal` on the row, never a
 * re-signing of the underlying amount.
 *
 * DRAFTS: excluded from every report. Posted AND void entries both count —
 * a void original is offset exactly by its posted reversal, which is precisely
 * how the server computes `accountPostedBalance`, so these folds and the server
 * agree by construction.
 */

export type ReportAccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type ReportClearedState = 'pending' | 'cleared' | 'reconciled';
export type ReportTransactionState = 'draft' | 'posted' | 'void';

/** Which side of an account its ordinary (non-contra) balance sits on. */
export type NormalSide = 'debit' | 'credit';

/** The account fields a report needs (a structural slice of `LedgerAccount`). */
export interface ReportAccount {
  id: string;
  name: string;
  type: ReportAccountType;
}

/** The posting fields a report needs (a structural slice of `LedgerPosting`). */
export interface ReportPosting {
  id: string;
  accountId: string;
  amountMinor: number;
  cleared: ReportClearedState;
}

/** The transaction fields a report needs (a structural slice of `LedgerTransaction`). */
export interface ReportTransaction {
  id: string;
  date: string;
  description: string;
  state: ReportTransactionState;
  entryNo: number | null;
  /**
   * The transaction this one REVERSES, when it is a reversal (LGR-6). Optional
   * only because a report may be handed an older/partial payload; the server
   * always sends it, and a missing value degrades to "no known counterpart"
   * rather than to a wrong link.
   */
  reverses?: string | null;
  postings: ReportPosting[];
}

/** The transaction states a report counts. Drafts are NEVER in here. */
export const REPORTED_STATES: readonly ReportTransactionState[] = ['posted', 'void'];

/** Every cleared state, in workflow order — the default register filter. */
export const ALL_CLEARED_STATES: readonly ReportClearedState[] = ['pending', 'cleared', 'reconciled'];

const DEBIT_NORMAL_TYPES: readonly ReportAccountType[] = ['asset', 'expense'];

/**
 * Does this transaction reach the books? Posted and void do; a draft is a
 * work-in-progress and is excluded from every report (and SAID to be excluded —
 * see {@link describeDraftExclusion}).
 */
export function isReported(tx: {state: ReportTransactionState}): boolean {
  return REPORTED_STATES.includes(tx.state);
}

/**
 * Display labels for the cleared states. Lives here, beside the enum, so user
 * copy never leaks the raw lowercase ids (`"pending, cleared"`) into a sentence.
 */
export const CLEARED_LABEL: Record<ReportClearedState, string> = {
  pending: 'Pending',
  cleared: 'Cleared',
  reconciled: 'Reconciled',
};

/**
 * A signed minor-unit amount in the reports' ONE notation: magnitude plus the
 * side it falls on (`1,234.56 Dr` / `500.00 Cr`), and a bare `0.00` at zero.
 *
 * Both blocks use this, so the register's amounts and the trial balance's
 * columns say debit-and-credit the same way — a bare `-250.00` in one report
 * beside `250.00 Cr` in the other is the same fact in two notations, and the
 * reader has to translate. The sign never leaves the money core: the magnitude
 * comes from `negateAmount`, never `Math.abs`.
 */
export function formatWithSide(minor: number): string {
  if (minor === 0) return formatAmount(0);
  return `${formatAmount(minor > 0 ? minor : negateAmount(minor))} ${minor > 0 ? 'Dr' : 'Cr'}`;
}

/** Assets and expenses are debit-normal; liabilities, equity and revenue are credit-normal. */
export function normalSideFor(type: ReportAccountType | null): NormalSide {
  return type !== null && DEBIT_NORMAL_TYPES.includes(type) ? 'debit' : 'credit';
}

/** How many of these transactions are drafts (the number the exclusion label names). */
export function countDrafts(transactions: readonly ReportTransaction[]): number {
  return transactions.filter((tx) => tx.state === 'draft').length;
}

/**
 * Per-account posted balances in signed (debit-positive) minor units — the
 * rollup-free "sum this column, grouped by account" the platform cannot do for
 * us. Accounts with no postings are absent from the map (a caller treats a miss
 * as `0`); draft transactions contribute nothing.
 */
export function accountBalances(transactions: readonly ReportTransaction[]): Map<string, number> {
  const amountsByAccount = new Map<string, number[]>();
  for (const tx of transactions) {
    if (!isReported(tx)) continue;
    for (const posting of tx.postings) {
      const amounts = amountsByAccount.get(posting.accountId);
      if (amounts) amounts.push(posting.amountMinor);
      else amountsByAccount.set(posting.accountId, [posting.amountMinor]);
    }
  }
  const balances = new Map<string, number>();
  amountsByAccount.forEach((amounts, accountId) => balances.set(accountId, sumAmounts(amounts)));
  return balances;
}

// ── Trial balance ─────────────────────────────────────────────────────────────

export interface TrialBalanceRow {
  accountId: string;
  /** The account's hierarchical name, or a placeholder when it is unknown (see `known`). */
  name: string;
  type: ReportAccountType | null;
  normalSide: NormalSide;
  /** Signed, debit-positive. */
  balanceMinor: number;
  /** The debit column: the balance when it is a debit, else `0`. */
  debitMinor: number;
  /** The credit column: the balance's magnitude when it is a credit, else `0`. */
  creditMinor: number;
  /**
   * The balance expressed on the account's NORMAL side (so a credit-normal
   * account shows its credit balance as a positive number). Negative means the
   * balance sits on the wrong side — see `abnormal`.
   */
  normalMinor: number;
  /** The balance is on the side opposite this account type's normal side. */
  abnormal: boolean;
  zero: boolean;
  /** False when only postings — not the account list — know this account id. */
  known: boolean;
}

export interface TrialBalance {
  /** Rows after the zero-balance filter, ordered by account name. */
  rows: TrialBalanceRow[];
  totalDebitMinor: number;
  totalCreditMinor: number;
  /** Debits − credits. The whole point of the report is that this is `0`. */
  differenceMinor: number;
  balanced: boolean;
  /** How many accounts the fold saw (before the zero filter). */
  accountCount: number;
  /** Zero-balance accounts the `includeZero` toggle is currently hiding. */
  hiddenZeroCount: number;
  draftCount: number;
  postedCount: number;
  voidCount: number;
  /** Postings that landed on the reported rows (drafts excluded). */
  postingCount: number;
  /** Account ids seen on postings but missing from the account list. */
  unknownAccountIds: string[];
  /**
   * The reported entries that do not themselves sum to zero — i.e. the ones
   * responsible for a nonzero grand total. Every posted entry is balance-enforced
   * at post time, so a populated list means those specific entries have LOST
   * postings since. Ordered by entry number so the report can name them.
   */
  unbalancedEntries: UnbalancedEntry[];
}

/** One entry whose own postings no longer sum to zero. */
export interface UnbalancedEntry {
  transactionId: string;
  entryNo: number | null;
  date: string;
  description: string;
  /** Σ of the entry's postings — how far out it is, and on which side. */
  deltaMinor: number;
}

/**
 * The reported entries that do not sum to zero, ordered by entry number.
 *
 * This is the whole diagnosis behind a broken trial balance: the difference is
 * not spread thinly across the book, it belongs to specific entries, and the
 * postings needed to name them are already in hand.
 */
export function findUnbalancedEntries(transactions: readonly ReportTransaction[]): UnbalancedEntry[] {
  const out: UnbalancedEntry[] = [];
  for (const tx of transactions) {
    if (!isReported(tx)) continue;
    const deltaMinor = sumAmounts(tx.postings.map((p) => p.amountMinor));
    if (deltaMinor === 0) continue;
    out.push({transactionId: tx.id, entryNo: tx.entryNo, date: tx.date, description: tx.description, deltaMinor});
  }
  return out.sort((a, b) => {
    if (a.entryNo !== b.entryNo) {
      if (a.entryNo === null) return 1;
      if (b.entryNo === null) return -1;
      return a.entryNo < b.entryNo ? -1 : 1;
    }
    return a.transactionId < b.transactionId ? -1 : a.transactionId > b.transactionId ? 1 : 0;
  });
}

/** How one offending entry is named in the assertion. */
export function describeUnbalancedEntry(entry: UnbalancedEntry): string {
  const number = entry.entryNo === null ? 'An unnumbered entry' : `Entry #${entry.entryNo}`;
  const label = entry.description.trim() === '' ? '' : ` “${entry.description}”`;
  return `${number} (${entry.date}${label}) is out by ${formatWithSide(entry.deltaMinor)}`;
}

export interface TrialBalanceOptions {
  /** Show accounts whose balance is exactly zero. Default `false`. */
  includeZero?: boolean;
}

/**
 * Fold accounts + transactions into a trial balance.
 *
 * An account id that appears on a posting but not in `accounts` still gets a
 * row (flagged `known: false`): dropping it would silently remove money from
 * the totals and could make a broken book LOOK balanced — the exact failure
 * this report exists to catch.
 */
export function buildTrialBalance(
  accounts: readonly ReportAccount[],
  transactions: readonly ReportTransaction[],
  opts: TrialBalanceOptions = {},
): TrialBalance {
  const balances = accountBalances(transactions);
  const byId = new Map<string, ReportAccount>();
  for (const account of accounts) byId.set(account.id, account);

  const unknownAccountIds: string[] = [];
  balances.forEach((_balance, accountId) => {
    if (!byId.has(accountId)) unknownAccountIds.push(accountId);
  });
  unknownAccountIds.sort();

  const allRows: TrialBalanceRow[] = [];
  for (const account of accounts) {
    allRows.push(trialBalanceRow(account.id, account.name, account.type, balances.get(account.id) ?? 0, true));
  }
  for (const accountId of unknownAccountIds) {
    allRows.push(trialBalanceRow(accountId, `Deleted account (${accountId})`, null, balances.get(accountId) ?? 0, false));
  }
  allRows.sort((a, b) => a.name.localeCompare(b.name) || a.accountId.localeCompare(b.accountId));

  const totalDebitMinor = sumAmounts(allRows.map((r) => r.debitMinor));
  const totalCreditMinor = sumAmounts(allRows.map((r) => r.creditMinor));
  const differenceMinor = sumAmounts([totalDebitMinor, negateAmount(totalCreditMinor)]);

  const includeZero = opts.includeZero === true;
  const rows = includeZero ? allRows : allRows.filter((r) => !r.zero);
  const reported = transactions.filter(isReported);

  return {
    rows,
    totalDebitMinor,
    totalCreditMinor,
    differenceMinor,
    balanced: differenceMinor === 0,
    accountCount: allRows.length,
    hiddenZeroCount: includeZero ? 0 : allRows.filter((r) => r.zero).length,
    draftCount: countDrafts(transactions),
    postedCount: transactions.filter((tx) => tx.state === 'posted').length,
    voidCount: transactions.filter((tx) => tx.state === 'void').length,
    postingCount: reported.reduce((n, tx) => n + tx.postings.length, 0),
    unknownAccountIds,
    unbalancedEntries: findUnbalancedEntries(transactions),
  };
}

function trialBalanceRow(accountId: string, name: string, type: ReportAccountType | null, balanceMinor: number, known: boolean): TrialBalanceRow {
  const normalSide = normalSideFor(type);
  return {
    accountId,
    name,
    type,
    normalSide,
    balanceMinor,
    debitMinor: balanceMinor > 0 ? balanceMinor : 0,
    creditMinor: balanceMinor < 0 ? negateAmount(balanceMinor) : 0,
    normalMinor: normalSide === 'debit' ? balanceMinor : negateAmount(balanceMinor),
    // An account whose type is unknowable has no normal side to be abnormal
    // against: flagging it would accuse the data of something the report cannot
    // actually know, on the row that is already the most alarming on screen.
    abnormal: type === null ? false : normalSide === 'debit' ? balanceMinor < 0 : balanceMinor > 0,
    zero: balanceMinor === 0,
    known,
  };
}

/** The verdict of {@link describeTrialBalanceAssertion}. */
export interface TrialBalanceAssertion {
  /** Debits equal credits — the books are internally consistent. */
  ok: boolean;
  /** The sentence to render (loud and specific when `ok` is false). */
  text: string;
  /** The entries responsible, named — `null` when balanced or unattributable. */
  culprits?: string | null;
}

/**
 * The assertion the trial balance exists to make: Σ debits − Σ credits = 0.
 *
 * A nonzero total is NOT a UI error and must never read like one — every posted
 * entry is balance-enforced by the server, so a nonzero trial balance means
 * ledger DATA is missing or damaged. The sentence therefore names the magnitude,
 * the side, and what it implies, instead of a shrug.
 */
export function describeTrialBalanceAssertion(tb: TrialBalance): TrialBalanceAssertion {
  if (tb.balanced) {
    return {
      ok: true,
      text: `In balance — debits ${formatAmount(tb.totalDebitMinor)} = credits ${formatAmount(tb.totalCreditMinor)} ✓`,
      culprits: null,
    };
  }
  const side = tb.differenceMinor > 0 ? 'debits exceed credits' : 'credits exceed debits';
  const magnitude = formatAmount(tb.differenceMinor > 0 ? tb.differenceMinor : negateAmount(tb.differenceMinor));
  return {
    ok: false,
    text: `THE BOOKS DO NOT BALANCE — ${side} by ${magnitude}. Every posted entry is balance-enforced, so a nonzero total means ledger data is missing or damaged.`,
    // A prohibition with no next step is a dead end, and the data for a next
    // step is already loaded: the difference belongs to SPECIFIC entries, so
    // name them instead of leaving the reader to diff the whole book by hand.
    culprits: describeCulprits(tb.unbalancedEntries),
  };
}

/**
 * The offending entries as a sentence, capped at three so a widely damaged book
 * does not bury the headline. `null` when a nonzero difference cannot be pinned
 * on any single entry — which is itself worth saying plainly rather than
 * pointing at the wrong thing.
 */
export function describeCulprits(entries: readonly UnbalancedEntry[]): string | null {
  if (entries.length === 0) return null;
  const named = entries.slice(0, MAX_NAMED_CULPRITS).map(describeUnbalancedEntry);
  const rest = entries.length - named.length;
  const more = rest > 0 ? ` + ${rest} more ${rest === 1 ? 'entry' : 'entries'}` : '';
  return `${named.join('. ')}${more}.`;
}

/** How many offending entries the assertion names before it summarises. */
export const MAX_NAMED_CULPRITS = 3;

/**
 * The always-visible exclusion label. Reports show POSTED books; a draft is not
 * on the books yet, and a report that quietly omitted them would be a report you
 * could not reconcile against what you typed.
 */
export function describeDraftExclusion(draftCount: number): string {
  if (draftCount <= 0) return 'Posted entries only — drafts are excluded.';
  if (draftCount === 1) return 'Posted entries only — 1 draft entry excluded.';
  return `Posted entries only — ${draftCount} draft entries excluded.`;
}

// ── Account register ──────────────────────────────────────────────────────────

export interface RegisterFilter {
  /** Inclusive ISO `YYYY-MM-DD` lower bound. */
  from?: string;
  /** Inclusive ISO `YYYY-MM-DD` upper bound. */
  to?: string;
  /** Cleared states to include. Empty/omitted means all of them. */
  cleared?: readonly ReportClearedState[];
}

/**
 * Which half of a reversal pair a row is looking at (LGR-6).
 *
 * `reversed-by` — this entry was reversed; the counterpart is the reversing
 * entry. `reverses` — this entry IS the reversal; the counterpart is the entry
 * it undid. The two are rendered differently because they mean opposite things
 * to a reader trying to work out what the books currently say.
 */
export type CounterpartRelation = 'reversed-by' | 'reverses';

/**
 * Can the reader actually GET to the counterpart from here?
 *
 * A reversal negates every leg of its original, so both halves always touch the
 * same accounts and the counterpart is normally a row in this very register.
 * The two other answers are the honest ones: the filter is hiding it, or the
 * truncated read never loaded it. Saying "reversed" while offering a link that
 * goes nowhere is worse than saying where it went.
 */
export type CounterpartWhere = 'visible' | 'filtered' | 'not-loaded';

/** The other half of a reversal pair, as seen from one register row. */
export interface RegisterCounterpart {
  relation: CounterpartRelation;
  transactionId: string;
  entryNo: number | null;
  /** The counterpart's posting id on THIS account — non-null iff `visible`. */
  postingId: string | null;
  where: CounterpartWhere;
}

export interface RegisterRow {
  postingId: string;
  transactionId: string;
  entryNo: number | null;
  date: string;
  description: string;
  /** The OTHER accounts in the entry, in posting order, de-duplicated. */
  contraNames: string[];
  /** Those accounts as one display string (see {@link describeContra}). */
  contra: string;
  /** This posting, signed debit-positive. */
  amountMinor: number;
  /** Balance after this posting, including the opening balance. */
  runningMinor: number;
  cleared: ReportClearedState;
  /** The entry was reversed (its state is `void`); its reversal is in here too. */
  reversed: boolean;
  /** The entry's own state — what the correction affordance is allowed to offer. */
  state: ReportTransactionState;
  /** The other half of the reversal pair, when this row is in one (LGR-6). */
  counterpart: RegisterCounterpart | null;
}

export interface AccountRegister {
  accountId: string;
  accountName: string;
  accountType: ReportAccountType | null;
  normalSide: NormalSide;
  /** False when `accountId` is empty or names no known account. */
  exists: boolean;
  /** Rows inside the filter, in date order. */
  rows: RegisterRow[];
  /** Balance carried in from matching postings BEFORE the date range. */
  openingMinor: number;
  /** Balance after the last visible row (`openingMinor` when there are none). */
  closingMinor: number;
  /**
   * The account's whole posted balance, ignoring every filter — i.e. exactly the
   * figure the trial balance shows for this account. Equals `closingMinor` when
   * nothing is filtered out, which is what makes the register auditable.
   */
  accountBalanceMinor: number;
  /** Debit total of the visible rows. */
  totalDebitMinor: number;
  /** Credit total of the visible rows (a positive magnitude). */
  totalCreditMinor: number;
  /** Draft entries touching this account (excluded, and named as excluded). */
  draftCount: number;
  /** Reported postings on this account that the filter hid. */
  filteredOutCount: number;
  /** Reported postings on this account, before filtering. */
  postingCount: number;
  filter: {from: string | null; to: string | null; cleared: readonly ReportClearedState[]};
}

/** One posting on the register's account, with its parent entry. */
interface Hit {
  tx: ReportTransaction;
  posting: ReportPosting;
}

/**
 * Total, deterministic register order: date, then the server's entry number
 * (an entry without one sorts last), then transaction id, then posting id — so
 * two postings of the same entry on the same day never swap between renders.
 */
function compareHits(a: Hit, b: Hit): number {
  if (a.tx.date !== b.tx.date) return a.tx.date < b.tx.date ? -1 : 1;
  const an = a.tx.entryNo;
  const bn = b.tx.entryNo;
  if (an !== bn) {
    if (an === null) return 1;
    if (bn === null) return -1;
    return an < bn ? -1 : 1;
  }
  if (a.tx.id !== b.tx.id) return a.tx.id < b.tx.id ? -1 : 1;
  return a.posting.id < b.posting.id ? -1 : a.posting.id > b.posting.id ? 1 : 0;
}

/**
 * The contra ("what was the other side?") cell. One or two accounts read in
 * full; a bigger compound entry is a split, named by its first account so the
 * row still says something, with the rest counted.
 */
export function describeContra(names: readonly string[]): string {
  if (names.length === 0) return '—';
  if (names.length <= 2) return names.join(', ');
  return `${names[0]} + ${names.length - 1} more (split)`;
}

/**
 * Fold one account's postings into a register with a running balance.
 *
 * The DATE filter never breaks the running balance: matching postings before
 * `from` are carried in as `openingMinor`, so the last row's running balance is
 * the account's real balance on that date, not a partial sum.
 *
 * The CLEARED filter is a "balance as of what has cleared" view: postings whose
 * state is filtered out are excluded from the rows AND from the opening balance,
 * which is what makes a cleared-only register comparable to a bank statement.
 *
 * With no filter at all, `closingMinor === accountBalanceMinor` — the same
 * number the trial balance shows for this account.
 */
export function buildAccountRegister(
  accountId: string,
  accounts: readonly ReportAccount[],
  transactions: readonly ReportTransaction[],
  filter: RegisterFilter = {},
): AccountRegister {
  const account = accounts.find((a) => a.id === accountId) ?? null;
  const nameById = new Map<string, string>();
  for (const a of accounts) nameById.set(a.id, a.name);

  const from = filter.from !== undefined && filter.from !== '' ? filter.from : null;
  const to = filter.to !== undefined && filter.to !== '' ? filter.to : null;
  const cleared = filter.cleared !== undefined && filter.cleared.length > 0 ? filter.cleared : ALL_CLEARED_STATES;

  const hits: Hit[] = [];
  for (const tx of transactions) {
    if (!isReported(tx)) continue;
    for (const posting of tx.postings) {
      if (posting.accountId === accountId) hits.push({tx, posting});
    }
  }
  hits.sort(compareHits);

  const clearedOk = (hit: Hit): boolean => cleared.includes(hit.posting.cleared);
  const opening = hits.filter((h) => clearedOk(h) && from !== null && h.tx.date < from);
  const visible = hits.filter((h) => clearedOk(h) && (from === null || h.tx.date >= from) && (to === null || h.tx.date <= to));

  const openingMinor = sumAmounts(opening.map((h) => h.posting.amountMinor));
  let runningMinor = openingMinor;
  const rows: RegisterRow[] = [];
  for (const hit of visible) {
    runningMinor = sumAmounts([runningMinor, hit.posting.amountMinor]);
    const contraNames: string[] = [];
    for (const other of hit.tx.postings) {
      if (other.accountId === accountId) continue;
      const name = nameById.get(other.accountId) ?? `Deleted account (${other.accountId})`;
      if (!contraNames.includes(name)) contraNames.push(name);
    }
    rows.push({
      postingId: hit.posting.id,
      transactionId: hit.tx.id,
      entryNo: hit.tx.entryNo,
      date: hit.tx.date,
      description: hit.tx.description,
      contraNames,
      contra: describeContra(contraNames),
      amountMinor: hit.posting.amountMinor,
      runningMinor,
      cleared: hit.posting.cleared,
      reversed: hit.tx.state === 'void',
      state: hit.tx.state,
      // Resolved below: a counterpart may be a row that has not been built yet.
      counterpart: null,
    });
  }

  linkReversalPairs(rows, transactions);

  const amounts = rows.map((r) => r.amountMinor);
  return {
    accountId,
    accountName: account !== null ? account.name : accountId,
    accountType: account !== null ? account.type : null,
    normalSide: normalSideFor(account !== null ? account.type : null),
    exists: account !== null,
    rows,
    openingMinor,
    closingMinor: runningMinor,
    accountBalanceMinor: accountBalances(transactions).get(accountId) ?? 0,
    totalDebitMinor: sumAmounts(amounts.filter((a) => a > 0)),
    totalCreditMinor: negateAmount(sumAmounts(amounts.filter((a) => a < 0))),
    draftCount: transactions.filter((tx) => tx.state === 'draft' && tx.postings.some((p) => p.accountId === accountId)).length,
    filteredOutCount: hits.length - visible.length,
    postingCount: hits.length,
    filter: {from, to, cleared},
  };
}

/**
 * Point each half of a reversal pair at the other (LGR-6), in place.
 *
 * "(reversed)" on its own is a label, not a finding: it tells the reader
 * something happened to this entry and then leaves them to search the register
 * for the entry that did it. Both halves are already in hand here — the reversal
 * carries `reverses`, and the negated legs put it on the same accounts as its
 * original — so the link is a lookup, not a guess.
 *
 * The `where` verdict is the load-bearing part. Only a counterpart that has an
 * actual VISIBLE ROW gets a posting id to jump to; a counterpart the filter hid
 * or the truncated read never loaded is reported as such, so the UI can say
 * where it went instead of offering a link into nothing.
 */
function linkReversalPairs(rows: RegisterRow[], transactions: readonly ReportTransaction[]): void {
  if (rows.length === 0) return;
  const reported = transactions.filter(isReported);
  const byId = new Map<string, ReportTransaction>();
  const reversalOf = new Map<string, ReportTransaction>();
  for (const tx of reported) {
    byId.set(tx.id, tx);
    const reverses = tx.reverses ?? null;
    // First writer wins: an original can only be reversed once (the store voids
    // it in the same transaction), so a second claimant is damaged data and must
    // not silently replace the link the reader already has.
    if (reverses !== null && reverses !== '' && !reversalOf.has(reverses)) reversalOf.set(reverses, tx);
  }
  // The first visible row per transaction — where a jump lands.
  const rowOf = new Map<string, RegisterRow>();
  for (const row of rows) if (!rowOf.has(row.transactionId)) rowOf.set(row.transactionId, row);

  for (const row of rows) {
    const tx = byId.get(row.transactionId);
    const reverses = tx?.reverses ?? null;
    if (row.state === 'void') {
      const reversal = reversalOf.get(row.transactionId);
      // A void entry whose reversal was not loaded cannot be pointed at: its id
      // lives on the reversal, not on the original. `reversed` still marks it.
      if (reversal === undefined) continue;
      row.counterpart = counterpartFor('reversed-by', reversal.id, reversal.entryNo, rowOf, byId);
    } else if (reverses !== null && reverses !== '') {
      const original = byId.get(reverses) ?? null;
      row.counterpart = counterpartFor('reverses', reverses, original !== null ? original.entryNo : null, rowOf, byId);
    }
  }
}

function counterpartFor(
  relation: CounterpartRelation,
  transactionId: string,
  entryNo: number | null,
  rowOf: Map<string, RegisterRow>,
  byId: Map<string, ReportTransaction>,
): RegisterCounterpart {
  const row = rowOf.get(transactionId);
  if (row !== undefined) return {relation, transactionId, entryNo, postingId: row.postingId, where: 'visible'};
  return {relation, transactionId, entryNo, postingId: null, where: byId.has(transactionId) ? 'filtered' : 'not-loaded'};
}

/**
 * The counterpart link in words — the same sentence the visible control and the
 * screen-reader-only text both use, so they can never drift apart.
 */
export function describeCounterpart(counterpart: RegisterCounterpart): string {
  const named = counterpart.entryNo === null ? 'an unnumbered entry' : `entry #${counterpart.entryNo}`;
  const lead = counterpart.relation === 'reversed-by' ? `Reversed by ${named}` : `Reverses ${named}`;
  if (counterpart.where === 'filtered') return `${lead} — hidden by this filter`;
  if (counterpart.where === 'not-loaded') return `${lead} — outside this read`;
  return lead;
}

// ── Corrections (LGR-6) ───────────────────────────────────────────────────────

/**
 * Why "Correct this entry" is unavailable on a row, or `null` when it is.
 *
 * There is no "edit" answer in this list, and that is the point: a posted entry
 * is immutable in the store (LGR-3), so the only honest repair is a reversal
 * plus a corrected re-entry. The blocked cases are the two the ledger itself
 * refuses — an entry that is already void, and anything that is not posted — and
 * the one the document imposes, a read-only page.
 */
export type CorrectionBlocker = 'already-reversed' | 'not-posted' | 'read-only' | 'correction-open';

/**
 * May this row be corrected, and if not, why not?
 *
 * `correction-open` is in the list rather than handled in the view because a
 * button that is merely `disabled` while another correction runs would render
 * IDENTICALLY to a live one — the failure this epic has already shipped once.
 * Every off state a Correct button can be in comes through here, so every one of
 * them gets the off styling and a rendered reason.
 */
export function correctionBlocker(row: {state: ReportTransactionState}, opts: {readOnly: boolean; correctionOpen: boolean}): CorrectionBlocker | null {
  if (opts.readOnly) return 'read-only';
  if (row.state === 'void') return 'already-reversed';
  if (row.state !== 'posted') return 'not-posted';
  if (opts.correctionOpen) return 'correction-open';
  return null;
}

/**
 * The reason a disabled Correct button carries, IN THE CELL beside it.
 *
 * A disabled control whose explanation lives in a `title` is a mouse-only
 * explanation, and `disabled` has already taken the control out of the tab
 * order — so a keyboard user meets a button they cannot press and cannot ask
 * about. The sentence is rendered, always.
 */
export function describeCorrectionBlocker(blocker: CorrectionBlocker, counterpart: RegisterCounterpart | null): string {
  if (blocker === 'read-only') return 'This page is read-only.';
  if (blocker === 'not-posted') return 'Only a posted entry can be corrected.';
  if (blocker === 'correction-open') return 'Finish or close the correction in progress first.';
  // The useful half of "already reversed" is WHICH entry reversed it.
  return counterpart === null
    ? 'Already reversed — its reversing entry is not in this read.'
    : `Already reversed — correct ${counterpart.entryNo === null ? 'the reversing entry' : `entry #${counterpart.entryNo}`} instead.`;
}

/** How an entry is named in the correction copy (`entry #12`, or a fallback). */
export function nameEntry(entryNo: number | null): string {
  return entryNo === null ? 'this unnumbered entry' : `entry #${entryNo}`;
}

/**
 * The confirmation sentence — the whole bargain, before anything is written.
 *
 * A reversal is itself permanent, so this is the last reversible moment and it
 * has to state all three consequences rather than ask "are you sure?": the
 * original SURVIVES (nothing is deleted or hidden), a new entry is posted
 * against it, and the user is handed a copy to fix. The last clause is the one
 * that stops the dialog reading like a delete confirmation.
 */
export function describeCorrectionConfirm(row: {entryNo: number | null; description: string; state: ReportTransactionState; counterpart?: RegisterCounterpart | null}): string {
  const what = row.description.trim() === '' ? nameEntry(row.entryNo) : `${nameEntry(row.entryNo)} “${row.description.trim()}”`;
  // Correcting a REVERSAL is legal and coherent, and it is surprising enough to
  // spell out: the counter-reversal puts the original entry's effect back.
  const chain = row.counterpart != null && row.counterpart.relation === 'reverses'
    ? ` This entry is itself a reversal, so correcting it puts ${nameEntry(row.counterpart.entryNo)}’s effect back on the books.`
    : '';
  return (
    `Correct ${what}? The original stays on the books, a reversal is posted against it, and you get an editable copy to correct.` +
    ` The reversal is permanent too — it can only be undone by reversing it in turn.${chain}`
  );
}

/** The sentence shown once a correction copy has been posted. */
export function describeCorrectionDone(originalEntryNo: number | null, reversalEntryNo: number | null, correctedEntryNo: number | null): string {
  return `Corrected — ${nameEntry(originalEntryNo)} was reversed by ${nameEntry(reversalEntryNo)}, and your corrected copy is posted as ${nameEntry(correctedEntryNo)}.`;
}

/** The register's footer line: how much is shown, and what it opens/closes at. */
export function describeRegisterSummary(register: AccountRegister): string {
  const count = register.rows.length === 1 ? '1 posting' : `${register.rows.length} postings`;
  return `${count} · opening ${formatWithSide(register.openingMinor)} · closing ${formatWithSide(register.closingMinor)}`;
}

/** What the filter is currently doing, in words (it is never a silent filter). */
export function describeRegisterFilter(register: AccountRegister): string {
  const {from, to, cleared} = register.filter;
  const dates = from === null && to === null ? 'All dates' : from !== null && to !== null ? `${from} → ${to}` : from !== null ? `From ${from}` : `Up to ${to}`;
  // Display labels, never the raw enum ids — `"pending, cleared"` is storage
  // vocabulary leaking into a sentence the user reads.
  const states = cleared.length === ALL_CLEARED_STATES.length ? 'all cleared states' : cleared.map((state) => CLEARED_LABEL[state]).join(', ');
  const hidden = register.filteredOutCount > 0 ? ` · ${register.filteredOutCount} hidden by this filter` : '';
  return `${dates} · ${states}${hidden}`;
}

/**
 * Does the register's closing balance still agree with the account's whole
 * posted balance? True whenever nothing is filtered out — the UI says so, so a
 * filtered register can never be mistaken for the account's real balance.
 */
export function registerMatchesAccountBalance(register: AccountRegister): boolean {
  return register.closingMinor === register.accountBalanceMinor;
}
