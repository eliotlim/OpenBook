/**
 * Canonical postings CSV (LGR-7): the ledger's insurance export.
 *
 * A book must always be able to LEAVE the app in a canonical, tool-agnostic
 * form. This module is a PURE function from ledger entities to CSV bytes —
 * no I/O, no clock, no locale — with the hard guarantee that the SAME DATA
 * always produces IDENTICAL BYTES:
 *
 *  - one row per posting, long form (a transaction with N postings emits N rows);
 *  - deterministic ordering: transactions by (entry_no ascending, drafts —
 *    which have no entry number — after all numbered entries by createdAt then
 *    id), postings in creation order within their transaction;
 *  - RFC-4180 quoting (fields containing `"` `,` CR or LF are quoted, inner
 *    quotes doubled), LF line endings, UTF-8 with NO BOM, trailing newline;
 *  - amounts appear twice: `amount_minor` (the raw signed integer of minor
 *    units — the authoritative value) and `amount_formatted` (the locale-pinned
 *    {@link formatAmount} display string, e.g. `$1,234.56`);
 *  - output depends only on FIELD VALUES, never on object key order.
 */

import {formatAmount} from './money';
import type {LedgerAccount, LedgerTransaction} from './ledger';

/**
 * The canonical column set, in order.
 *
 * | column            | content                                                            |
 * |-------------------|--------------------------------------------------------------------|
 * | entry_no          | server-assigned monotonic entry number; empty for drafts           |
 * | transaction_id    | transaction row id (UUID)                                          |
 * | date              | transaction ISO date (`YYYY-MM-DD`)                                |
 * | description       | transaction description (free text — see the apostrophe note)      |
 * | state             | `draft` / `posted` / `void`                                        |
 * | posting_id        | posting row id (UUID)                                              |
 * | account_name      | hierarchical account name (`Assets:Bank:Checking`)                 |
 * | account_type      | `asset` / `liability` / `equity` / `revenue` / `expense`           |
 * | amount_minor      | signed integer minor units (authoritative; ALWAYS verbatim)        |
 * | amount_formatted  | {@link formatAmount} display string; EMPTY if the amount is corrupt |
 * | currency          | the account's ISO-4217-shaped code                                 |
 * | cleared           | `pending` / `cleared` / `reconciled`                               |
 * | reconciliation_id | reconciliation row id, empty when none                             |
 * | reverses          | id of the transaction this entry reverses, empty when none         |
 * | posted_at         | ISO timestamp stamped at post time, empty for drafts               |
 * | posted_by         | principal subject that posted, empty for drafts                    |
 * | evidence_sha256s  | semicolon-joined SHA-256 hashes of attached evidence               |
 * | memo              | the POSTING's own free-text note (LGR-16); empty when none        |
 *
 * **Adding a column.** `memo` was APPENDED (LGR-16), never inserted: this list
 * is a documented contract, and a consumer that reads columns POSITIONALLY —
 * the spreadsheet formula somebody wrote against `I2`, the awk one-liner in a
 * runbook — keeps working across the change iff existing columns do not move.
 * Every future column belongs at the end for the same reason.
 *
 * **Free-text columns and the leading apostrophe.** `description`, `memo`,
 * `account_name` and `posted_by` carry text a ledger writer authored, so a
 * value that would open as a spreadsheet FORMULA (leading `=` `+` `-` `@`, tab
 * or CR) is emitted with a single leading apostrophe — the universal
 * "treat this as text" marker. A value that ALREADY begins with `'` is prefixed
 * too, which is what makes the escape INJECTIVE: a RE-IMPORTER strips ONE
 * leading `'` from exactly these four columns and recovers the original value
 * exactly, whether it was a formula lead-in or a genuine apostrophe. No other
 * column is ever prefixed (notably `amount_minor`, whose negatives legitimately
 * start with `-`), so machine columns round-trip byte-exactly.
 */
export const LEDGER_CSV_COLUMNS = [
  'entry_no',
  'transaction_id',
  'date',
  'description',
  'state',
  'posting_id',
  'account_name',
  'account_type',
  'amount_minor',
  'amount_formatted',
  'currency',
  'cleared',
  'reconciliation_id',
  'reverses',
  'posted_at',
  'posted_by',
  'evidence_sha256s',
  'memo',
] as const;

/**
 * The FREE-TEXT columns — the ones whose content a ledger writer authors. Only
 * these get spreadsheet-formula neutralization ({@link csvText}); the machine
 * columns (ids, enums, dates, and above all `amount_minor`) are emitted
 * verbatim so the file stays exactly parseable as data.
 */
const TEXT_COLUMNS: ReadonlySet<string> = new Set(['description', 'memo', 'account_name', 'posted_by']);

/**
 * Leading characters a spreadsheet treats as the start of a FORMULA rather than
 * text (`=SUM(...)`, `+`, `-`, `@`, and the tab/CR lead-ins some parsers strip
 * before dispatching). See {@link csvText}.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** RFC-4180: quote a field iff it contains a quote, comma, CR, or LF; double inner quotes. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * A free-text field, neutralized against CSV formula injection: a value that
 * would otherwise open as a spreadsheet FORMULA is prefixed with a single
 * apostrophe (the universal "treat as text" marker) before RFC-4180 quoting.
 * Scoped deliberately to {@link TEXT_COLUMNS} — a blanket prefix would corrupt
 * `amount_minor` (every negative amount starts with `-`) and break the
 * byte-canonical contract for machine columns.
 */
function csvText(value: string): string {
  // Prefix a value that ALREADY starts with `'` too, so the escape stays
  // INJECTIVE: without it `=SUM(1)` and `'=SUM(1)` would both emit `'=SUM(1)`,
  // and the documented "strip ONE leading apostrophe" re-import rule would
  // silently corrupt every value that legitimately begins with an apostrophe.
  const needsPrefix = FORMULA_LEAD.test(value) || value.startsWith('\'');
  return csvField(needsPrefix ? `'${value}` : value);
}

/**
 * The display amount, or `''` when the stored amount is too corrupt to format.
 *
 * The insurance export must NEVER throw on the very corruption it exists to
 * survive: a raw-mutated `amount_minor` (a float, a string, an unsafe integer)
 * makes `formatAmount` reject, which would fail the whole export at the exact
 * moment the book most needs to leave the building. The raw `amount_minor`
 * column still carries the stored value verbatim, and the verifier reports the
 * corruption as `invalid-amount`.
 */
function money(minor: number, currency?: string): string {
  try {
    return currency === undefined ? formatAmount(minor) : formatAmount(minor, {currency});
  } catch {
    return '';
  }
}

/** Locale-independent, byte-deterministic string compare (never `localeCompare`). */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build the canonical postings CSV from the full account list and the full
 * transaction list (with postings). Pure and deterministic — see module doc.
 *
 * Ordering: numbered entries (posted/void) ascend by `entryNo`; drafts (no
 * entry number) follow, ordered by (`createdAt`, `id`). Postings keep the
 * creation order their transaction carries. A posting whose account does not
 * resolve (should never happen — the verifier flags it) emits empty
 * account_name/account_type/currency and a currency-less formatted amount
 * rather than throwing, and an unformattable (raw-corrupted) amount emits an
 * empty `amount_formatted` while `amount_minor` keeps the stored value
 * verbatim — the insurance export always leaves the building.
 */
export function buildLedgerPostingsCsv(
  accounts: readonly LedgerAccount[],
  transactions: readonly LedgerTransaction[],
): string {
  const accountById = new Map<string, LedgerAccount>();
  for (const account of accounts) accountById.set(account.id, account);

  const ordered = [...transactions].sort((a, b) => {
    const an = a.entryNo ?? Number.POSITIVE_INFINITY;
    const bn = b.entryNo ?? Number.POSITIVE_INFINITY;
    if (an !== bn) return an < bn ? -1 : 1;
    return byteCompare(a.createdAt, b.createdAt) || byteCompare(a.id, b.id);
  });

  const lines: string[] = [LEDGER_CSV_COLUMNS.join(',')];
  for (const tx of ordered) {
    // Defensive per ELEMENT, not just per array: raw storage can hold a null
    // (or otherwise shapeless) evidence entry, and the insurance export must
    // never throw on the corruption it exists to survive.
    const evidence = tx.evidence.map((e) => String((e as {sha256?: unknown} | null)?.sha256 ?? '')).join(';');
    for (const posting of tx.postings) {
      const account = accountById.get(posting.accountId);
      const fields: string[] = [
        tx.entryNo == null ? '' : String(tx.entryNo),
        tx.id,
        tx.date,
        tx.description,
        tx.state,
        posting.id,
        account?.name ?? '',
        account?.type ?? '',
        String(posting.amountMinor),
        money(posting.amountMinor, account?.currency),
        account?.currency ?? '',
        posting.cleared,
        posting.reconciliationId ?? '',
        tx.reverses ?? '',
        tx.postedAt ?? '',
        tx.postedBy ?? '',
        evidence,
        // Defensive `?? ''`, not just for `null`: a raw-mutated row can hold a
        // non-string here, and the insurance export must emit SOMETHING rather
        // than `undefined` or a throw.
        typeof posting.memo === 'string' ? posting.memo : '',
      ];
      lines.push(
        fields.map((value, i) => (TEXT_COLUMNS.has(LEDGER_CSV_COLUMNS[i]) ? csvText(value) : csvField(value))).join(','),
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
