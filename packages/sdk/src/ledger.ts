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
  case 'invalid-state':
  case 'nonzero-balance':
  case 'reconciliation-exists':
  case 'reconciliation-unbalanced':
  case 'posting-not-reconcilable':
  case 'reconciliation-too-large':
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
  account: {type: 'lp_type', status: 'lp_status', currency: 'lp_currency'},
  transaction: {
    date: 'lp_date',
    description: 'lp_description',
    state: 'lp_state',
    postedAt: 'lp_posted_at',
    postedBy: 'lp_posted_by',
    reverses: 'lp_reverses',
    evidence: 'lp_evidence',
    entryNo: 'lp_entry_no',
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

/** One piece of evidence attached to a posted transaction (LGR-14 fills these;
 *  v1 always records an empty list at post time). */
export interface LedgerEvidence {
  filename: string;
  sha256: string;
  size: number;
}

/** A ledger account. `name` is hierarchical, colon-delimited (`Assets:Bank:Checking`). */
export interface LedgerAccount {
  id: string;
  name: string;
  type: LedgerAccountType;
  status: LedgerAccountStatus;
  /** ISO-4217-shaped currency code. Defaults to `USD`. */
  currency: string;
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
  /** Evidence recorded at post time (empty in v1; LGR-14 fills it). */
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
}

export interface LedgerAccountPatch {
  name?: string;
  /** `closed` is rejected while the account's posted balance is nonzero. */
  status?: LedgerAccountStatus;
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
}

export interface LedgerDraftPatch {
  date?: string;
  description?: string;
  /** When present, REPLACES the draft's postings wholesale. */
  postings?: LedgerPostingInput[];
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
  /** The ledger auto-export target was set or cleared (LGR-7). Policy, not
   *  ledger content — it touches no entity, so a replay ignores it, but it is
   *  recorded here so the book itself carries evidence of where copies go. */
  | 'ledger.autoExportPath';

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
  'ledger.autoExportPath',
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
  const state: LedgerReplayState = {initialized: false, accounts: {}, transactions: {}, reconciliations: {}};
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
