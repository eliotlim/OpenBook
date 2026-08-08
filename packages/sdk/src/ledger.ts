/**
 * Ledger contract (LGR-3): the shared types, typed errors, and pure audit-replay
 * reducer for the server-enforced double-entry ledger.
 *
 * Data model: ledger data lives in FOUR server-managed OpenBook databases
 * (accounts / transactions / postings / reconciliations) seeded on a restricted
 * host page. Rows are ordinary pages; every ledger value is a database property.
 * The server's `LedgerStore` is the ONLY writer — the generic page/row mutation
 * surface (HTTP routes AND direct store calls) rejects writes to ledger rows, so
 * the invariants hold in both server mode and browser-local (PGlite) mode.
 *
 * Money: amounts are SIGNED INTEGER MINOR UNITS (LGR-2, see `./money`). Amounts
 * on the wire are integers — never parsed strings.
 */

/** Machine-readable ledger error categories. */
export type LedgerErrorCode =
  | 'not-initialized' // the ledger databases have not been seeded yet
  | 'not-found' // account / transaction / posting does not exist
  | 'managed' // direct write to a server-managed ledger row/database
  | 'immutable' // mutation of a posted (or void) transaction / its postings
  | 'unbalanced' // Σ amount_minor ≠ 0 at post time
  | 'too-few-postings' // fewer than 2 postings at post time
  | 'invalid-amount' // amount not a safe signed integer of minor units
  | 'account-not-found' // a posting references a nonexistent account
  | 'account-closed' // a posting references a closed account
  | 'currency-mismatch' // postings span accounts of different currencies
  | 'invalid-state' // operation not valid for the entity's current state
  | 'nonzero-balance' // closing an account whose posted balance is not zero
  | 'reconciled-locked' // cleared-state change on a reconciled posting
  | 'reconciliation-exists' // a second OPEN reconciliation on the same account
  | 'reconciliation-unbalanced' // finishing while the difference is not exactly 0
  | 'posting-not-reconcilable' // a draft posting, or one on another account
  | 'reconciliation-too-large' // more postings on the account than one match may cover
  | 'period-closed' // a posting/reversal dated inside a CLOSED period (LGR-12)
  | 'period-overlap' // closing a range that overlaps an already-closed period
  | 'period-out-of-order' // closing a range that ends before an already-closed period does
  | 'period-close-conflict' // the books changed while the close was in flight — retry
  | 'evidence-required' // posting into an evidence-required account with no evidence attached (LGR-14)
  | 'invalid-input'; // malformed input (bad date, bad name, bad enum value)

/**
 * HTTP status the API maps each {@link LedgerErrorCode} to.
 *
 * The three LGR-11 reconciliation rejections are 409, not 400: they are all
 * "not valid for the CURRENT state of the book" rather than malformed requests.
 * The identical call becomes legal once the open reconciliation is finished,
 * once the difference reaches zero, or once the posting is posted — which is
 * what tells a client to re-read and retry instead of fixing its payload.
 */
export function ledgerErrorStatus(code: LedgerErrorCode): 400 | 403 | 404 | 409 {
  switch (code) {
  case 'not-initialized':
  case 'not-found':
    return 404;
  case 'managed':
  case 'immutable':
  case 'reconciled-locked':
    return 403;
  // The three LGR-12 period rejections are state-of-the-book conflicts too:
  // the identical call becomes legal once the period is reopened (or, for a
  // close conflict, simply retried against the settled book). So is the LGR-14
  // evidence rejection: the identical post becomes legal once evidence is
  // attached to the draft (or the account's evidence-required toggle is turned
  // off) — re-read and retry, don't fix the payload.
  case 'invalid-state':
  case 'nonzero-balance':
  case 'reconciliation-exists':
  case 'reconciliation-unbalanced':
  case 'posting-not-reconcilable':
  case 'reconciliation-too-large':
  case 'period-closed':
  case 'period-overlap':
  case 'period-out-of-order':
  case 'period-close-conflict':
  case 'evidence-required':
    return 409;
  default:
    return 400;
  }
}

/**
 * Typed ledger error. The server REJECTS invariant violations with these (never
 * advises); the HTTP layer maps them to `{error, code}` bodies via
 * {@link ledgerErrorStatus} and `HttpDataClient` re-materializes them, so a
 * caller catches the same error class over either transport.
 */
export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

/** The set of valid codes, for wire-body → {@link LedgerError} re-materialization. */
export const LEDGER_ERROR_CODES: readonly LedgerErrorCode[] = [
  'not-initialized',
  'not-found',
  'managed',
  'immutable',
  'unbalanced',
  'too-few-postings',
  'invalid-amount',
  'account-not-found',
  'account-closed',
  'currency-mismatch',
  'invalid-state',
  'nonzero-balance',
  'reconciled-locked',
  'reconciliation-exists',
  'reconciliation-unbalanced',
  'posting-not-reconcilable',
  'reconciliation-too-large',
  'period-closed',
  'period-overlap',
  'period-out-of-order',
  'period-close-conflict',
  'evidence-required',
  'invalid-input',
];

// ── Domain enums ───────────────────────────────────────────────────────────────

export const LEDGER_ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
export type LedgerAccountType = (typeof LEDGER_ACCOUNT_TYPES)[number];

export const LEDGER_ACCOUNT_STATUSES = ['open', 'closed'] as const;
export type LedgerAccountStatus = (typeof LEDGER_ACCOUNT_STATUSES)[number];

export const LEDGER_TRANSACTION_STATES = ['draft', 'posted', 'void'] as const;
export type LedgerTransactionState = (typeof LEDGER_TRANSACTION_STATES)[number];

export const LEDGER_CLEARED_STATES = ['pending', 'cleared', 'reconciled'] as const;
export type LedgerClearedState = (typeof LEDGER_CLEARED_STATES)[number];

/**
 * A reconciliation's lifecycle (LGR-11 + LGR-22).
 *
 * `abandoned` is a TERMINAL status, not a deletion: a statement someone opened
 * against the wrong closing balance still happened, and the record of it — with
 * the audit events that amended and ended it — is what lets a later reader tell
 * "this account was never reconciled" apart from "this attempt was given up on".
 * It is invisible to the one-open-per-account rule (which asks only for `open`),
 * so abandoning immediately frees the account for a fresh start.
 */
export const LEDGER_RECONCILIATION_STATUSES = ['open', 'finished', 'abandoned'] as const;
export type LedgerReconciliationStatus = (typeof LEDGER_RECONCILIATION_STATUSES)[number];

/**
 * A period's lifecycle (LGR-12). `reopened` is TERMINAL for the RECORD, not for
 * the range: reopening keeps the row (with the reversal that voided its closing
 * entry) so the settings UI and the audit trail can show that a close happened
 * and was undone; closing the range again writes a NEW period record. Only
 * `closed` periods lock dates.
 */
export const LEDGER_PERIOD_STATUSES = ['closed', 'reopened'] as const;
export type LedgerPeriodStatus = (typeof LEDGER_PERIOD_STATUSES)[number];

/**
 * The account types a period close sweeps into retained earnings (LGR-12): the
 * income-statement ("flow") accounts. ONE list, exported, because the server's
 * closing-entry generator and any report fold that classifies flow accounts
 * must agree — this epic's recurring defect is two copies of one fact.
 */
export const LEDGER_INCOME_STATEMENT_ACCOUNT_TYPES = ['revenue', 'expense'] as const;

/** Whether `type` names an income-statement (flow) account. */
export function isIncomeStatementAccountType(type: unknown): type is 'revenue' | 'expense' {
  return (LEDGER_INCOME_STATEMENT_ACCOUNT_TYPES as readonly unknown[]).includes(type);
}

// ── Read bounds ────────────────────────────────────────────────────────────────

/**
 * The server's HARD CAP on one `listTransactions` page: a larger `limit` is
 * clamped to this, silently.
 *
 * Exported because a reader that totals what it fetched — a report — cannot
 * tell a full page from a complete book without it, and a duplicated literal
 * would rot: if this cap ever dropped, a report asking for the old number would
 * be clamped, conclude it had read everything, and render a PARTIAL total as a
 * complete one. Both the server clamp and the ledger plugin's report read this
 * one constant, and `ledger.test.ts` asserts the clamp actually holds.
 */
export const LEDGER_MAX_TRANSACTION_LIMIT = 1000;

/** The page size `listTransactions` uses when the caller names none. */
export const LEDGER_DEFAULT_TRANSACTION_LIMIT = 500;

// ── Property ids (stable — the seeded database schemas key rows by these) ──────

/** Stable property ids for the seeded ledger database schemas. */
export const LEDGER_PROP = {
  account: {
    type: 'lp_type',
    status: 'lp_status',
    currency: 'lp_currency',
    /** LGR-14: `true` on an account that refuses to accept a posting from an
     *  entry with no evidence attached; absent everywhere else (additive — no
     *  migration, pre-LGR-14 accounts read back `false`). */
    evidenceRequired: 'lp_evidence_required',
  },
  transaction: {
    date: 'lp_date',
    description: 'lp_description',
    state: 'lp_state',
    postedAt: 'lp_posted_at',
    postedBy: 'lp_posted_by',
    reverses: 'lp_reverses',
    evidence: 'lp_evidence',
    entryNo: 'lp_entry_no',
    /** LGR-12: `'closing'` on a period-close entry; absent on ordinary entries. */
    kind: 'lp_kind',
  },
  posting: {
    transaction: 'lp_transaction',
    account: 'lp_account',
    amount: 'lp_amount_minor',
    cleared: 'lp_cleared',
    reconciliation: 'lp_reconciliation',
    memo: 'lp_memo',
  },
  reconciliation: {
    account: 'lp_account',
    statementDate: 'lp_statement_date',
    statementBalance: 'lp_statement_balance_minor',
    status: 'lp_status',
  },
} as const;

// ── Entities ───────────────────────────────────────────────────────────────────

/**
 * One piece of evidence attached to a transaction (LGR-14): the post-time
 * manifest entry. `sha256` IS the asset-store id (assets are content-addressed
 * — the id is the SHA-256 hex of the bytes), so "which file" and "which bytes"
 * are one fact: replacing the stored bytes without changing this hash is
 * impossible through any API, and detecting a direct-SQL replacement is one
 * re-hash (the verifier's evidence check). `filename` is the display name the
 * uploader gave it; `size` is the asset store's byte count, resolved
 * server-side at attach time — never client-supplied.
 *
 * On a POSTED transaction the manifest is frozen with the rest of the entry
 * (it is inside `transactionContent`, so inside the audit before/after hashes).
 */
export interface LedgerEvidence {
  filename: string;
  sha256: string;
  size: number;
}

/**
 * One evidence attachment as a CLIENT names it (LGR-14): the content-hash id
 * of an already-uploaded asset plus a display filename. No `size` — the server
 * resolves it from the asset store (measuring the bytes, not trusting a cached
 * column), so a manifest can never claim a byte count the store does not hold.
 *
 * CONFIDENTIALITY (accepted, stated): an asset inherits the read gate of EVERY
 * page that references it. Attaching refs the asset to the ledger's own
 * transaction row, but the UPLOAD already ref'd it to the page it was uploaded
 * from — so a receipt uploaded from a widely-shared page stays readable to
 * that page's audience for as long as that page references it. That is the
 * platform's standing asset semantics; this feature puts receipts into them.
 * Upload sensitive receipts from pages whose audience is the ledger's.
 */
export interface LedgerEvidenceInput {
  /** The asset-store id: 64 lowercase hex chars — the SHA-256 of the bytes. */
  sha256: string;
  filename: string;
}

/** A ledger account. `name` is hierarchical, colon-delimited (`Assets:Bank:Checking`). */
export interface LedgerAccount {
  id: string;
  name: string;
  type: LedgerAccountType;
  status: LedgerAccountStatus;
  /** ISO-4217-shaped currency code. Defaults to `USD`. */
  currency: string;
  /**
   * LGR-14: when `true`, posting an entry with a leg on this account is
   * REJECTED (`evidence-required`) unless the entry has evidence attached.
   * `false` is what every account written before LGR-14 reads back as (the
   * stored key is simply absent — additive, no migration). Reversals and
   * server-generated closing entries are exempt: a reversal CARRIES its
   * original's manifest (F1), and a closing entry is derived arithmetic.
   *
   * PRESENCE-ONLY, by design: the gate asserts that some file was attached at
   * post time, not that it is the right one — the badge and the manifest read
   * as "this entry can answer with what was filed", never as attestation that
   * the filing is correct or even relevant. The verifier's
   * `evidence-required-missing` advisory reports entries that do not satisfy
   * the CURRENT policy — turning this flag on flags history, deliberately.
   */
  evidenceRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One leg of a transaction. `amountMinor` is a signed integer of minor units. */
export interface LedgerPosting {
  id: string;
  transactionId: string;
  accountId: string;
  amountMinor: number;
  cleared: LedgerClearedState;
  reconciliationId: string | null;
  /**
   * Free-text note on THIS LEG (LGR-16) — "gross wages", the bank's raw
   * statement line, the invoice number. Distinct from the transaction's
   * `description`, which describes the entry as a whole; a compound entry's
   * legs each carry their own. Length-capped exactly like `description`.
   *
   * `null` means no memo, and is what every posting written before LGR-16
   * reads back as — the field is additive, so no migration is required.
   */
  memo: string | null;
}

/** A journal entry with its postings. Compound (n-ary) entries are first-class. */
export interface LedgerTransaction {
  id: string;
  /** ISO date (`YYYY-MM-DD`). */
  date: string;
  description: string;
  state: LedgerTransactionState;
  /** Set exactly once at posting; never mutated afterwards. */
  postedAt: string | null;
  postedBy: string | null;
  /** The transaction this one reverses, when it is a reversal. */
  reverses: string | null;
  /** Server-assigned monotonic entry number (per library), set at posting. */
  entryNo: number | null;
  /**
   * Entry kind (LGR-12). `'closing'` marks the server-generated period-close
   * entry — the one that sweeps income-statement balances into retained
   * earnings. `null` on every ordinary entry AND on every entry written before
   * LGR-12 (the field is additive; no migration). Reports use it (plus the
   * `reverses` link, for the reversal a reopen posts) to keep closing entries
   * out of income-statement arithmetic.
   */
  kind: 'closing' | null;
  /**
   * The evidence manifest (LGR-14). On a DRAFT: what is attached so far, live.
   * On a POSTED entry: the manifest snapshotted at post time — frozen with the
   * entry (it is part of the audited content), never mutated afterwards.
   * A REVERSAL carries its original's manifest verbatim (F1) — "a reversal's
   * evidence is the original entry it undoes", made literal, so a reversal
   * chain stays answerable end to end and double-reversing cannot launder the
   * receipts off a live entry. Empty on entries written before LGR-14, on
   * reversals of bare entries, and on server-generated closing entries.
   */
  evidence: LedgerEvidence[];
  postings: LedgerPosting[];
  createdAt: string;
  updatedAt: string;
}

/**
 * One statement reconciliation (LGR-11): an account, the statement it is being
 * matched against, and whether that match has been FINISHED.
 *
 * `finished` is only reachable at a difference of exactly zero (statement
 * balance − cleared balance = 0), and finishing FREEZES the postings it matched
 * (`cleared: 'reconciled'` + `reconciliationId` set — invariant 4). Reopening is
 * an explicit, audited step that unfreezes them again.
 *
 * While OPEN it is also correctable and abandonable (LGR-22): the target itself
 * can be mistyped, and a wrong target is unreachable by definition — the
 * difference can never be driven to zero, `finish` is therefore unreachable, and
 * before LGR-22 the account could never be reconciled again. See
 * {@link LedgerReconciliationPatch}.
 */
export interface LedgerReconciliation {
  id: string;
  accountId: string;
  /** ISO date (`YYYY-MM-DD`) the statement closes on. */
  statementDate: string;
  /**
   * The statement's closing balance in SIGNED INTEGER MINOR UNITS, on the
   * ledger's debit-positive convention (LGR-2) — the same convention every
   * posting amount uses, so the difference is one subtraction and never a
   * re-signing. A UI that asks for it on the account's NORMAL side is
   * responsible for converting before it gets here.
   */
  statementBalanceMinor: number;
  status: LedgerReconciliationStatus;
  createdAt: string;
  /** Bumped by every start/toggle-free mutation — finish and reopen included. */
  updatedAt: string;
}

export interface LedgerReconciliationInput {
  accountId: string;
  /** ISO date (`YYYY-MM-DD`). */
  statementDate: string;
  /** Signed integer minor units, debit-positive. Never a parsed string. */
  statementBalanceMinor: number;
}

/**
 * AMEND an OPEN reconciliation (LGR-22): correct the statement it is being
 * matched against, without touching a single posting.
 *
 * The account is deliberately NOT amendable. Changing it would leave the ticks
 * already made pointing at another account's postings, which is not a
 * correction but a different reconciliation — abandon this one and start that
 * one. Everything here is optional, but a patch that names nothing is rejected
 * (`invalid-input`): a mutation that changes nothing must not write an audit
 * event claiming it did.
 */
export interface LedgerReconciliationPatch {
  /** ISO date (`YYYY-MM-DD`). */
  statementDate?: string;
  /** Signed integer minor units, debit-positive — the same convention as
   *  {@link LedgerReconciliationInput.statementBalanceMinor}. */
  statementBalanceMinor?: number;
}

/**
 * What a reconciliation looks like once its postings are counted — the exact
 * arithmetic a bookkeeper checks, computed server-side so the Finish gate and
 * the on-screen readout can never disagree.
 */
export interface LedgerReconciliationSummary {
  reconciliation: LedgerReconciliation;
  /** Σ of every `cleared`/`reconciled` posting on the account, debit-positive. */
  clearedBalanceMinor: number;
  /** `statementBalanceMinor − clearedBalanceMinor`. Finish requires exactly 0. */
  differenceMinor: number;
  /** The postings this reconciliation matched (only meaningful once finished). */
  matchedPostingIds: string[];
}

/**
 * One accounting period close (LGR-12): an inclusive date range the store has
 * LOCKED — no posting and no reversal may be DATED inside a `closed` period —
 * plus the closing entry that swept the income-statement balances into
 * retained earnings when the range was closed.
 *
 * Storage: the periods live in ONE `settings` row (`ledgerPeriods`), not in a
 * fifth managed database. See `LedgerStore.closePeriod` for why (short form: a
 * book seeded before LGR-12 can never grow a fifth database — the seed's adopt
 * check returns early — and the row IS the lock the close flow serializes on,
 * at the `settings` slot the proven lock order already holds).
 */
export interface LedgerPeriod {
  id: string;
  /** Inclusive ISO date (`YYYY-MM-DD`) the period starts on. */
  start: string;
  /** Inclusive ISO date (`YYYY-MM-DD`) the period ends on. */
  end: string;
  status: LedgerPeriodStatus;
  /**
   * The closing entry posted when this period was closed, or `null` when the
   * range held no income-statement balance to close (the range still locks).
   * Kept after a reopen (the entry is `void` then — history, not a live claim).
   */
  closingEntryId: string | null;
  /** The reversal that voided the closing entry at reopen; `null` until then. */
  reopenEntryId: string | null;
  closedAt: string;
  closedBy: string;
  reopenedAt: string | null;
  reopenedBy: string | null;
}

/** `POST /api/ledger/periods` — close a period. */
export interface LedgerPeriodCloseInput {
  /** Inclusive ISO date (`YYYY-MM-DD`). */
  start: string;
  /** Inclusive ISO date (`YYYY-MM-DD`); must not precede `start`. */
  end: string;
  /**
   * The equity account the closing entry credits. Defaults to the account
   * named `Equity:RetainedEarnings`; rejected `account-not-found` when neither
   * is resolvable (create the account first — the starter chart carries it).
   */
  retainedEarningsAccountId?: string;
}

/** What a period close returns: the lock, the entry, and the WARNING list. */
export interface LedgerPeriodCloseResult {
  period: LedgerPeriod;
  /** `null` when the range had no income-statement balance to close. */
  closingEntry: LedgerTransaction | null;
  /**
   * Reconciliations still OPEN with a statement dated on or before the close
   * (warn-not-block by design): the close proceeds, and this names what is
   * unfinished so the UI can say so instead of gating.
   */
  openReconciliations: LedgerReconciliation[];
}

/** What a period reopen returns: the unlocked period and the voiding reversal. */
export interface LedgerPeriodReopenResult {
  period: LedgerPeriod;
  /** `null` when the period was closed without a closing entry. */
  reversal: LedgerTransaction | null;
}

/**
 * THE period predicate (LGR-12), shared by the store's post/reverse guards and
 * every UI surface that wants to say WHY a date is refused: the `closed` period
 * containing `date`, or `null`. Pure; string comparison is safe because both
 * sides are ISO `YYYY-MM-DD`.
 */
export function closedPeriodContaining(periods: readonly LedgerPeriod[], date: string): LedgerPeriod | null {
  for (const period of periods) {
    if (period.status !== 'closed') continue;
    if (period.start <= date && date <= period.end) return period;
  }
  return null;
}

/**
 * Every CLOSED period overlapping the inclusive range `[from, to]` (`''` means
 * open at that end) — the display-only "this report crosses a closed period"
 * marker the report blocks render. Sorted by start date so the marker reads in
 * calendar order.
 */
export function closedPeriodsOverlapping(periods: readonly LedgerPeriod[], from: string, to: string): LedgerPeriod[] {
  return periods
    .filter((p) => p.status === 'closed' && (to === '' || p.start <= to) && (from === '' || from <= p.end))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : 1));
}

/** The seeded ledger database ids + host page. */
export interface LedgerDatabases {
  accounts: string;
  transactions: string;
  postings: string;
  reconciliations: string;
}

/** `GET /api/ledger` — whether the ledger is initialized, and where it lives. */
export interface LedgerInfo {
  exists: boolean;
  hostPageId: string | null;
  databases: LedgerDatabases | null;
}

// ── Inputs ─────────────────────────────────────────────────────────────────────

export interface LedgerAccountInput {
  name: string;
  type: LedgerAccountType;
  /** ISO-4217-shaped code; defaults to `USD`. */
  currency?: string;
  /** LGR-14: refuse postings from entries with no evidence. Default `false`. */
  evidenceRequired?: boolean;
}

export interface LedgerAccountPatch {
  name?: string;
  /** `closed` is rejected while the account's posted balance is nonzero. */
  status?: LedgerAccountStatus;
  /**
   * LGR-14: turn the evidence requirement on or off. Forward-looking only —
   * flipping it on does not (and cannot) retro-flag entries already posted;
   * the gate runs at post time.
   */
  evidenceRequired?: boolean;
}

export interface LedgerPostingInput {
  accountId: string;
  /** Signed integer minor units. Never a parsed string. */
  amountMinor: number;
  /** Initial cleared state; `reconciled` is not settable here. Default `pending`. */
  cleared?: 'pending' | 'cleared';
  /**
   * Free-text note on this leg (LGR-16). Omitted, `undefined`, `null` and `''`
   * all store as `null`; longer than the `description` cap is rejected with
   * `invalid-input`.
   */
  memo?: string | null;
}

export interface LedgerDraftInput {
  /** ISO date (`YYYY-MM-DD`). */
  date: string;
  description?: string;
  postings?: LedgerPostingInput[];
  /**
   * Evidence to attach at creation (LGR-14). Each named asset must already be
   * in the content-addressed asset store (upload first, attach by hash);
   * `size` is resolved server-side. Duplicate hashes are rejected — the
   * manifest is a set.
   */
  evidence?: LedgerEvidenceInput[];
}

export interface LedgerDraftPatch {
  date?: string;
  description?: string;
  /** When present, REPLACES the draft's postings wholesale. */
  postings?: LedgerPostingInput[];
  /** When present, REPLACES the draft's evidence wholesale (LGR-14) — the
   *  same replacement contract `postings` uses. `[]` detaches everything. */
  evidence?: LedgerEvidenceInput[];
}

export interface LedgerReverseOptions {
  /** ISO date for the reversing entry; defaults to the original's date. */
  date?: string;
  description?: string;
}

// ── Audit log ──────────────────────────────────────────────────────────────────

export type LedgerAuditAction =
  | 'ledger.init'
  | 'ledger.acl'
  | 'account.create'
  | 'account.update'
  | 'transaction.create'
  | 'transaction.update'
  | 'transaction.delete'
  | 'transaction.post'
  | 'transaction.reverse'
  | 'posting.cleared'
  /** A statement reconciliation was opened on an account (LGR-11). */
  | 'reconciliation.start'
  /**
   * A reconciliation reached a zero difference and was FINISHED (LGR-11): its
   * matched postings froze at `reconciled`. ONE event covers the reconciliation
   * row and every posting it froze — the `transaction.reverse` precedent, and
   * for the same reason: they commit together or not at all.
   */
  | 'reconciliation.finish'
  /** A finished reconciliation was explicitly REOPENED, unfreezing its postings. */
  | 'reconciliation.reopen'
  /**
   * An OPEN reconciliation's statement date/balance was CORRECTED (LGR-22).
   * Touches the reconciliation row and nothing else — no posting changes ride
   * along, which is exactly why this is not folded into `.start`: the trail has
   * to show that the target moved, and to what.
   */
  | 'reconciliation.amend'
  /**
   * An OPEN reconciliation was ABANDONED (LGR-22) — given up on rather than
   * balanced. Terminal, and posting-neutral: every tick keeps the cleared state
   * it had, because a tick records that the posting appeared on the bank, which
   * abandoning the match does not un-observe.
   */
  | 'reconciliation.abandon'
  /**
   * A period was CLOSED (LGR-12): the date range locked, and — when the range
   * held income-statement balances — the closing entry posted. ONE event covers
   * the period record and the entry it posted (the `transaction.reverse` /
   * `reconciliation.finish` precedent: they commit together or not at all).
   * The payload's `openReconciliationIds` names what the warn-not-block check
   * surfaced; advisory context, not entity content.
   */
  | 'period.close'
  /**
   * A closed period was explicitly REOPENED (LGR-12): the range unlocked and
   * the closing entry voided via a reversal posted in the SAME event —
   * `transaction`/`originalId` carry the reversal pair exactly as
   * `transaction.reverse` does.
   */
  | 'period.reopen'
  /** The ledger auto-export target was set or cleared (LGR-7). Policy, not
   *  ledger content — it touches no entity, so a replay ignores it, but it is
   *  recorded here so the book itself carries evidence of where copies go. */
  | 'ledger.autoExportPath'
  /**
   * A backup bundle's ledger history was RESTORED into this library (LGR-15).
   * Appended ON TOP of the restored tail — chained from it — naming the actor
   * and the bundle's content hash, so an installed history is always bracketed
   * by an attributable event rather than ending exactly where the bundle ends.
   * Touches no entity (a replay ignores it), but its recorded afterHash is
   * re-derived from its own payload by the verifier, like `autoExportPath`.
   *
   * VERSION NOTE (deliberate): builds that predate this action REFUSE to read
   * streams containing it — the unknown-action rejection in `auditFromRow` is
   * the fail-closed posture, so a restored library is not silently
   * mis-replayed by an old build; restore such a bundle on a current build.
   */
  | 'ledger.restore';

/**
 * Every known audit action — the validation set for a stored `action` value.
 *
 * `as const satisfies` (not a widened annotation) so the array's element type is
 * the literal union: adding a member to {@link LedgerAuditAction} without adding
 * it here is then caught by the exhaustiveness check below at COMPILE time,
 * rather than surfacing at runtime as a log this build refuses to interpret.
 */
export const LEDGER_AUDIT_ACTIONS = [
  'ledger.init',
  'ledger.acl',
  'account.create',
  'account.update',
  'transaction.create',
  'transaction.update',
  'transaction.delete',
  'transaction.post',
  'transaction.reverse',
  'posting.cleared',
  'reconciliation.start',
  'reconciliation.finish',
  'reconciliation.reopen',
  'reconciliation.amend',
  'reconciliation.abandon',
  'period.close',
  'period.reopen',
  'ledger.autoExportPath',
  'ledger.restore',
] as const satisfies readonly LedgerAuditAction[];

/**
 * Compile-time exhaustiveness: every {@link LedgerAuditAction} must appear in
 * {@link LEDGER_AUDIT_ACTIONS}. If a new union member is added without listing
 * it, this assignment fails to typecheck (the union is not assignable to the
 * array's narrower element type).
 */
const _LEDGER_AUDIT_ACTIONS_EXHAUSTIVE: (typeof LEDGER_AUDIT_ACTIONS)[number] = null as unknown as LedgerAuditAction;
void _LEDGER_AUDIT_ACTIONS_EXHAUSTIVE;

/**
 * One append-only audit event. `payload` carries the full after-content of the
 * touched entity (so the stream is REPLAYABLE — see {@link replayLedgerAudit});
 * `beforeHash`/`afterHash` are SHA-256 hex of the canonical entity content
 * before/after the mutation (`null` where there is no before/after state).
 */
export interface LedgerAuditEvent {
  /** Server-assigned, strictly increasing sequence (the pagination cursor). */
  seq: number;
  id: string;
  actorSubject: string;
  actorName: string;
  action: LedgerAuditAction;
  /** The entity ids this event touches (transaction + original for a reverse). */
  entityIds: string[];
  payload: Record<string, unknown>;
  beforeHash: string | null;
  afterHash: string | null;
  /**
   * TAMPER-EVIDENCE (LGR-3): the {@link ledgerAuditEventHash} of the immediately
   * preceding event, written in the SAME transaction as this one — so the log is
   * a hash chain, not merely an append-only table. `null` only for the genesis
   * event. Append-only-by-construction stops the API; the chain additionally
   * makes an UNRECOMPUTED database-level edit or middle deletion detectable, and
   * lets a BIGSERIAL gap be told apart from a rolled-back transaction. It does
   * NOT detect head/tail truncation or a fully recomputed rewrite — see
   * {@link verifyLedgerAuditChain} for the precise guarantee before relying on
   * a green result.
   */
  prevHash: string | null;
  createdAt: string;
}

/** The state a replay of the audit stream reconstructs. */
export interface LedgerReplayState {
  initialized: boolean;
  accounts: Record<string, LedgerAccount>;
  transactions: Record<string, LedgerTransaction>;
  /** Statement reconciliations (LGR-11), keyed by id. */
  reconciliations: Record<string, LedgerReconciliation>;
  /** Closed/reopened periods (LGR-12), keyed by id. */
  periods: Record<string, LedgerPeriod>;
}

/**
 * One posting's cleared state as a `reconciliation.finish` / `.reopen` event
 * records it. The event carries the FULL after-state of every posting it
 * touched, because that is what makes the stream replayable: a reader that only
 * knew "these ids were frozen" could not reconstruct the `reconciliationId` a
 * reopen must clear again.
 */
export interface LedgerReconciliationPostingChange {
  postingId: string;
  transactionId: string;
  cleared: LedgerClearedState;
  reconciliationId: string | null;
}

/**
 * Pure reducer: fold the audit event stream (ascending `seq`) into the expected
 * current ledger state. Deterministic and side-effect free — the replay test
 * compares this against the live store to prove the audit log is a complete
 * record of every ledger mutation.
 */
export function replayLedgerAudit(events: Iterable<LedgerAuditEvent>): LedgerReplayState {
  const state: LedgerReplayState = {initialized: false, accounts: {}, transactions: {}, reconciliations: {}, periods: {}};
  /** Apply one recorded posting change to the replayed transaction holding it. */
  const applyPostingChange = (change: LedgerReconciliationPostingChange): void => {
    const tx = state.transactions[change.transactionId];
    if (!tx) return;
    state.transactions[change.transactionId] = {
      ...tx,
      postings: tx.postings.map((p) =>
        p.id === change.postingId ? {...p, cleared: change.cleared, reconciliationId: change.reconciliationId} : p,
      ),
    };
  };
  for (const ev of events) {
    // An action this reducer does not know about means the log records a
    // mutation the replay cannot account for — so the reconstruction would be
    // silently INCOMPLETE (state drifting from the books with no signal). That
    // is exactly the failure a replayable audit log exists to rule out, so it is
    // a hard error, not a skipped iteration. Any new action MUST land here.
    const p = ev.payload as {
      account?: LedgerAccount;
      transaction?: LedgerTransaction;
      transactionId?: string;
      originalId?: string;
      originalState?: LedgerTransactionState;
      postingId?: string;
      cleared?: LedgerClearedState;
      reconciliation?: LedgerReconciliation;
      postings?: LedgerReconciliationPostingChange[];
      period?: LedgerPeriod;
    };
    switch (ev.action) {
    case 'ledger.init':
      state.initialized = true;
      break;
    case 'ledger.acl':
      // A sharing grant/revoke on a ledger page: recorded for the trail, but it
      // carries no ledger CONTENT, so replayed state is unchanged.
      break;
    case 'ledger.autoExportPath':
      // An instance-policy change (where the canonical export is written):
      // recorded for the trail, but it touches no ledger entity, so replayed
      // state is unchanged. Explicit rather than falling through to `default`,
      // which must keep throwing on actions this build genuinely cannot model.
      break;
    case 'ledger.restore':
      // A bundle's history was installed (LGR-15): provenance for the trail —
      // the restored entity events precede this one and already carry all the
      // content, so replayed state is unchanged. Explicit for the same reason
      // as `autoExportPath` above.
      break;
    case 'account.create':
    case 'account.update':
      if (p.account) state.accounts[p.account.id] = p.account;
      break;
    case 'transaction.create':
    case 'transaction.update':
    case 'transaction.post':
      if (p.transaction) state.transactions[p.transaction.id] = p.transaction;
      break;
    case 'transaction.delete':
      if (p.transactionId) delete state.transactions[p.transactionId];
      break;
    case 'transaction.reverse':
      if (p.transaction) state.transactions[p.transaction.id] = p.transaction;
      if (p.originalId && state.transactions[p.originalId]) {
        state.transactions[p.originalId] = {
          ...state.transactions[p.originalId],
          state: p.originalState ?? 'void',
        };
      }
      break;
    case 'posting.cleared':
      if (p.transactionId && p.postingId && p.cleared && state.transactions[p.transactionId]) {
        const tx = state.transactions[p.transactionId];
        state.transactions[p.transactionId] = {
          ...tx,
          postings: tx.postings.map((post) => (post.id === p.postingId ? {...post, cleared: p.cleared as LedgerClearedState} : post)),
        };
      }
      break;
    case 'reconciliation.start':
    case 'reconciliation.amend':
    case 'reconciliation.abandon':
      // ROW-ONLY events. Neither an amend nor an abandon touches a posting —
      // that is the LGR-22 guarantee, stated here as well as enforced in the
      // store — so unlike finish/reopen below there is no posting change to
      // apply, and a payload that carried one would be a bug in the writer.
      if (p.reconciliation) state.reconciliations[p.reconciliation.id] = p.reconciliation;
      break;
    case 'reconciliation.finish':
    case 'reconciliation.reopen':
      // ONE event, TWO effects: the reconciliation's new status, and the
      // cleared/reconciliationId state of every posting it froze or unfroze.
      // Both must land, or the replayed postings drift from the book and the
      // verifier's content-hash comparison reports a clean ledger as tampered.
      if (p.reconciliation) state.reconciliations[p.reconciliation.id] = p.reconciliation;
      for (const change of p.postings ?? []) applyPostingChange(change);
      break;
    case 'period.close':
      // ONE event, TWO effects (LGR-12): the period record, and the closing
      // entry it posted (absent when the range held nothing to close).
      if (p.period) state.periods[p.period.id] = p.period;
      if (p.transaction) state.transactions[p.transaction.id] = p.transaction;
      break;
    case 'period.reopen':
      // The reversal pair rides in the same shape `transaction.reverse` uses:
      // the reversal lands, and the original closing entry flips to void.
      if (p.period) state.periods[p.period.id] = p.period;
      if (p.transaction) state.transactions[p.transaction.id] = p.transaction;
      if (p.originalId && state.transactions[p.originalId]) {
        state.transactions[p.originalId] = {
          ...state.transactions[p.originalId],
          state: p.originalState ?? 'void',
        };
      }
      break;
    default:
      throw new LedgerError(
        'invalid-state',
        `replayLedgerAudit: unknown audit action ${JSON.stringify((ev as LedgerAuditEvent).action)} — the replay cannot reconstruct state it does not model`,
      );
    }
  }
  return state;
}

/**
 * The DERIVED content a `ledger.restore` provenance event's `afterHash` covers
 * — ONE shape shared by every writer of the event and by the verifier's
 * re-derivation, so the two can never disagree (LGR-15 S6; extended by LX-4).
 *
 * Reconstructed field by field, never `payload` verbatim: a forged or retyped
 * field changes the derived digest and is caught rather than absorbed. The
 * LX-4 fields are CONDITIONAL (present only when the payload carries them), so
 * an LGR-15 bundle-restore event — whose payload has only the first three —
 * derives to exactly the digest its writer recorded.
 *
 *  - `bundleSha`: content hash of what was restored (the backup bundle, or the
 *    canonical JSON of an export's ledger section);
 *  - `auditEvents`: events installed (bundle restore) or freshly minted by the
 *    replay (section restore);
 *  - `assets`: evidence assets installed (always 0 for a section restore — an
 *    HTML export carries no evidence bytes);
 *  - `source` (LX-4): `'export-section'` on a section replay;
 *  - `sourceAuditHeadSeq`/`sourceAuditHeadHash` (LX-4): the exported book's
 *    audit-chain anchor, carried so the provenance names WHICH chain head the
 *    source book was at when it was exported;
 *  - `evidenceDropped`/`reconciliationsDowngraded` (LX-4): the replay's honest
 *    degradation counters;
 *  - `failed`/`replayedEntries`/`totalEntries` (LX-4): the PARTIAL-restore
 *    marker — a section replay that aborted midway appends this event
 *    best-effort so the book itself carries the evidence that it holds an
 *    incomplete import (see `LedgerStore.restoreExportSection`).
 */
export function ledgerRestorePayloadContent(p: Record<string, unknown>): Record<string, unknown> {
  return {
    bundleSha: typeof p.bundleSha === 'string' ? p.bundleSha : null,
    auditEvents: typeof p.auditEvents === 'number' ? p.auditEvents : 0,
    assets: typeof p.assets === 'number' ? p.assets : 0,
    ...(typeof p.source === 'string' ? {source: p.source} : {}),
    ...(typeof p.sourceAuditHeadSeq === 'number' ? {sourceAuditHeadSeq: p.sourceAuditHeadSeq} : {}),
    ...(typeof p.sourceAuditHeadHash === 'string' ? {sourceAuditHeadHash: p.sourceAuditHeadHash} : {}),
    ...(typeof p.evidenceDropped === 'number' ? {evidenceDropped: p.evidenceDropped} : {}),
    ...(typeof p.reconciliationsDowngraded === 'number' ? {reconciliationsDowngraded: p.reconciliationsDowngraded} : {}),
    ...(typeof p.failed === 'boolean' ? {failed: p.failed} : {}),
    ...(typeof p.replayedEntries === 'number' ? {replayedEntries: p.replayedEntries} : {}),
    ...(typeof p.totalEntries === 'number' ? {totalEntries: p.totalEntries} : {}),
  };
}

/**
 * The tamper-evidence hash of ONE audit event: SHA-256 over its canonical
 * content INCLUDING `prevHash`, which is what links each event to its
 * predecessor. Async because it uses WebCrypto (isomorphic: Node, browser,
 * sidecar). `seq` is deliberately part of the hashed content, so renumbering
 * events breaks the chain just as rewriting one does.
 */
export async function ledgerAuditEventHash(event: LedgerAuditEvent): Promise<string> {
  const canonical = canonicalLedgerJson({
    seq: event.seq,
    id: event.id,
    actorSubject: event.actorSubject,
    actorName: event.actorName,
    action: event.action,
    entityIds: event.entityIds,
    payload: event.payload,
    beforeHash: event.beforeHash,
    afterHash: event.afterHash,
    prevHash: event.prevHash,
    createdAt: event.createdAt,
  });
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The verdict of {@link verifyLedgerAuditChain}. */
export interface LedgerAuditChainResult {
  ok: boolean;
  /** How many events were checked. */
  checked: number;
  /** The `seq` of the first event whose link is broken, when `ok` is false. */
  brokenAtSeq: number | null;
  reason: string | null;
}

/**
 * Verify the audit log's hash chain over `events` (ASCENDING `seq`, contiguous
 * from the genesis event). Each event must carry its predecessor's
 * {@link ledgerAuditEventHash} in `prevHash`; the first must carry `null`.
 *
 * THE PRECISE GUARANTEE — a green result is NOT "this log is authentic":
 *
 *  - DETECTED: any edit, reordering, or middle deletion whose perpetrator does
 *    not also recompute every following link. That covers the realistic
 *    accident-and-opportunist cases (a stray `UPDATE`, a row deleted to hide one
 *    entry), and it distinguishes a deleted event from the innocuous BIGSERIAL
 *    gap a rolled-back transaction leaves.
 *  - NOT DETECTED: truncation of the HEAD or the TAIL — a prefix or suffix of
 *    the log removed wholesale still verifies clean, because nothing in the data
 *    states where the chain is supposed to start or end. Nor a WHOLESALE REWRITE:
 *    this hash is unkeyed and this function is exported, so an actor with
 *    database access can rewrite every event and recompute every link.
 *
 * Detecting those requires an off-box ANCHOR — periodically publishing the tail
 * hash somewhere the database's owner cannot rewrite — which is tracked
 * separately (LGR-18) and is not implemented here. Treat this as integrity
 * against tampering that does not control the whole log, not as a signature.
 *
 * Verifying a PAGE of the log (not starting at genesis) is supported: pass the
 * slice and it checks the links WITHIN it, reporting the first break.
 */
export async function verifyLedgerAuditChain(events: readonly LedgerAuditEvent[]): Promise<LedgerAuditChainResult> {
  let expectedPrev: string | null | undefined = undefined; // undefined = first seen
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (i > 0 && event.seq <= events[i - 1].seq) {
      return {ok: false, checked: i, brokenAtSeq: event.seq, reason: 'events are not in ascending seq order'};
    }
    if (expectedPrev !== undefined && event.prevHash !== expectedPrev) {
      return {
        ok: false,
        checked: i,
        brokenAtSeq: event.seq,
        reason: `prevHash mismatch: expected ${String(expectedPrev)}, got ${String(event.prevHash)} — an event was rewritten, reordered, or removed`,
      };
    }
    expectedPrev = await ledgerAuditEventHash(event);
  }
  return {ok: true, checked: events.length, brokenAtSeq: null, reason: null};
}

/**
 * Canonical JSON of an entity for audit content-hashing: keys sorted at every
 * depth, so a byte-identical serialization is independent of insertion order.
 */
export function canonicalLedgerJson(value: unknown): string {
  const sortValue = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortValue);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        out[key] = sortValue((v as Record<string, unknown>)[key]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sortValue(value));
}

/**
 * Validate a hierarchical, colon-delimited account name (`Assets:Bank:Checking`):
 * one or more non-empty, non-whitespace-only segments separated by single colons.
 */
export function isValidLedgerAccountName(name: unknown): name is string {
  if (typeof name !== 'string' || name.trim() === '') return false;
  return name.split(':').every((seg) => seg.trim().length > 0);
}

/** Validate an ISO `YYYY-MM-DD` date string (a real calendar date). */
export function isValidLedgerDate(date: unknown): date is string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

// ── Independent verifier report (LGR-7; the wire contract since LGR-13) ────────
// The verifier ITSELF lives server-side (`packages/server/src/ledgerVerify.ts` —
// it re-checks raw storage with its own SQL), but its REPORT is a wire type:
// `GET /api/ledger/verify` returns it, `DataClient.ledgerVerify()` types it
// over both transports, and the ledger plugin's Export & verify action renders
// it. One home for the shape, here with the rest of the ledger contract.

/** Finding categories the independent verifier can report. */
export type LedgerVerifyCode =
  | 'unbalanced'
  | 'too-few-postings'
  | 'invalid-amount'
  | 'audit-chain-broken'
  | 'audit-hash-forged'
  | 'posted-hash-mismatch'
  | 'orphan-posting'
  | 'unknown-account'
  | 'replay-divergence'
  | 'entry-no-gap'
  | 'entry-no-duplicate'
  | 'entry-no-missing'
  /** A `period.close`/`period.reopen` payload posting is not `pending`/unowned
   *  (LGR-12) — the writer always emits closing and reversal legs born
   *  `cleared: 'pending'`, `reconciliationId: null`, so a frozen payload saying
   *  otherwise was rewritten. This is what covers the workflow fields the
   *  period hash chain deliberately excludes. */
  | 'closing-posting-forged'
  /** An evidence manifest item on a posted/void entry is not `{filename,
   *  sha256, size}`-shaped (LGR-14) — the writer validates the shape at attach
   *  AND at post, so a malformed stored item was written out-of-band. The
   *  structural checks below cannot run on it, which is why it is a finding
   *  and not a skip. */
  | 'evidence-manifest-invalid'
  /** A posted/void entry's manifest names an asset the content-addressed store
   *  no longer holds (LGR-14). The manifest itself GC-protects its assets (the
   *  hash in the row's `properties` is what the GC's document scan keeps, and
   *  the tx-row `asset_refs` edge backs it up), and no API deletes asset rows —
   *  so a missing asset means the store was mutated underneath the ledger,
   *  never that the evidence "never existed": `post` re-resolves every item
   *  against the store inside the posting transaction. */
  | 'evidence-asset-missing'
  /** The stored bytes no longer hash to the manifest's SHA-256 (LGR-14) — a
   *  receipt was REPLACED in place by direct surgery on the `assets` row.
   *  Unreachable through any API (the id is derived from the bytes at upload;
   *  nothing updates `bytes`), so this re-hash is the only detector — with the
   *  row and every ledger hash untouched, no other check even looks. */
  | 'evidence-asset-replaced'
  /** The stored byte count differs from the manifest's `size` (LGR-14) while
   *  the hash still matches — the store's metadata was doctored (`size` is a
   *  cached column), or the manifest's size was rewritten in step with the row.
   *  Either way the manifest and the store disagree about the same bytes. */
  | 'evidence-size-mismatch'
  /**
   * CURRENT-POLICY ADVISORY, not a tamper finding (LGR-14 F2): a posted/void
   * entry has an EMPTY manifest while an account one of its legs touches
   * CURRENTLY has `evidenceRequired`. This is what makes the toggle
   * verifier-observable — without it, SQL-off the flag, post bare through the
   * ordinary API, SQL it back on, and the book verified clean with
   * `checkedEvidence: 0`: the feature's one traceless bypass.
   *
   * Read it as "the book does not satisfy TODAY'S policy", never "someone
   * tampered": turning the flag on flags history — every bare entry posted
   * before the requirement existed — and that is BY DESIGN (the operator asked
   * "which posted entries can't answer for themselves under the current
   * rules?", and pre-toggle history is exactly part of the answer). Its
   * messages carry the `policy advisory` prefix so a report reader (and any
   * alerting built on findings) can band it separately from the tamper codes.
   *
   * Carve-outs: reversals (`reverses !== null`) and closing entries — the
   * post-time gate exempts both, so their bareness is never a policy breach.
   * Since F1 a reversal CARRIES its original's manifest, so this carve-out in
   * practice only shields reversals of bare legacy originals — and there the
   * policy claim belongs to the ORIGINAL entry, which this same check flags
   * (void entries are in scope precisely so a reversed bare entry stays
   * visible).
   */
  | 'evidence-required-missing'
  /**
   * The LINEAR audit hash chain (`prev_hash`, migration 0021) fails to verify
   * (LGR-15): some event's `prev_hash` is not the hash of its predecessor, or
   * the genesis link is wrong. Distinct from `audit-chain-broken` (the
   * per-entity before/after linkage): this is the whole-log tamper-evidence
   * chain — an edited, reordered, or middle-deleted event whose perpetrator
   * did not recompute every following link. Previously `verifyAuditChain`
   * existed but had NO production caller; folding it into this report is what
   * makes the documented check actually run at the route, the CLI, and the
   * restore door.
   */
  | 'audit-prev-hash-broken';

/**
 * The ADVISORY band of the finding-code union (LGR-14 Q3): codes that report
 * "the book does not satisfy today's POLICY", never "storage was tampered
 * with". Every other code is the tamper band. Keyed off the code union — not
 * message text — because exit policies and alerting hang off this distinction:
 * `--verify-ledger` exits 0 on an advisory-only report (still printed), so a
 * healthy book that enables evidence-required over bare history does not turn
 * every backup-verification script permanently red and teach operators to
 * ignore the one alarm that matters. Any future advisory code MUST land here.
 */
export const LEDGER_VERIFY_ADVISORY_CODES = ['evidence-required-missing'] as const satisfies readonly LedgerVerifyCode[];

/** Whether `code` is an advisory (current-policy) finding, not a tamper one. */
export function isLedgerVerifyAdvisory(code: LedgerVerifyCode): boolean {
  return (LEDGER_VERIFY_ADVISORY_CODES as readonly string[]).includes(code);
}

/** One invariant violation the verifier found against raw storage. */
export interface LedgerVerifyFinding {
  code: LedgerVerifyCode;
  /** Human-readable, entity-id-bearing description of the violation. */
  message: string;
  /** The primary entity (transaction / posting / account / audit seq) at fault. */
  entityId?: string;
}

/** The verifier's report: what was checked, and every finding (empty = clean). */
export interface LedgerVerifyReport {
  /** False when the ledger has never been seeded — trivially clean. */
  initialized: boolean;
  checkedTransactions: number;
  checkedPostings: number;
  checkedAccounts: number;
  checkedAuditEvents: number;
  /** Period records checked against the audit stream (LGR-12). */
  checkedPeriods: number;
  /** Evidence manifest items re-checked against the asset store (LGR-14). */
  checkedEvidence: number;
  /** Reconciliation records checked against the audit stream (LGR-15). */
  checkedReconciliations: number;
  /**
   * The linear `prev_hash` chain verdict (LGR-15) — `verifyLedgerAuditChain`
   * over the full stream. Additive and absent on an uninitialized ledger. A
   * broken chain also lands in `findings` as `audit-prev-hash-broken`, so
   * severity-aware consumers (the CLI exit code) need no special casing.
   */
  auditChain?: LedgerAuditChainResult;
  /** Empty = every invariant holds against raw storage. */
  findings: LedgerVerifyFinding[];
}
