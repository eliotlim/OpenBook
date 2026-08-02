/**
 * Beancount export (LGR-13): the ledger serialized as a Beancount journal, so
 * the whole book can be re-checked by an INDEPENDENT accounting implementation
 * (`bean-check`, the beancount loader, Fava) — free QA for every invariant the
 * ledger claims to enforce.
 *
 * This module is a PURE function from ledger entities to journal text — no
 * I/O, no clock, no locale — with the same hard guarantee as the canonical CSV
 * (`./ledgerCsv`): the SAME DATA always produces IDENTICAL BYTES. It reads the
 * same entities the CSV export reads (one read model, two serializers).
 *
 * WHAT IS EMITTED (and why — the full contract lives in
 * `docs/ledger/beancount-export.md`):
 *
 *  - `open` for every account (earliest reported posting date, else the
 *    account's creation date), pinning the account's currency so bean-check
 *    enforces the ledger's own one-currency-per-account rule independently;
 *  - one `txn` per POSTED or VOID transaction — the exact set the report folds
 *    count (`REPORTED_STATES` in the ledger plugin's reports): a void original
 *    is offset by its posted reversal, and exporting only one half of the pair
 *    would misstate every balance. Drafts are not on the books and never
 *    export. Ledger-only facts (id, entry number, state, kind, reverses,
 *    evidence, memo, cleared state) ride as `lp-*` metadata;
 *  - `balance` assertions the day after each CLOSED period's end, for every
 *    account with a reported posting on or before the end — so bean-check
 *    re-verifies both the arithmetic and the closing sweep (income-statement
 *    accounts assert to zero) from the directives alone.
 *
 * SIGN MAPPING — the identity. The ledger stores signed DEBIT-POSITIVE minor
 * units (LGR-2); Beancount amounts are signed decimals where an asset increase
 * is positive and a credit-normal balance (Income/Liabilities/Equity) is
 * negative — the same convention. No re-signing happens anywhere, including
 * for contra/credit-normal accounts: a revenue balance exports negative, which
 * is exactly how Beancount's own Income accounts carry it.
 *
 * MONEY DISCIPLINE: amounts pass through {@link formatBeancountAmount} (exact
 * BigInt digit math, the `formatAmount` discipline without display grouping)
 * and {@link sumAmounts} — never float arithmetic.
 *
 * CORRUPT BOOKS: unlike the insurance CSV (which must always leave the
 * building), this export REFUSES a damaged book — an unresolvable account or a
 * non-safe-integer amount throws a typed error instead of serializing a
 * plausible-but-wrong journal. The reference implementation must never be
 * handed data the ledger itself cannot vouch for; the LGR-7 verifier is the
 * tool that names the damage.
 */

import {MoneyRangeError, isValidMinor, sumAmounts} from './money';
import {LedgerError, type LedgerAccount, type LedgerAccountType, type LedgerPeriod, type LedgerTransaction} from './ledger';

/**
 * The Beancount ROOT for each ledger account type. Beancount requires every
 * account to live under one of exactly five roots; the ledger's five types map
 * onto them 1:1 (`revenue` → `Income` is the only rename).
 */
export const BEANCOUNT_ROOT_BY_TYPE: Readonly<Record<LedgerAccountType, string>> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
  revenue: 'Income',
  expense: 'Expenses',
};

/**
 * Serialize signed integer minor units as Beancount's plain decimal
 * (`-1234.56`, `0.00`) — {@link formatAmount}'s exact BigInt digit math minus
 * the display affordances (no thousands grouping, no symbols, no parens),
 * because Beancount wants a machine number. Negative zero normalises to
 * `0.00`. Throws {@link MoneyRangeError} on anything that is not a safe
 * integer — see the module doc's corrupt-books stance.
 */
export function formatBeancountAmount(minor: number): string {
  if (!isValidMinor(minor)) {
    throw new MoneyRangeError(`formatBeancountAmount: amount must be a safe integer of minor units, got ${String(minor)}`);
  }
  const big = BigInt(minor);
  const negative = big < 0n;
  const abs = negative ? -big : big;
  return `${negative ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/**
 * Quote a string for Beancount: backslash and double-quote are escaped (the
 * two characters the lexer treats specially inside a string); everything else
 * — including literal newlines and non-ASCII — is verbatim, which the lexer
 * accepts (verified against beancount 3.1.0). Escaping only these two keeps
 * the mapping injective: a re-importer that unescapes `\\` and `\"` recovers
 * the original exactly.
 */
export function quoteBeancountString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Beancount's currency grammar (shape only, like `isValidCurrencyCode`). */
const BEANCOUNT_CURRENCY_RE = /^[A-Z][A-Z0-9'._-]{0,22}[A-Z0-9]$|^[A-Z]$/;

/**
 * Mangle ONE colon-separated component of a ledger account name into
 * Beancount's component charset, deterministically:
 *
 *  1. every character outside `[A-Za-z0-9-]` becomes `-` (one `-` per
 *     character — no collapsing, so distinct inputs stay distinct more often);
 *  2. a leading lowercase letter is uppercased; any other invalid lead
 *     (digit-ok, letter-ok; a `-` or nothing) is prefixed with `X`.
 *
 * The ledger's own name validator guarantees non-empty, non-whitespace-only
 * components, but raw storage is not trusted: an empty component mangles to
 * `X` instead of producing an invalid name.
 */
export function mangleBeancountComponent(segment: string): string {
  let s = segment.replace(/[^A-Za-z0-9-]/g, '-');
  if (s === '') s = 'X';
  if (!/^[A-Z0-9]/.test(s)) {
    s = /^[a-z]/.test(s) ? s[0].toUpperCase() + s.slice(1) : `X${s}`;
  }
  return s;
}

/**
 * Map ONE ledger account name onto a Beancount account name (before collision
 * handling — see {@link buildBeancountAccountNames} for the full map):
 *
 *  - the ROOT comes from the account TYPE ({@link BEANCOUNT_ROOT_BY_TYPE}),
 *    never from the name — `Revenue:Sales` typed `revenue` becomes
 *    `Income:Revenue:Sales`;
 *  - each component is mangled ({@link mangleBeancountComponent});
 *  - a first component that already equals the root is not repeated
 *    (`Assets:Bank` stays `Assets:Bank`, not `Assets:Assets:Bank`) — unless
 *    dropping it would leave the bare root, which Beancount rejects (an
 *    account named exactly `Assets` becomes `Assets:Assets`).
 */
export function beancountAccountName(account: Pick<LedgerAccount, 'name' | 'type'>): string {
  const root = BEANCOUNT_ROOT_BY_TYPE[account.type] ?? 'Equity';
  const components = String(account.name).split(':').map(mangleBeancountComponent);
  const rest = components[0] === root && components.length > 1 ? components.slice(1) : components;
  return `${root}:${rest.join(':')}`;
}

/**
 * The full account-id → Beancount-name map, with DETERMINISTIC collision
 * handling: accounts are visited in (createdAt, id) order; the first claimant
 * keeps the mapped name, later ones append `-2`, `-3`, … to the final
 * component (bumping until free). Stable for a given book — the suffix order
 * depends only on stored creation data, never on read order.
 */
export function buildBeancountAccountNames(accounts: readonly LedgerAccount[]): Map<string, string> {
  const ordered = [...accounts].sort(
    (a, b) => byteCompare(a.createdAt, b.createdAt) || byteCompare(a.id, b.id),
  );
  const taken = new Set<string>();
  const names = new Map<string, string>();
  for (const account of ordered) {
    const base = beancountAccountName(account);
    let name = base;
    for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
    taken.add(name);
    names.set(account.id, name);
  }
  return names;
}

/** Locale-independent, byte-deterministic string compare (never `localeCompare`). */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The transaction states that are ON THE BOOKS — the report folds' rule
 *  (posted and void both count; a void original is offset by its posted
 *  reversal). Drafts never export. */
const EXPORTED_STATES: ReadonlySet<string> = new Set(['posted', 'void']);

/** ISO `YYYY-MM-DD` + 1 day, in UTC (balance assertions bind at the START of
 *  their date, so "after period end" means the following day). */
function nextIsoDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

/** The account's currency, coerced onto Beancount's currency grammar. The
 *  ledger validates ISO-4217 shape at write time, so anything else is raw
 *  corruption — mapped to the ISO placeholder `XXX` rather than emitting a
 *  token bean-check cannot lex (the amount still exports verbatim, so the
 *  corruption stays visible instead of failing the whole journal on syntax). */
function beancountCurrency(currency: unknown): string {
  return typeof currency === 'string' && BEANCOUNT_CURRENCY_RE.test(currency) ? currency : 'XXX';
}

/**
 * Canonical transaction order — the CSV export's: entry number ascending
 * (posted and void entries always carry one), then (createdAt, id) for
 * defensive totality over raw-corrupted rows.
 */
function canonicalTxOrder(a: LedgerTransaction, b: LedgerTransaction): number {
  const an = a.entryNo ?? Number.POSITIVE_INFINITY;
  const bn = b.entryNo ?? Number.POSITIVE_INFINITY;
  if (an !== bn) return an < bn ? -1 : 1;
  return byteCompare(a.createdAt, b.createdAt) || byteCompare(a.id, b.id);
}

/**
 * Build the Beancount journal from the full account list, the full
 * transaction list (with postings) and the period records — the same read
 * model the canonical CSV uses. Pure and byte-deterministic; see module doc.
 *
 * Throws {@link LedgerError} `account-not-found` when a posting references an
 * account the list does not carry, and {@link MoneyRangeError} on a stored
 * amount that is not a safe integer — the corrupt-books stance.
 */
export function buildLedgerBeancount(
  accounts: readonly LedgerAccount[],
  transactions: readonly LedgerTransaction[],
  periods: readonly LedgerPeriod[],
): string {
  const names = buildBeancountAccountNames(accounts);
  const accountById = new Map<string, LedgerAccount>();
  for (const account of accounts) accountById.set(account.id, account);

  const reported = transactions.filter((tx) => EXPORTED_STATES.has(tx.state)).sort(canonicalTxOrder);

  // Earliest reported posting date per account — the `open` date (an account
  // must be open on or before its first use; creation timestamps can postdate
  // a backdated entry, so the postings win when they exist).
  const firstUse = new Map<string, string>();
  for (const tx of reported) {
    for (const posting of tx.postings) {
      const seen = firstUse.get(posting.accountId);
      if (seen === undefined || tx.date < seen) firstUse.set(posting.accountId, tx.date);
    }
  }

  const lines: string[] = [
    '; OpenBook ledger — Beancount export (LGR-13).',
    '; Deterministic: the same book always serializes to identical bytes.',
    '; Sign mapping, account-name mangling, and round-trip limitations:',
    ';   docs/ledger/beancount-export.md',
    'option "title" "OpenBook ledger"',
    '',
  ];

  // ── open directives (sorted by mapped name — unique by construction) ────────
  const openOrder = [...accounts].sort((a, b) => byteCompare(names.get(a.id) ?? '', names.get(b.id) ?? ''));
  for (const account of openOrder) {
    const name = names.get(account.id) ?? beancountAccountName(account);
    const date = firstUse.get(account.id) ?? String(account.createdAt).slice(0, 10);
    lines.push(`${date} open ${name} ${beancountCurrency(account.currency)}`);
    lines.push(`  lp-id: ${quoteBeancountString(account.id)}`);
    // The original ledger name, when mangling changed it — what makes the
    // mapping reversible without consulting the ledger.
    if (account.name !== name) lines.push(`  lp-name: ${quoteBeancountString(account.name)}`);
  }
  lines.push('');

  // ── transactions ────────────────────────────────────────────────────────────
  for (const tx of reported) {
    lines.push(`${tx.date} * ${quoteBeancountString(tx.description)}`);
    lines.push(`  lp-id: ${quoteBeancountString(tx.id)}`);
    if (tx.entryNo != null) lines.push(`  lp-entry-no: ${String(tx.entryNo)}`);
    if (tx.state === 'void') lines.push('  lp-state: "void"');
    if (tx.kind === 'closing') lines.push('  lp-kind: "closing"');
    if (tx.reverses != null && tx.reverses !== '') lines.push(`  lp-reverses: ${quoteBeancountString(tx.reverses)}`);
    // Evidence attachments are ids + hashes, not exportable files, so they ride
    // as metadata — a `document` directive would make bean-check fail on the
    // missing file (verified against beancount 3.1.0; see docs).
    tx.evidence.forEach((item, i) => {
      const e = (item ?? {}) as {filename?: unknown; sha256?: unknown; size?: unknown};
      const described = `${String(e.filename ?? '')} sha256=${String(e.sha256 ?? '')} size=${String(e.size ?? '')}`;
      lines.push(`  lp-evidence-${i + 1}: ${quoteBeancountString(described)}`);
    });
    for (const posting of tx.postings) {
      const account = accountById.get(posting.accountId);
      if (account === undefined) {
        throw new LedgerError(
          'account-not-found',
          `Beancount export: posting ${posting.id} references unknown account ${posting.accountId} — run the ledger verifier; the reference export refuses a damaged book`,
        );
      }
      const name = names.get(posting.accountId) ?? beancountAccountName(account);
      lines.push(`  ${name}  ${formatBeancountAmount(posting.amountMinor)} ${beancountCurrency(account.currency)}`);
      if (typeof posting.memo === 'string' && posting.memo !== '') {
        lines.push(`    lp-memo: ${quoteBeancountString(posting.memo)}`);
      }
      if (posting.cleared === 'cleared' || posting.cleared === 'reconciled') {
        lines.push(`    lp-cleared: ${quoteBeancountString(posting.cleared)}`);
      }
    }
    lines.push('');
  }

  // ── balance assertions after each CLOSED period ─────────────────────────────
  // Only `closed` periods assert (a reopened period is history, not a live
  // claim). Every account with a reported posting on or before the period end
  // asserts its whole-book balance as of that end — income-statement accounts
  // come out 0 after the closing sweep, so bean-check re-verifies the close.
  const closed = periods
    .filter((p) => p.status === 'closed')
    .sort((a, b) => byteCompare(a.end, b.end) || byteCompare(a.start, b.start) || byteCompare(a.id, b.id));
  for (const period of closed) {
    lines.push(`; Balance assertions after closed period ${period.start} .. ${period.end}.`);
    const assertDate = nextIsoDay(period.end);
    for (const account of openOrder) {
      const first = firstUse.get(account.id);
      if (first === undefined || first > period.end) continue;
      const amounts: number[] = [];
      for (const tx of reported) {
        if (tx.date > period.end) continue;
        for (const posting of tx.postings) {
          if (posting.accountId !== account.id) continue;
          if (!isValidMinor(posting.amountMinor)) {
            throw new MoneyRangeError(
              `Beancount export: posting ${posting.id} carries a non-integer amount — run the ledger verifier`,
            );
          }
          amounts.push(posting.amountMinor);
        }
      }
      const name = names.get(account.id) ?? beancountAccountName(account);
      lines.push(`${assertDate} balance ${name} ${formatBeancountAmount(sumAmounts(amounts))} ${beancountCurrency(account.currency)}`);
    }
    lines.push('');
  }

  // Exactly one trailing newline: drop the trailing blank separator, join LF.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}
