import {formatAmount, parseAmount, sumAmounts} from '@book.dev/plugin-sdk';

/**
 * Pure journal-entry logic — no React, no IO. Everything the Post gate
 * decides lives here so it is unit-testable through the real plugin loader.
 *
 * UX choice: DEBIT/CREDIT COLUMNS (classic journal layout), not a single
 * signed field — bookkeepers think in debits and credits, and two columns
 * make the imbalance side legible. A row's signed wire amount is
 * `debit − credit` in integer minor units; exactly one column may be filled.
 */

/** One editable row of the journal entry block. Amounts are the RAW typed text. */
export interface JournalRow {
  accountId: string;
  /** Raw debit input text (major units, `parseAmount` grammar). */
  debit: string;
  /** Raw credit input text (major units, `parseAmount` grammar). */
  credit: string;
  /** Free-text memo. Kept in block props — the LGR-3 posting has no memo property. */
  memo: string;
}

export const emptyRow = (): JournalRow => ({accountId: '', debit: '', credit: '', memo: ''});

/** Per-row verdict of {@link computeEntryStatus}. */
export interface JournalRowStatus {
  /** Signed minor units (`debit − credit`), or `null` when empty/invalid. */
  amountMinor: number | null;
  /** The row typed something that does not parse, is ≤ 0, or filled BOTH columns. */
  invalid: boolean;
  /** WHY the row is invalid — so the UI can name it instead of only colouring it. */
  reason: 'both-columns' | 'unreadable-amount' | null;
  /** Account picked AND a valid amount in exactly one column. */
  complete: boolean;
}

export interface JournalEntryStatus {
  rows: JournalRowStatus[];
  /** Σ of every valid row's signed minor units. */
  sumMinor: number;
  /** Total debits (positive minor units) across valid rows. */
  debitMinor: number;
  /** Total credits (positive minor units) across valid rows. */
  creditMinor: number;
  /** How many rows carry a readable amount — the "is this entry underway" signal. */
  valuedRowCount: number;
  balanced: boolean;
  /** The Post gate: valid date ∧ Σ = 0 ∧ every row complete ∧ ≥ 2 rows. */
  canPost: boolean;
  /** The first reason Post is disabled, for the status line. */
  problem: 'invalid-date' | 'too-few-rows' | 'incomplete-rows' | 'unbalanced' | null;
}

/**
 * A real ISO `YYYY-MM-DD` calendar day — the shape the ledger's `date` takes.
 * Mirrors the server's `isValidLedgerDate` so the block can gate Post locally
 * instead of learning about a bad date from a rejection.
 */
export function isEntryDate(date: unknown): date is string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/**
 * Parse one raw amount cell into positive integer minor units via the money
 * core — the ONLY place user amount text becomes a number. Empty text is
 * `null`; unparseable or non-positive text is `'invalid'` (journal columns
 * carry positive magnitudes; the sign comes from the column).
 */
export function parseCell(raw: string): number | null | 'invalid' {
  if (raw.trim() === '') return null;
  try {
    const minor = parseAmount(raw);
    return minor > 0 ? minor : 'invalid';
  } catch {
    return 'invalid';
  }
}

/**
 * The Σ/validity computation behind the block: pure, deterministic, and the
 * single source of truth for the Post gate (the button just renders
 * `!canPost` as `disabled`). STRICT completeness: EVERY row must carry an
 * account and a valid single-column amount — remove leftover empty rows
 * instead of posting around them.
 */
export function computeEntryStatus(rows: JournalRow[], date?: string): JournalEntryStatus {
  const rowStatuses: JournalRowStatus[] = rows.map((row) => {
    const debit = parseCell(row.debit);
    const credit = parseCell(row.credit);
    const bothFilled = debit !== null && credit !== null;
    const unreadable = debit === 'invalid' || credit === 'invalid';
    const invalid = unreadable || bothFilled;
    const amountMinor = invalid ? null : typeof debit === 'number' ? debit : typeof credit === 'number' ? -credit : null;
    return {
      amountMinor,
      invalid,
      reason: unreadable ? 'unreadable-amount' : bothFilled ? 'both-columns' : null,
      complete: amountMinor !== null && row.accountId !== '',
    };
  });

  const amounts = rowStatuses.filter((r) => r.amountMinor !== null).map((r) => r.amountMinor as number);
  const sumMinor = sumAmounts(amounts);
  const debitMinor = sumAmounts(amounts.filter((a) => a > 0));
  const creditMinor = -sumAmounts(amounts.filter((a) => a < 0));
  const balanced = sumMinor === 0;
  const allComplete = rowStatuses.every((r) => r.complete);
  const enough = rows.length >= 2;
  // `date` is optional so callers that only ask about the rows keep working;
  // when the editor passes one, an unusable date closes the gate too.
  const dateOk = date === undefined || isEntryDate(date);
  return {
    rows: rowStatuses,
    sumMinor,
    debitMinor,
    creditMinor,
    valuedRowCount: amounts.length,
    balanced,
    canPost: dateOk && balanced && allComplete && enough,
    problem: !dateOk ? 'invalid-date' : !enough ? 'too-few-rows' : !allComplete ? 'incomplete-rows' : !balanced ? 'unbalanced' : null,
  };
}

/**
 * The out-of-balance sentence: magnitude AND side, or `null` when balanced.
 * Deliberately quiet until at least two rows carry an amount — every entry is
 * out of balance while it is being typed, and that is not an error.
 */
export function describeImbalance(status: JournalEntryStatus): string | null {
  if (status.balanced || status.valuedRowCount < 2) return null;
  return status.sumMinor > 0
    ? `Out of balance — debits exceed credits by ${formatAmount(status.sumMinor)}`
    : `Out of balance — credits exceed debits by ${formatAmount(-status.sumMinor)}`;
}

/**
 * The totals line under the grid — debit/credit sums plus the balance verdict.
 * Lives beside {@link describeImbalance} so magnitude-and-side is computed in
 * ONE place: the view renders this string, it never does money math itself.
 */
export function describeTotals(status: JournalEntryStatus): string {
  const totals = `Debits ${formatAmount(status.debitMinor)} · Credits ${formatAmount(status.creditMinor)}`;
  if (!status.balanced) return `${totals} · Out by ${formatAmount(status.sumMinor > 0 ? status.sumMinor : -status.sumMinor)}`;
  return `${totals} · ${status.valuedRowCount >= 2 ? 'In balance ✓' : 'Out by 0.00'}`;
}

/**
 * Why Post is disabled, in words — the block renders this so the gate is never
 * silent. `null` means the entry is ready to post.
 */
export function describeProblem(status: JournalEntryStatus): string | null {
  switch (status.problem) {
  case 'invalid-date':
    return 'Pick a date for this entry.';
  case 'too-few-rows':
    return 'Add at least two rows — an entry needs something on both sides.';
  case 'incomplete-rows': {
    const at = status.rows.findIndex((r) => r.reason === 'both-columns');
    if (at >= 0) return `Row ${at + 1}: enter a debit or a credit, not both.`;
    const bad = status.rows.findIndex((r) => r.reason === 'unreadable-amount');
    if (bad >= 0) return `Row ${bad + 1}: that amount can’t be read — try 1,234.56.`;
    // Name the row here too: on a five-row entry "every row needs…" makes the
    // user hunt for the one that doesn't.
    const empty = status.rows.findIndex((r) => !r.complete);
    return `Row ${empty + 1} needs an account and one amount.`;
  }
  case 'unbalanced':
    return describeImbalance(status) ?? 'Debits and credits must balance before posting.';
  default:
    return null;
  }
}

/**
 * Canonical display text for an amount cell, applied on blur: a readable
 * amount becomes its `formatAmount` rendering (`2000` → `2,000.00`) so the
 * grid and the totals never disagree about the same number. Empty or
 * unreadable text is returned untouched — blur must never eat what the user
 * typed while they are still fixing it.
 */
export function normalizeCell(raw: string): string {
  const parsed = parseCell(raw);
  return typeof parsed === 'number' ? formatAmount(parsed) : raw;
}

/**
 * The complete rows as ledger posting inputs — signed INTEGER minor units on
 * the wire, straight from {@link computeEntryStatus} (never re-parsed).
 */
export function rowsToPostings(rows: JournalRow[]): Array<{accountId: string; amountMinor: number}> {
  const status = computeEntryStatus(rows);
  return rows
    .map((row, i) => ({accountId: row.accountId, amountMinor: status.rows[i].amountMinor}))
    .filter((p): p is {accountId: string; amountMinor: number} => p.amountMinor !== null && p.accountId !== '');
}

/** Today as the ledger's ISO `YYYY-MM-DD` (local calendar day). */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The starter chart of accounts "Ledger: set up books" seeds (by name, idempotent). */
export const STARTER_CHART: ReadonlyArray<{name: string; type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'}> = [
  {name: 'Assets:Bank:Checking', type: 'asset'},
  {name: 'Assets:Cash', type: 'asset'},
  {name: 'Liabilities:CreditCard', type: 'liability'},
  {name: 'Equity:OpeningBalances', type: 'equity'},
  {name: 'Equity:RetainedEarnings', type: 'equity'},
  {name: 'Income:Revenue', type: 'revenue'},
  {name: 'Expenses:Hosting', type: 'expense'},
  {name: 'Expenses:Software', type: 'expense'},
  {name: 'Expenses:Office', type: 'expense'},
  {name: 'Expenses:Bank Fees', type: 'expense'},
];
