import {MoneyError, compareAmounts, formatAmount, negateAmount, parseAmount, sumAmounts} from '@book.dev/plugin-sdk';
import {
  ALL_CLEARED_STATES,
  describeContra,
  formatWithSide,
  isReported,
  normalSideFor,
  type NormalSide,
  type ReportAccount,
  type ReportClearedState,
  type ReportTransaction,
} from './reports';

/**
 * Pure reconciliation folds (LGR-11) — no React, no IO, no host calls.
 *
 * WHAT THIS COMPUTES is the arithmetic a bookkeeper does by hand at the end of
 * a month, and it is deliberately only three numbers:
 *
 *     statement balance  −  cleared balance  =  difference to explain
 *
 * The statement balance is what the bank says. The cleared balance is what the
 * books say has actually settled — every `cleared` or `reconciled` posting on
 * the account. The difference is the entries one side has and the other does
 * not: a payment that never got entered, an import that doubled a line, a
 * transposed amount. A reconciliation FINISHES only when it is exactly zero,
 * because a "reconciled" account that is out by 2.40 is worse than one that was
 * never reconciled — it carries an assurance it has not earned.
 *
 * MONEY DISCIPLINE (LGR-2): every amount is signed integer minor units, added
 * with `sumAmounts`, flipped with `negateAmount`, parsed with `parseAmount` and
 * rendered with `formatAmount`. No `Number()`, no `parseFloat`, no `Math.*`, and
 * no `+`/`-` on an amount — here or (especially) in the block that renders this.
 *
 * SIGN CONVENTION: postings are DEBIT-POSITIVE, so the difference is too. The
 * statement balance a human types is NOT: nobody enters their current-account
 * balance as a debit. It is read on the account's NORMAL side (a positive
 * number is money in the bank for an asset, and money owed for a credit card)
 * and converted here — see {@link parseStatementBalance}. That conversion lives
 * in this module precisely so no view ever re-signs an amount.
 *
 * NO HIDDEN ROWS. Every posted leg on the account is a candidate, whatever its
 * date. A date filter would be tidier and is what most tools do, but it makes
 * the difference unexplainable: the reader would be looking at a number that
 * cannot be reconciled with anything on screen. A duplicated entry dated after
 * the statement closes is exactly the kind of thing this workflow exists to
 * catch, and it must not be filtered out of view.
 */

/**
 * A reconciliation's lifecycle, mirroring the server's
 * `LEDGER_RECONCILIATION_STATUSES`. `abandoned` (LGR-22) is terminal: the
 * statement was given up on rather than balanced, nothing was frozen, and
 * nothing about it can be changed again.
 */
export type ReconcileStatus = 'open' | 'finished' | 'abandoned';

/** The reconciliation fields the fold needs (a slice of `LedgerReconciliation`). */
export interface ReconcileStatement {
  id: string;
  accountId: string;
  statementDate: string;
  statementBalanceMinor: number;
  status: ReconcileStatus;
}

/** One candidate posting on the reconcile checklist. */
export interface ReconcileRow {
  postingId: string;
  transactionId: string;
  entryNo: number | null;
  date: string;
  description: string;
  /** The other accounts in the entry, as one display string. */
  contra: string;
  /** This leg, signed debit-positive. */
  amountMinor: number;
  cleared: ReportClearedState;
  /** Counted into the cleared balance — i.e. the box is ticked. */
  matched: boolean;
  /** Frozen by a FINISHED reconciliation; only that one's reopen releases it. */
  frozen: boolean;
  /** The statement it was reconciled to, when frozen and that statement is known. */
  frozenStatementDate: string | null;
  /** Frozen by a DIFFERENT reconciliation than the one being worked on. */
  frozenElsewhere: boolean;
  /** The entry was reversed (its state is `void`); its reversal is in here too. */
  reversed: boolean;
}

export interface ReconcileSheet {
  accountId: string;
  accountName: string;
  normalSide: NormalSide;
  /** False when the reconciliation names an account this book does not have. */
  exists: boolean;
  statementDate: string;
  status: ReconcileStatus;
  /** Signed, debit-positive — already converted from the normal side. */
  statementBalanceMinor: number;
  /** Every posted leg on the account, oldest first. */
  rows: ReconcileRow[];
  /** Σ of the matched rows: what the books say has settled. */
  clearedBalanceMinor: number;
  /** `statementBalanceMinor − clearedBalanceMinor`. Zero is the goal. */
  differenceMinor: number;
  /** The difference is exactly zero. */
  balanced: boolean;
  /** Balanced AND still open — exactly when Finish may be enabled. */
  canFinish: boolean;
  matchedCount: number;
  unmatchedCount: number;
  /** Σ of the UNMATCHED rows — the money on the books but not on this statement. */
  unmatchedMinor: number;
  /** Draft entries touching this account (excluded, and named as excluded). */
  draftCount: number;
  /** Postings frozen by an EARLIER finished reconciliation. */
  frozenElsewhereCount: number;
}

/** A parsed statement balance, or the reason it could not be read. */
export type StatementBalanceResult =
  | {ok: true; minor: number}
  | {ok: false; problem: string};

/**
 * Read a typed statement balance into debit-positive minor units.
 *
 * The number a human types is on the account's NORMAL side — `1,250.00` in a
 * current account means 1,250.00 of asset, and `1,250.00` on a credit card
 * means 1,250.00 owed. Both are positive on the statement, and they sit on
 * OPPOSITE sides of the ledger, so the conversion happens exactly once, here,
 * through `negateAmount`. A view that did it inline would be doing arithmetic
 * on money, and the first mistake would be silent.
 *
 * Parsing is `parseAmount` and nothing else: `Number('1e3')` is 1000 and
 * `parseFloat('12.345')` is 12.345, and both would enter the books as money.
 */
export function parseStatementBalance(raw: string, normalSide: NormalSide): StatementBalanceResult {
  const text = raw.trim();
  if (text === '') return {ok: false, problem: 'Enter the closing balance from the statement.'};
  let minor: number;
  try {
    minor = parseAmount(text);
  } catch (err) {
    return {
      ok: false,
      problem: err instanceof MoneyError
        ? `That balance can’t be read as an amount (${err.message}).`
        : 'That balance can’t be read as an amount.',
    };
  }
  return {ok: true, minor: normalSide === 'debit' ? minor : negateAmount(minor)};
}

/**
 * The stored statement balance as EDITABLE TEXT on the normal side — what the
 * amend form (LGR-22) prefills its box with, and the exact inverse of
 * {@link parseStatementBalance}.
 *
 * NOT {@link formatOnNormalSide}: that renders an abnormal balance as
 * `250.00 Cr`, which is right for a readout and unparseable as input — the box
 * would be born holding a value its own parser rejects. `formatAmount` of the
 * normal-side figure round-trips exactly (a money-core guarantee), so what the
 * field shows is what re-reading it yields.
 */
export function statementBalanceInput(minor: number, normalSide: NormalSide): string {
  return formatAmount(normalSide === 'debit' ? minor : negateAmount(minor));
}

/**
 * Render a debit-positive amount as the statement would show it — on the
 * account's normal side, so what goes into the box and what comes out of it are
 * the same number.
 *
 * An ABNORMAL balance (an overdrawn current account, a credit card in credit)
 * would otherwise print a bare `-250.00`, and a bare minus is a notation this
 * report family does not use: `formatWithSide`'s whole point is that a magnitude
 * always carries the side it is on, so `Statement -250.00 − cleared -300.00 =
 * 50.00 Dr` puts two notations in one sentence and makes the reader translate.
 * On the wrong side the magnitude is marked with its ACTUAL side instead.
 */
export function formatOnNormalSide(minor: number, normalSide: NormalSide): string {
  const onSide = normalSide === 'debit' ? minor : negateAmount(minor);
  if (onSide >= 0) return formatAmount(onSide);
  return `${formatAmount(negateAmount(onSide))} ${normalSide === 'debit' ? 'Cr' : 'Dr'}`;
}

/**
 * The closing-balance box's LABEL — an instruction, not a property of the
 * account.
 *
 * "Closing balance (credit-normal account)" states a true fact about the account
 * and leaves the reader to derive what to type from it, which is backwards: the
 * label is read at the moment of typing, and it is the one place that can stop
 * the highest-consequence mistake on the screen. Getting the side wrong flips
 * the sign, and the difference then comes out at exactly twice the balance —
 * see {@link describeGap}, which recognises that signature but only after the
 * damage is on screen.
 */
export function describeBalanceLabel(normalSide: NormalSide): string {
  return `Closing balance — as the statement prints it (${describePositiveMeans(normalSide)})`;
}

/**
 * What a POSITIVE number in the closing-balance box means on this account —
 * the clause, without a sentence around it.
 *
 * ONE fact, used in two sentences that read very differently: the label above
 * (before anything is typed) and {@link describeGap}'s 2× hint (after it has
 * gone wrong). Phrased to sit inside either, so neither has to keep its own
 * wording of the account's normal side and drift from the other.
 */
export function describePositiveMeans(normalSide: NormalSide): string {
  return normalSide === 'debit' ? 'a positive number is money in the account' : 'a positive number is a balance you owe';
}

/**
 * What the typed balance MEANS, echoed back before anything is committed.
 *
 * Reprinting the digits is worthless here: `parseStatementBalance` maps onto the
 * normal side and `formatOnNormalSide` maps straight back, so a formatted echo
 * is a round-trip identity that restates the user's own keystrokes and is silent
 * about the SIDE — which is the one fact they can get wrong, and the one whose
 * cost is a difference of exactly twice the balance. So the echo says what the
 * number will be taken to mean.
 */
export function describeBalanceEcho(minor: number, normalSide: NormalSide): string {
  const onSide = normalSide === 'debit' ? minor : negateAmount(minor);
  const magnitude = formatAmount(onSide >= 0 ? onSide : negateAmount(onSide));
  if (onSide === 0) return 'Reading it as an empty account.';
  const meaning =
    normalSide === 'debit'
      ? onSide > 0 ? 'in the account' : 'overdrawn'
      : onSide > 0 ? 'owed' : 'in credit';
  return `Reading it as ${magnitude} ${meaning}.`;
}

/**
 * Fold one open (or finished) reconciliation into the sheet the block renders.
 *
 * `reconciliations` is every reconciliation the book holds, so a frozen row can
 * name the statement it belongs to rather than showing a bare id — a posting
 * you cannot untick is only explicable if the interface says which statement
 * has hold of it.
 */
export function buildReconcileSheet(
  statement: ReconcileStatement,
  accounts: readonly ReportAccount[],
  transactions: readonly ReportTransaction[],
  reconciliations: readonly ReconcileStatement[] = [],
): ReconcileSheet {
  const account = accounts.find((a) => a.id === statement.accountId) ?? null;
  const nameById = new Map<string, string>();
  for (const a of accounts) nameById.set(a.id, a.name);
  const statementDateById = new Map<string, string>();
  for (const r of reconciliations) statementDateById.set(r.id, r.statementDate);

  const rows: ReconcileRow[] = [];
  for (const tx of transactions) {
    if (!isReported(tx)) continue;
    for (const posting of tx.postings) {
      if (posting.accountId !== statement.accountId) continue;
      const contraNames: string[] = [];
      for (const other of tx.postings) {
        if (other.accountId === statement.accountId) continue;
        const name = nameById.get(other.accountId) ?? `Deleted account (${other.accountId})`;
        if (!contraNames.includes(name)) contraNames.push(name);
      }
      const frozen = posting.cleared === 'reconciled';
      const owner = frozen ? postingReconciliationId(posting) : null;
      rows.push({
        postingId: posting.id,
        transactionId: tx.id,
        entryNo: tx.entryNo,
        date: tx.date,
        description: tx.description,
        contra: describeContra(contraNames),
        amountMinor: posting.amountMinor,
        cleared: posting.cleared,
        // `reconciled` counts as matched: it is settled money the statement's
        // closing balance already includes. Excluding it would make the very
        // first reconciliation the only one that could ever reach zero.
        matched: posting.cleared !== 'pending',
        frozen,
        frozenStatementDate: owner === null ? null : statementDateById.get(owner) ?? null,
        frozenElsewhere: frozen && owner !== statement.id,
        reversed: tx.state === 'void',
      });
    }
  }
  rows.sort(compareRows);

  const matched = rows.filter((r) => !isOutstanding(r));
  const unmatched = rows.filter(isOutstanding);
  const clearedBalanceMinor = sumAmounts(matched.map((r) => r.amountMinor));
  const differenceMinor = sumAmounts([statement.statementBalanceMinor, negateAmount(clearedBalanceMinor)]);

  return {
    accountId: statement.accountId,
    accountName: account !== null ? account.name : statement.accountId,
    normalSide: normalSideFor(account !== null ? account.type : null),
    exists: account !== null,
    statementDate: statement.statementDate,
    status: statement.status,
    statementBalanceMinor: statement.statementBalanceMinor,
    rows,
    clearedBalanceMinor,
    differenceMinor,
    balanced: differenceMinor === 0,
    canFinish: differenceMinor === 0 && statement.status === 'open',
    matchedCount: matched.length,
    unmatchedCount: unmatched.length,
    unmatchedMinor: sumAmounts(unmatched.map((r) => r.amountMinor)),
    draftCount: transactions.filter((tx) => tx.state === 'draft' && tx.postings.some((p) => p.accountId === statement.accountId)).length,
    frozenElsewhereCount: rows.filter((r) => r.frozenElsewhere).length,
  };
}

/**
 * On the books, not on this statement — the ONE predicate behind
 * `unmatchedCount`, `unmatchedMinor`, {@link describeUnmatchedCaveat} and the
 * "Outstanding items" section.
 *
 * Exported rather than re-typed at the call sites: a view that filtered on its
 * own copy of `!row.matched` would be a second definition of "outstanding", and
 * a heading that counts one set while the list below it renders another is
 * precisely the kind of two-places-one-fact bug this codebase keeps paying for.
 */
export function isOutstanding(row: ReconcileRow): boolean {
  return !row.matched;
}

/**
 * The size of an amount, without its side. Through `negateAmount` — a bare `-x`
 * on money is the arithmetic this module exists to keep out, and it is also how
 * `-0` gets into a formatted figure.
 */
function magnitudeOf(minor: number): number {
  return minor < 0 ? negateAmount(minor) : minor;
}

/**
 * The `reconciliationId` a posting carries, read structurally.
 *
 * The report types model the slice the folds need, and `reconciliationId` is on
 * the wire but not on `ReportPosting` — reading it here (rather than widening
 * every report's posting type) keeps the register and the statements unaffected
 * by a field only this fold uses.
 */
function postingReconciliationId(posting: {reconciliationId?: string | null}): string | null {
  return typeof posting.reconciliationId === 'string' && posting.reconciliationId !== '' ? posting.reconciliationId : null;
}

/**
 * Total, deterministic checklist order: date, then entry number (an entry
 * without one sorts last), then transaction id, then posting id — so two legs
 * of one entry on one day never swap between renders while the user is ticking
 * them.
 */
function compareRows(a: ReconcileRow, b: ReconcileRow): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.entryNo !== b.entryNo) {
    if (a.entryNo === null) return 1;
    if (b.entryNo === null) return -1;
    return a.entryNo < b.entryNo ? -1 : 1;
  }
  if (a.transactionId !== b.transactionId) return a.transactionId < b.transactionId ? -1 : 1;
  return a.postingId < b.postingId ? -1 : a.postingId > b.postingId ? 1 : 0;
}

/**
 * The live readout, in the order a bookkeeper checks it: what the bank says,
 * what has cleared, and what is left to explain.
 *
 * The last clause is the whole workflow in one sentence, so it is stated
 * plainly rather than left to be inferred from three numbers in a row.
 */
export function describeDifference(sheet: ReconcileSheet): string {
  const statement = formatOnNormalSide(sheet.statementBalanceMinor, sheet.normalSide);
  const cleared = formatOnNormalSide(sheet.clearedBalanceMinor, sheet.normalSide);
  if (sheet.balanced) {
    // "nothing left to explain" is a claim about the BOOKS, and this screen
    // cannot make it: postings can be sitting right below, unticked and
    // unexplained. What it can prove is that the STATEMENT is accounted for, so
    // that is all it says — the same completeness rule the captions already
    // meet. {@link describeUnmatchedCaveat} carries the rest.
    return `Statement ${statement} = cleared ${cleared} — this statement is fully explained.`;
  }
  return `Statement ${statement} − cleared ${cleared} = ${formatWithSide(sheet.differenceMinor)} still to explain.`;
}

/**
 * What a nonzero difference MEANS — and, crucially, BOTH causes that can produce
 * it, not one per direction.
 *
 * A ledger has two sides, so either sign is reachable from either mistake: a
 * doubled CREDIT on a debit-normal account puts the statement ahead exactly as a
 * missing DEBIT does. The first version of this assigned one cause per branch,
 * and the project's own canonical fixture disproved it — a 950.00 Dr difference
 * caused by a ticked duplicate was met with "look for an entry missing from the
 * books", sending the reader hunting for a receipt that does not exist while the
 * fix was to untick a row already on screen. At the exact moment this screen
 * exists for, that is worse than saying nothing.
 *
 * THE 2× CASE IS CALLED OUT BY NAME, because it is not one of those two causes
 * at all and the generic advice sends the reader hunting through the books for
 * an entry that is not the problem. A balance typed on the WRONG SIDE — the
 * error this screen's own hint exists to prevent, and the easiest one to make —
 * lands the difference at exactly twice the balance: the target is out by 2S
 * (from +S to −S) while the books are right. Any product with a normal-side
 * convention produces this signature, and nothing else produces it as reliably,
 * so when the arithmetic matches, say so before offering the general advice.
 *
 * `null` when there is nothing to explain.
 */
export function describeGap(sheet: ReconcileSheet): string | null {
  if (sheet.balanced) return null;
  const magnitude = formatAmount(magnitudeOf(sheet.differenceMinor));
  const twiceTheBalance = sumAmounts([magnitudeOf(sheet.statementBalanceMinor), magnitudeOf(sheet.statementBalanceMinor)]);
  // A zero balance doubles to zero, and "twice nothing" matches every zero
  // difference — but a zero difference is balanced and never reaches here, so
  // the guard is really against a zero BALANCE, where the coincidence carries
  // no signal.
  if (twiceTheBalance !== 0 && compareAmounts(magnitudeOf(sheet.differenceMinor), twiceTheBalance) === 0) {
    return `The difference is ${magnitude} — exactly twice the closing balance you typed. That is the signature of a balance entered on the wrong side, so check the statement before you check the books: on this account ${describePositiveMeans(sheet.normalSide)}. Correct it with “Amend statement” — you do not have to start again.`;
  }
  // Phrased in terms of the SIDE rather than the sign, so it reads the same way
  // on a credit card as on a current account.
  const statementHasMore = (sheet.normalSide === 'debit' && sheet.differenceMinor > 0) || (sheet.normalSide === 'credit' && sheet.differenceMinor < 0);
  // "one you have not ticked yet" is only a candidate cause when there IS an
  // unticked row. Offering it under a footer that reads "nothing unmatched" is
  // advice the screen itself disproves — a smaller version of the bug this
  // whole sentence exists to fix.
  const untickedClause = sheet.unmatchedCount > 0 ? ', one you have not ticked yet' : '';
  return statementHasMore
    ? `The statement is ${magnitude} ahead of what you have ticked — look for an entry on the statement that is missing from the books${untickedClause}, or a ticked entry the books recorded twice on the other side.`
    : `The books are ${magnitude} ahead of the statement — look for an entry that was recorded twice${sheet.unmatchedCount > 0 ? ', one that has not cleared the bank yet' : ''}, or an entry missing from the books on the other side.`;
}

/**
 * The caveat a BALANCED sheet still owes: postings on the books that this
 * statement does not account for.
 *
 * Reaching zero means the statement is explained. It does not mean the books are
 * right — the canonical case is a duplicated entry left unticked, which is
 * exactly how the difference reached zero in the first place. Without this the
 * boldest text on screen reads as completeness while the one unresolved row is a
 * 0.75rem footnote below the table, and "unmatched" reads as *excluded* rather
 * than *unexplained*.
 *
 * BOTH POSSIBILITIES, NEITHER RANKED. An unticked posting is either money that
 * has not reached the bank yet — completely normal, and the reason this is a
 * notice and not a gate — or an entry the books hold twice, in which case the
 * account is wrong by that amount and finishing will not make it right. The
 * screen cannot tell which, and guessing would send half the readers to the
 * wrong place; naming both, with the amount, is what lets the person who has the
 * statement in front of them decide in one look.
 *
 * ONE STRING, TWO PLACES: the standing notice above the checklist and the
 * confirm shown when Finish is pressed (LGR-22) render exactly this. A confirm
 * that restated the same fact in its own words would be a second copy free to
 * drift from the first — and the confirm is the one people actually read.
 *
 * `null` when everything on the books is on the statement.
 */
export function describeUnmatchedCaveat(sheet: ReconcileSheet): string | null {
  if (!sheet.balanced || sheet.unmatchedCount === 0) return null;
  const n = sheet.unmatchedCount;
  const one = n === 1;
  return `${n} posting${one ? '' : 's'} totalling ${formatWithSide(sheet.unmatchedMinor)} ${one ? 'is' : 'are'} on the books but not on this statement. If ${one ? 'it has' : 'they have'} not cleared the bank yet that is expected — ${one ? 'it' : 'they'} will appear on a later statement. If ${one ? 'it was' : 'any were'} recorded twice, this account is still out by ${formatAmount(magnitudeOf(sheet.unmatchedMinor))} and finishing here will not correct it.`;
}

/**
 * The heading of the "Outstanding items" section a FINISHED statement carries:
 * how many postings the books hold that this statement never accounted for, and
 * what they come to.
 *
 * Only after finishing, and only when there are any. Before that the difference
 * readout and {@link describeUnmatchedCaveat} are doing this job on a live
 * number; afterwards the number stops moving and the leftovers become a standing
 * to-do — which is a named section with the rows in it, not a grey count in a
 * footer that reads as bookkeeping exhaust.
 *
 * `null` when the section should not be shown at all.
 */
export function describeOutstandingHeading(sheet: ReconcileSheet): string | null {
  if (sheet.status !== 'finished' || sheet.unmatchedCount === 0) return null;
  return `Outstanding items (${sheet.unmatchedCount} · ${formatWithSide(sheet.unmatchedMinor)})`;
}

/** What the "Outstanding items" section is for, under its heading. */
export function describeOutstandingIntro(sheet: ReconcileSheet): string {
  const one = sheet.unmatchedCount === 1;
  return `On the books, not on the ${sheet.statementDate} statement. ${one ? 'It is' : 'They are'} either still to reach the bank or ${one ? 'a duplicate' : 'duplicates'} — carry ${one ? 'it' : 'them'} into the next statement, or reverse ${one ? 'it' : 'them'}.`;
}

/**
 * When one posting — ticked or unticked — would close the difference exactly,
 * name it. This is the arithmetic a bookkeeper would otherwise do by hand, on
 * screen, at the moment it is needed.
 *
 * BOTH DIRECTIONS, because a difference is closed either by ticking something
 * or by unticking something, and the untick case is the one the canonical
 * fixture actually turns on. Checking only unticked rows left this silent on a
 * doubled entry — precisely the case the guidance sentence above was rewritten
 * for.
 *
 * TWO IDENTICAL ROWS ARE NOT AMBIGUITY IN THE UNTICK DIRECTION — they are the
 * SIGNATURE of the mistake. Same date, same description, same amount, both
 * ticked: that is a duplicate, and either one may be unticked. The tick
 * direction keeps the strict single-row rule, where two candidates genuinely are
 * two different entries and pointing at one would be a guess.
 *
 * `null` when balanced, or when nothing accounts for the gap exactly.
 */
export function describeSingleCulprit(sheet: ReconcileSheet): string | null {
  if (sheet.balanced) return null;
  const where = (row: ReconcileRow): string => {
    const label = row.description.trim() === '' ? '' : ` “${row.description}”`;
    return `${row.date}${label}, ${formatWithSide(row.amountMinor)}`;
  };

  // TICK: an unticked row worth exactly the outstanding difference.
  const toTick = sheet.rows.filter((row) => !row.matched && !row.frozen && row.amountMinor === sheet.differenceMinor);
  if (toTick.length === 1) return `One unticked posting would close this exactly: ${where(toTick[0])}.`;

  // UNTICK: a ticked row whose amount is the difference NEGATED — removing it
  // moves the cleared total by exactly the gap.
  const wanted = negateAmount(sheet.differenceMinor);
  const toUntick = sheet.rows.filter((row) => row.matched && !row.frozen && row.amountMinor === wanted);
  if (toUntick.length === 0) return null;
  if (toUntick.length === 1) return `Unticking one posting would close this exactly: ${where(toUntick[0])}.`;
  const first = toUntick[0];
  const identical = toUntick.every((row) => row.date === first.date && row.description === first.description);
  if (!identical) return null;
  return toUntick.length === 2
    ? `Unticking either of two identical postings would close this exactly: ${where(first)}.`
    : `Unticking any one of ${toUntick.length} identical postings would close this exactly: ${where(first)}.`;
}

/** The checklist footer: how much is ticked, and what is deliberately not. */
export function describeReconcileSummary(sheet: ReconcileSheet): string {
  const matched = sheet.matchedCount === 1 ? '1 posting matched' : `${sheet.matchedCount} postings matched`;
  const left = sheet.unmatchedCount === 0
    ? 'nothing unmatched'
    : `${sheet.unmatchedCount} unmatched (${formatWithSide(sheet.unmatchedMinor)})`;
  return `${matched} · ${left}`;
}

/**
 * The standing caveat about postings this reconciliation cannot touch. `null`
 * when there are none — an empty explanation is noise.
 */
export function describeFrozenElsewhere(sheet: ReconcileSheet): string | null {
  if (sheet.frozenElsewhereCount === 0) return null;
  const n = sheet.frozenElsewhereCount;
  return `${n} posting${n === 1 ? ' is' : 's are'} locked by an earlier finished statement. ${n === 1 ? 'It' : 'They'} still count towards the cleared balance — reopen that reconciliation to change ${n === 1 ? 'it' : 'them'}.`;
}

/** Why Finish is closed: the RULE, plus the LIVE state when there is one. */
export interface FinishBlock {
  /** The rule, shown on screen. */
  rule: string;
  /**
   * The current difference, spelled out. `null` when there is nothing live to
   * add. Rendered visually HIDDEN: a disabled control is out of the tab order,
   * so a screen-reader user reaches this only through the button's
   * `aria-describedby` and needs the figure repeated there — while a sighted
   * reader already has it two lines above, and printing "950" four times in one
   * corner of the screen just makes the eye restate what it has read.
   */
  live: string | null;
}

/**
 * Why the Finish control is closed, or `null` when it is live.
 *
 * A static "available at 0.00" tells a screen-reader user the condition but
 * never how far off they are, and they cannot focus the button to find out.
 */
export function describeFinishBlock(sheet: ReconcileSheet): FinishBlock | null {
  if (sheet.status === 'finished') {
    return {rule: 'This statement is already reconciled. Reopen it to change what it matched.', live: null};
  }
  if (sheet.status === 'abandoned') {
    // No Reopen either: an abandoned statement froze nothing, so there is
    // nothing to release — the way on is a new reconciliation, and the sentence
    // says that rather than leaving a dead screen with no exit named.
    return {
      rule: 'This statement was abandoned. Nothing was reconciled and no posting was changed — start a new reconciliation on this account when you are ready.',
      live: null,
    };
  }
  if (!sheet.balanced) {
    return {
      rule: 'Finish is available once the difference reads exactly 0.00.',
      live: `It is ${formatWithSide(sheet.differenceMinor)} now.`,
    };
  }
  return null;
}

/**
 * Whether this row's tick may be changed at all (frozen rows may not).
 *
 * Keyed on "not open" rather than on `finished`: the server's tick surface
 * requires an OPEN reconciliation, so an `abandoned` sheet's checkboxes are
 * refused just as a finished one's are, and a UI that left them live would offer
 * a control whose every use is a rejection.
 */
export function isRowLocked(sheet: ReconcileSheet, row: ReconcileRow): boolean {
  return sheet.status !== 'open' || row.frozen;
}

/**
 * The checkbox's accessible name — everything that distinguishes THIS row.
 *
 * The date and description alone are not enough, and the canonical fixture is
 * the proof: the two halves of a duplicated rent payment produced the identical
 * string, so a screen-reader user could not tell the duplicate from the
 * original — the one distinction the entire workflow turns on — and the amount,
 * which is what a reconciliation is about, was absent entirely. Entry number and
 * amount are both included, and the LOCK REASON is folded in here rather than
 * left in a sibling: a disabled checkbox is out of the tab order, so a reason
 * placed beside it is unreachable by the people who need it.
 */
export function describeRowLabel(sheet: ReconcileSheet, row: ReconcileRow): string {
  const entry = row.entryNo === null ? 'unnumbered entry' : `entry #${row.entryNo}`;
  const label = row.description.trim() === '' ? 'no description' : row.description;
  const locked = isRowLocked(sheet, row)
    ? row.frozenStatementDate !== null
      ? ` Locked by the reconciliation of the ${row.frozenStatementDate} statement.`
      : ' Locked by a finished reconciliation.'
    : '';
  return `On this statement: ${entry}, ${row.date}, ${label}, ${formatWithSide(row.amountMinor)}.${locked}`;
}

/** Display labels for the reconciliation statuses (never the raw enum ids). */
export const RECONCILIATION_STATUS_LABEL: Record<ReconcileStatus, string> = {
  open: 'In progress',
  finished: 'Reconciled',
  // "Abandoned", not "Cancelled" or "Deleted": the record is still here, on
  // purpose, and the word has to say that the attempt ended without saying the
  // attempt was erased.
  abandoned: 'Abandoned',
};

/** Every cleared state the checklist can show, in workflow order. */
export const RECONCILE_STATES = ALL_CLEARED_STATES;
