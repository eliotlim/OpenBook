/**
 * Independent ledger invariant verifier (LGR-7) — the backstop behind the
 * backstop.
 *
 * `LedgerStore` ENFORCES the invariants at write time; this module RE-CHECKS
 * them against RAW storage with its own SQL reads — deliberately NOT through
 * `LedgerStore`'s query/validator paths, so a bug (or an out-of-band mutation:
 * SQL surgery, a bad migration, disk corruption) that slips past enforcement
 * still gets caught. The only things shared with the enforcement path are the
 * CONTRACT artifacts: the stable `LEDGER_PROP` ids, the canonical-JSON hasher,
 * and the pure `replayLedgerAudit` reducer.
 *
 * Checks (each failure is one typed finding; an empty list = clean):
 *  a. balance          — every posted/void transaction has ≥2 postings summing
 *                        to exactly 0 minor units (`unbalanced`,
 *                        `too-few-postings`, `invalid-amount`);
 *  b. audit hash chain — each audit event's recorded `afterHash` is RE-DERIVED
 *                        from that event's own payload (`audit-hash-forged` —
 *                        what makes the chain load-bearing rather than
 *                        decorative: consistent surgery across rows AND
 *                        payloads is still caught), each event's beforeHash
 *                        chains from the previous afterHash for the same entity
 *                        (`audit-chain-broken`), and each posted/void row's
 *                        CURRENT content hash equals the hash of the state the
 *                        audit stream predicts (`posted-hash-mismatch` — the
 *                        out-of-band-mutation detector);
 *  c. referential      — every posting resolves to a live transaction and a
 *                        live account (`orphan-posting`, `unknown-account`);
 *  d. audit replay     — `replayLedgerAudit` over the full stream equals the
 *                        raw current state, entity for entity
 *                        (`replay-divergence`);
 *  e. entry numbers    — posted/void entry numbers are exactly the dense set
 *                        1..N with no gaps or duplicates (`entry-no-gap`,
 *                        `entry-no-duplicate`, `entry-no-missing`);
 *  f. evidence         — every posted/void entry's evidence manifest (LGR-14)
 *                        resolves against the content-addressed asset store:
 *                        each item well-formed (`evidence-manifest-invalid`),
 *                        its asset present (`evidence-asset-missing`), the
 *                        stored BYTES re-hashed to the recorded SHA-256
 *                        (`evidence-asset-replaced` — the receipt-swap
 *                        detector; the asset id IS the hash, so a replacement
 *                        can only exist as a row whose bytes no longer match
 *                        their id), and the byte count equal to the manifest's
 *                        (`evidence-size-mismatch`); plus the CURRENT-POLICY
 *                        advisory (`evidence-required-missing`) — a bare
 *                        posted/void entry touching an account that currently
 *                        requires evidence.
 *
 * Browser-safe: no Node imports (store.ts exposes it to both runtimes).
 */

import {
  LEDGER_PROP,
  canonicalLedgerJson,
  replayLedgerAudit,
  type LedgerAccount,
  type LedgerAuditEvent,
  type LedgerPeriod,
  type LedgerPosting,
  type LedgerReconciliation,
  type LedgerReconciliationPostingChange,
  type LedgerTransaction,
} from '@book.dev/sdk';
import type {Db} from './dbCore';

// ── Findings ──────────────────────────────────────────────────────────────────

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
   *  period hash chain deliberately excludes (see `closingEntryContent`). */
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
  | 'evidence-required-missing';

export interface LedgerVerifyFinding {
  code: LedgerVerifyCode;
  /** Human-readable, entity-id-bearing description of the violation. */
  message: string;
  /** The primary entity (transaction / posting / account / audit seq) at fault. */
  entityId?: string;
}

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
  /** Empty = every invariant holds against raw storage. */
  findings: LedgerVerifyFinding[];
}

// ── Raw-row plumbing (independent of LedgerStore's readers) ───────────────────

interface RawRow {
  id: string;
  name: string | null;
  properties: Record<string, unknown> | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RawAuditRow {
  seq: number | string;
  id: string;
  actor_subject: string;
  actor_name: string;
  action: string;
  entity_ids: unknown;
  payload: unknown;
  before_hash: string | null;
  after_hash: string | null;
  prev_hash: string | null;
  created_at: Date | string;
}

interface RawLedgerIds {
  hostPageId?: string;
  accounts?: string;
  transactions?: string;
  postings?: string;
  reconciliations?: string;
}

const toIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const parseJson = <T>(value: T | string | null | undefined, fallback: T): T => {
  if (value == null) return fallback;
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
};

const str = (raw: unknown): string => (typeof raw === 'string' ? raw : '');
const strOrNull = (raw: unknown): string | null => (typeof raw === 'string' && raw.length > 0 ? raw : null);

/** SHA-256 hex (isomorphic — same digest the audit writer records). */
async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const ROW_COLS = 'id, name, properties, created_at, updated_at';

/**
 * True only for Postgres's "relation does not exist" (SQLSTATE `42P01`) naming
 * `relation` — i.e. a never-migrated library. Deliberately narrow: every other
 * query failure must propagate rather than masquerade as "no ledger".
 */
function isMissingRelation(err: unknown, relation: string): boolean {
  const code = (err as {code?: unknown} | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  // `relation` is interpolated into a pattern — escape it so a name containing
  // regex metacharacters can never widen (or break) the match.
  const escaped = relation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = new RegExp(`relation .*${escaped}.* does not exist`, 'i').test(message);
  return (code === '42P01' && named) || (code === undefined && named);
}

function accountFromRaw(row: RawRow): LedgerAccount {
  const props = parseJson<Record<string, unknown>>(row.properties, {});
  return {
    id: row.id,
    name: row.name ?? '',
    type: (str(props[LEDGER_PROP.account.type]) || 'asset') as LedgerAccount['type'],
    status: (str(props[LEDGER_PROP.account.status]) || 'open') as LedgerAccount['status'],
    currency: str(props[LEDGER_PROP.account.currency]) || 'USD',
    // LGR-14. Raw rows written before LGR-14 (and every toggled-off account —
    // the writer stores "off" as the ABSENT key) project to `false` here
    // exactly as on the store's read path.
    evidenceRequired: props[LEDGER_PROP.account.evidenceRequired] === true,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function postingFromRaw(row: RawRow): LedgerPosting {
  const props = parseJson<Record<string, unknown>>(row.properties, {});
  const amount = props[LEDGER_PROP.posting.amount];
  return {
    id: row.id,
    transactionId: str(props[LEDGER_PROP.posting.transaction]),
    accountId: str(props[LEDGER_PROP.posting.account]),
    amountMinor: typeof amount === 'number' ? amount : Number(amount ?? 0),
    cleared: (str(props[LEDGER_PROP.posting.cleared]) || 'pending') as LedgerPosting['cleared'],
    reconciliationId: strOrNull(props[LEDGER_PROP.posting.reconciliation]),
    // LGR-16. The verifier reads RAW rows on purpose, so a pre-LGR-16 posting
    // (no memo key at all) projects to `null` here exactly as it does on the
    // store's read path — the two projections must not disagree.
    memo: strOrNull(props[LEDGER_PROP.posting.memo]),
  };
}

function reconciliationFromRaw(row: RawRow): LedgerReconciliation {
  const props = parseJson<Record<string, unknown>>(row.properties, {});
  const balance = props[LEDGER_PROP.reconciliation.statementBalance];
  return {
    id: row.id,
    accountId: str(props[LEDGER_PROP.reconciliation.account]),
    statementDate: str(props[LEDGER_PROP.reconciliation.statementDate]),
    statementBalanceMinor: typeof balance === 'number' ? balance : Number(balance ?? 0),
    status: (str(props[LEDGER_PROP.reconciliation.status]) || 'open') as LedgerReconciliation['status'],
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function transactionFromRaw(row: RawRow, postings: LedgerPosting[]): LedgerTransaction {
  const props = parseJson<Record<string, unknown>>(row.properties, {});
  const entryNo = props[LEDGER_PROP.transaction.entryNo];
  const evidence = props[LEDGER_PROP.transaction.evidence];
  return {
    id: row.id,
    date: str(props[LEDGER_PROP.transaction.date]),
    description: str(props[LEDGER_PROP.transaction.description]),
    state: (str(props[LEDGER_PROP.transaction.state]) || 'draft') as LedgerTransaction['state'],
    postedAt: strOrNull(props[LEDGER_PROP.transaction.postedAt]),
    postedBy: strOrNull(props[LEDGER_PROP.transaction.postedBy]),
    reverses: strOrNull(props[LEDGER_PROP.transaction.reverses]),
    entryNo: typeof entryNo === 'number' && Number.isFinite(entryNo) ? entryNo : null,
    // LGR-12: raw rows written before periods existed have no kind key at all —
    // they project to `null` here exactly as on the store's read path.
    kind: props[LEDGER_PROP.transaction.kind] === 'closing' ? 'closing' : null,
    evidence: Array.isArray(evidence) ? (evidence as LedgerTransaction['evidence']) : [],
    postings,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * The audited CONTENT of an account — must mirror the writer's hashable shape
 * (`ledger.ts`'s `accountContent`), key for key.
 *
 * `evidenceRequired` OMITTED while false (LGR-14) — the same additive-field
 * discipline as the transaction projection's memo/kind: a frozen pre-LGR-14
 * `account.create`/`.update` payload has no such key, so emitting
 * `evidenceRequired: false` here would flag every pre-LGR-14 account on a
 * healthy book as diverged.
 *
 * Exported ONLY so the structural-parity test can compare the two projections
 * key for key; nothing in the product calls it from outside this module.
 */
export function accountContent(a: LedgerAccount): Record<string, unknown> {
  const content: Record<string, unknown> = {id: a.id, name: a.name, type: a.type, status: a.status, currency: a.currency};
  if (a.evidenceRequired) content.evidenceRequired = true;
  return content;
}

/**
 * The audited CONTENT of a transaction + postings (timestamps excluded).
 *
 * This projection MUST mirror `ledger.ts`'s `transactionContent` field for
 * field: it is the independent recomputation of the very hash the writer
 * stored, so a field present on one side and absent on the other makes every
 * entry in a healthy book report as tampered-with.
 *
 * And note the THIRD consumer, which is what makes the `memo != null` omission
 * load-bearing rather than cosmetic: `replayLedgerAudit` returns FROZEN audit
 * payloads verbatim, and a payload written before LGR-16 has no `memo` key at
 * all. Emitting `memo: null` here (canonical JSON keeps nulls) would make every
 * pre-LGR-16 posted entry flag `posted-hash-mismatch` and every pre-LGR-16
 * draft flag `replay-divergence` — the out-of-band-mutation detector crying
 * wolf on a clean book. Every future additive field on this projection owes the
 * same discipline, on BOTH sides.
 *
 * Exported ONLY so the structural-parity test can compare the two projections
 * key for key; nothing in the product calls it from outside this module.
 */
export function transactionContent(t: LedgerTransaction): Record<string, unknown> {
  const content: Record<string, unknown> = {
    id: t.id,
    date: t.date,
    description: t.description,
    state: t.state,
    postedAt: t.postedAt,
    postedBy: t.postedBy,
    reverses: t.reverses,
    entryNo: t.entryNo,
    evidence: t.evidence,
    postings: t.postings.map((p) => {
      const o: Record<string, unknown> = {
        id: p.id,
        accountId: p.accountId,
        amountMinor: p.amountMinor,
        cleared: p.cleared,
        reconciliationId: p.reconciliationId,
      };
      if (p.memo != null) o.memo = p.memo;
      return o;
    }),
  };
  // LGR-12, the same additive-field discipline as the memo: omitted while null
  // so pre-LGR-12 frozen payloads hash identically to post-LGR-12 rows.
  if (t.kind != null) content.kind = t.kind;
  return content;
}

/**
 * The audited CONTENT of a period (LGR-12) — the independent mirror of
 * `ledger.ts`'s `periodContent`. `reopenEntryId` omitted while null (additive
 * discipline: the close-time hash has no key for it).
 */
export function periodContent(p: LedgerPeriod): Record<string, unknown> {
  const content: Record<string, unknown> = {
    id: p.id,
    start: p.start,
    end: p.end,
    status: p.status,
    closingEntryId: p.closingEntryId,
  };
  if (p.reopenEntryId != null) content.reopenEntryId = p.reopenEntryId;
  return content;
}

/**
 * A transaction's FINANCIAL content for the period hash chain — the mirror of
 * `ledger.ts`'s `closingEntryContent`: everything but each posting's `cleared`
 * / `reconciliationId`, which stay mutable on a posted entry (a legitimate tick
 * on a closing-entry leg must not read as tampering). The excluded fields are
 * covered instead by the born-pristine payload assertion in the event loop
 * below (`closing-posting-forged`) — see the writer-side docstring for why the
 * replay comparison alone cannot catch consistent surgery on them.
 */
export function closingEntryContent(t: LedgerTransaction): Record<string, unknown> {
  const content = transactionContent(t);
  content.postings = t.postings.map((p) => {
    const o: Record<string, unknown> = {id: p.id, accountId: p.accountId, amountMinor: p.amountMinor};
    if (p.memo != null) o.memo = p.memo;
    return o;
  });
  return content;
}

/** The combined shape a `period.close` afterHash covers — mirror of `ledger.ts`. */
export function periodCloseContent(period: LedgerPeriod, closingEntry: LedgerTransaction | null): Record<string, unknown> {
  return {period: periodContent(period), closingEntry: closingEntry ? closingEntryContent(closingEntry) : null};
}

/** The combined shape a `period.reopen` afterHash covers — mirror of `ledger.ts`. */
export function periodReopenContent(period: LedgerPeriod, reversal: LedgerTransaction | null): Record<string, unknown> {
  return {period: periodContent(period), reversal: reversal ? closingEntryContent(reversal) : null};
}

/**
 * The audited CONTENT of a reconciliation (LGR-11) — the independent mirror of
 * `ledger.ts`'s `reconciliationContent`. Same discipline as the transaction
 * projection above: a field present on one side only turns every clean
 * reconciliation into an `audit-hash-forged` finding.
 *
 * Exported ONLY so the structural-parity test can compare the two key for key.
 */
export function reconciliationContent(r: LedgerReconciliation): Record<string, unknown> {
  return {
    id: r.id,
    accountId: r.accountId,
    statementDate: r.statementDate,
    statementBalanceMinor: r.statementBalanceMinor,
    status: r.status,
  };
}

function auditFromRaw(row: RawAuditRow): LedgerAuditEvent {
  return {
    seq: Number(row.seq),
    id: row.id,
    actorSubject: row.actor_subject,
    actorName: row.actor_name,
    action: row.action as LedgerAuditEvent['action'],
    entityIds: parseJson<string[]>(row.entity_ids as string[] | string | null, []),
    payload: parseJson<Record<string, unknown>>(row.payload as Record<string, unknown> | string | null, {}),
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    prevHash: row.prev_hash,
    createdAt: toIso(row.created_at),
  };
}

// ── The verifier ──────────────────────────────────────────────────────────────

/**
 * Re-check every ledger invariant against raw storage. Read-only — performs
 * no writes of any kind. Returns a typed report; `findings: []` means clean.
 */
export async function verifyLedger(db: Db): Promise<LedgerVerifyReport> {
  const findings: LedgerVerifyFinding[] = [];
  const flag = (code: LedgerVerifyCode, message: string, entityId?: string): void => {
    findings.push(entityId === undefined ? {code, message} : {code, message, entityId});
  };

  // Raw settings read — not store.ledgerIds() (independence). A never-migrated
  // library has no `settings` table at all (the CLI can be pointed at a fresh or
  // foreign data dir): that is "no ledger here", not a crash — the verifier is
  // read-only and must never migrate a library just to inspect it.
  let idsRows: Array<{value: RawLedgerIds | string}> = [];
  try {
    idsRows = await db.query<{value: RawLedgerIds | string}>(
      'SELECT value FROM settings WHERE key = \'ledgerDb\'',
    );
  } catch (err) {
    // ONLY "there is no settings table" means "no ledger here". Any other
    // failure (permissions, a broken connection, disk errors) must PROPAGATE:
    // reporting a clean book because the read failed is the one answer a
    // verifier must never give.
    if (!isMissingRelation(err, 'settings')) throw err;
    return {initialized: false, checkedTransactions: 0, checkedPostings: 0, checkedAccounts: 0, checkedAuditEvents: 0, checkedPeriods: 0, checkedEvidence: 0, findings};
  }
  const ids = idsRows.length > 0 ? parseJson<RawLedgerIds>(idsRows[0].value, {}) : null;
  if (!ids || !ids.accounts || !ids.transactions || !ids.postings) {
    return {initialized: false, checkedTransactions: 0, checkedPostings: 0, checkedAccounts: 0, checkedAuditEvents: 0, checkedPeriods: 0, checkedEvidence: 0, findings};
  }

  // Raw entity reads.
  const accountRows = await db.query<RawRow>(
    `SELECT ${ROW_COLS} FROM pages WHERE database_id = $1 AND deleted_at IS NULL`,
    [ids.accounts],
  );
  const txRows = await db.query<RawRow>(
    `SELECT ${ROW_COLS} FROM pages WHERE database_id = $1 AND deleted_at IS NULL`,
    [ids.transactions],
  );
  const postingRows = await db.query<RawRow>(
    // `id` completes the TOTAL order: position (MAX+1) can tie under READ
    // COMMITTED on real Postgres and created_at can tie within one transaction,
    // so without it the derived content hash would be plan-dependent.
    `SELECT ${ROW_COLS} FROM pages WHERE database_id = $1 AND deleted_at IS NULL
     ORDER BY position ASC, created_at ASC, id ASC`,
    [ids.postings],
  );
  const auditRows = await db.query<RawAuditRow>('SELECT * FROM ledger_audit ORDER BY seq ASC');
  const events = auditRows.map(auditFromRaw);

  const accounts = new Map<string, LedgerAccount>(accountRows.map((r) => [r.id, accountFromRaw(r)]));
  const postings = postingRows.map(postingFromRaw);
  const postingsByTx = new Map<string, LedgerPosting[]>();
  for (const posting of postings) {
    const list = postingsByTx.get(posting.transactionId) ?? [];
    list.push(posting);
    postingsByTx.set(posting.transactionId, list);
  }
  const transactions = new Map<string, LedgerTransaction>(
    txRows.map((r) => [r.id, transactionFromRaw(r, postingsByTx.get(r.id) ?? [])]),
  );

  // (a) Balance: every posted/void transaction sums to zero over ≥2 postings.
  for (const tx of transactions.values()) {
    if (tx.state !== 'posted' && tx.state !== 'void') continue;
    if (tx.postings.length < 2) {
      flag('too-few-postings', `${tx.state} transaction ${tx.id} has ${tx.postings.length} posting(s); a journal entry needs at least 2`, tx.id);
    }
    let sum = 0;
    let valid = true;
    for (const p of tx.postings) {
      if (typeof p.amountMinor !== 'number' || !Number.isSafeInteger(p.amountMinor)) {
        flag('invalid-amount', `posting ${p.id} of transaction ${tx.id} stores a non-safe-integer amount: ${String(p.amountMinor)}`, p.id);
        valid = false;
        continue;
      }
      sum += p.amountMinor;
    }
    if (valid && sum !== 0) {
      flag('unbalanced', `${tx.state} transaction ${tx.id} sums to ${sum} minor units (must be 0)`, tx.id);
    }
  }

  // (c) Referential integrity: every posting resolves both ways.
  for (const posting of postings) {
    if (!transactions.has(posting.transactionId)) {
      flag('orphan-posting', `posting ${posting.id} references a nonexistent transaction ${posting.transactionId || '(empty)'}`, posting.id);
    }
    if (!accounts.has(posting.accountId)) {
      flag('unknown-account', `posting ${posting.id} references a nonexistent account ${posting.accountId || '(empty)'}`, posting.id);
    }
  }

  // (b) Audit hash chain — internal continuity. Track the last recorded content
  // hash per entity; a `posting.cleared` event changes a transaction's content
  // without recording a transaction-level hash, so it invalidates that chain
  // tip (the replay comparison below still covers the content).
  const lastTxHash = new Map<string, string | null>();
  const lastAccountHash = new Map<string, string | null>();
  const lastReconciliationHash = new Map<string, string | null>();
  const lastPeriodHash = new Map<string, string | null>();
  const chain = (
    map: Map<string, string | null>,
    entityId: string,
    ev: LedgerAuditEvent,
  ): void => {
    const expected = map.get(entityId);
    if (expected !== undefined && expected !== null && ev.beforeHash !== expected) {
      flag(
        'audit-chain-broken',
        `audit seq ${ev.seq} (${ev.action}) beforeHash ${ev.beforeHash ?? 'null'} does not chain from the previous afterHash ${expected} for entity ${entityId}`,
        entityId,
      );
    }
  };
  /**
   * RE-DERIVE the event's recorded `afterHash` from its OWN payload. Linkage
   * alone is decorative: an attacker who doctors a row and the matching payload
   * — leaving the hash columns untouched — passes every chain check. Recomputing
   * the digest from the payload is what makes the recorded hash load-bearing.
   */
  const derived = async (entityId: string, content: Record<string, unknown>, ev: LedgerAuditEvent): Promise<void> => {
    // A NULL afterHash is treated as a mismatch, never as "nothing to check":
    // every action routed in here is one whose writer ALWAYS records an
    // afterHash, so a null here is itself the forgery — otherwise `UPDATE
    // ledger_audit SET after_hash = NULL` would defeat this check by DELETING
    // the digest instead of forging it. (`ledger.init` and `transaction.delete`
    // record a null afterHash BY DESIGN and are deliberately never routed here.)
    const actual = await sha256Hex(canonicalLedgerJson(content));
    if (actual !== ev.afterHash) {
      flag(
        'audit-hash-forged',
        `audit seq ${ev.seq} (${ev.action}) records afterHash ${ev.afterHash ?? 'NULL'} but its own payload hashes to ${actual} — the audit row was rewritten`,
        entityId,
      );
    }
  };
  /**
   * The born-pristine invariant on a period event's entry (LGR-12, Quinn R2):
   * the writer ALWAYS emits closing and reopen-reversal legs
   * `cleared: 'pending'`, `reconciliationId: null`, so a frozen payload saying
   * otherwise was rewritten. This is the detector for the workflow fields the
   * period hash chain deliberately EXCLUDES (`closingEntryContent`): without
   * it, consistent surgery on a closing leg's cleared state — raw row and
   * payload doctored together, hashes untouched — verified clean, because the
   * replay comparison agrees with itself on both sides of the doctoring.
   */
  const assertPristineClosingLegs = (ev: LedgerAuditEvent, transaction: LedgerTransaction | null): void => {
    for (const leg of transaction?.postings ?? []) {
      if (leg.cleared !== 'pending' || leg.reconciliationId !== null) {
        flag(
          'closing-posting-forged',
          `audit seq ${ev.seq} (${ev.action}) records posting ${leg.id} born ${JSON.stringify(leg.cleared)}${leg.reconciliationId !== null ? ` owned by reconciliation ${leg.reconciliationId}` : ''} — the writer emits these legs pending and unowned, so the payload was rewritten`,
          leg.id,
        );
      }
    }
  };

  for (const ev of events) {
    const p = ev.payload as {
      account?: LedgerAccount;
      transaction?: LedgerTransaction;
      transactionId?: string;
      originalId?: string;
      postingId?: string;
      cleared?: string;
      path?: string | null;
      reconciliation?: LedgerReconciliation;
      postings?: LedgerReconciliationPostingChange[];
      period?: LedgerPeriod;
    };
    switch (ev.action) {
    case 'account.create':
      if (p.account) {
        await derived(p.account.id, accountContent(p.account), ev);
        lastAccountHash.set(p.account.id, ev.afterHash);
      }
      break;
    case 'account.update':
      if (p.account) {
        await derived(p.account.id, accountContent(p.account), ev);
        chain(lastAccountHash, p.account.id, ev);
        lastAccountHash.set(p.account.id, ev.afterHash);
      }
      break;
    case 'transaction.create':
      if (p.transaction) {
        await derived(p.transaction.id, transactionContent(p.transaction), ev);
        lastTxHash.set(p.transaction.id, ev.afterHash);
      }
      break;
    case 'transaction.update':
    case 'transaction.post':
      if (p.transaction) {
        await derived(p.transaction.id, transactionContent(p.transaction), ev);
        chain(lastTxHash, p.transaction.id, ev);
        lastTxHash.set(p.transaction.id, ev.afterHash);
      }
      break;
    case 'transaction.delete':
      if (p.transactionId) {
        chain(lastTxHash, p.transactionId, ev);
        lastTxHash.delete(p.transactionId);
      }
      break;
    case 'transaction.reverse':
      // beforeHash is the ORIGINAL's pre-void content; afterHash the reversal's.
      if (p.originalId) {
        chain(lastTxHash, p.originalId, ev);
        // The original's post-void content records no hash — invalidate its tip.
        lastTxHash.set(p.originalId, null);
      }
      if (p.transaction) {
        await derived(p.transaction.id, transactionContent(p.transaction), ev);
        lastTxHash.set(p.transaction.id, ev.afterHash);
      }
      break;
    case 'posting.cleared':
      // This event's hashes cover only {id, cleared} — re-derive that shape too.
      if (p.postingId && p.cleared) {
        await derived(p.postingId, {id: p.postingId, cleared: p.cleared}, ev);
      }
      // The parent transaction's content changed without a tx-level hash —
      // invalidate its chain tip (the replay comparison still covers content).
      if (p.transactionId) lastTxHash.set(p.transactionId, null);
      break;
    case 'reconciliation.start':
      if (p.reconciliation) {
        await derived(p.reconciliation.id, reconciliationContent(p.reconciliation), ev);
        lastReconciliationHash.set(p.reconciliation.id, ev.afterHash);
      }
      break;
    case 'reconciliation.finish':
    case 'reconciliation.reopen':
    case 'reconciliation.amend':
    case 'reconciliation.abandon':
      // LGR-22's two additions belong HERE and not with `.start`: each carries a
      // before-state, so each must EXTEND the reconciliation's hash chain rather
      // than open one. They differ only in that they touch no posting — the
      // `p.postings` loop below is a no-op for them, which is the property the
      // store guarantees and the replay reducer asserts.
      if (p.reconciliation) {
        await derived(p.reconciliation.id, reconciliationContent(p.reconciliation), ev);
        chain(lastReconciliationHash, p.reconciliation.id, ev);
        lastReconciliationHash.set(p.reconciliation.id, ev.afterHash);
      }
      // The postings this event froze or unfroze changed content WITHOUT a
      // transaction-level hash, exactly as a `posting.cleared` flip does —
      // invalidate each parent's chain tip and let the replay comparison below
      // carry the content check.
      for (const change of p.postings ?? []) lastTxHash.set(change.transactionId, null);
      break;
    case 'period.close':
      // The afterHash covers the PERIOD RECORD AND THE CLOSING ENTRY'S
      // FINANCIAL CONTENT combined (LGR-12). Re-deriving it from the payload is
      // deliberate LGR-22 hygiene: a period that is closed and never reopened
      // has NO later event extending this chain, so consistent surgery on the
      // settings row + this payload would pass replay and linkage — this
      // re-derivation is the only detector left standing (the tamper test in
      // ledgerVerify.test.ts pins it; do not delete this case).
      if (p.period) {
        await derived(p.period.id, periodCloseContent(p.period, p.transaction ?? null), ev);
        lastPeriodHash.set(p.period.id, ev.afterHash);
      }
      // The closing entry is born inside this combined event: no tx-level tip
      // is recorded for it (the replay comparison carries its content), and a
      // later reopen chains through the PERIOD hash, not the tx hash.
      if (p.transaction) lastTxHash.set(p.transaction.id, null);
      assertPristineClosingLegs(ev, p.transaction ?? null);
      break;
    case 'period.reopen':
      // beforeHash must re-derive the close event's afterHash (same combined
      // shape over immutable financial content) — the close → reopen link.
      // Nothing later extends a reopened period's chain, so the afterHash
      // re-derivation here is that event's own forgery detector too.
      if (p.period) {
        await derived(p.period.id, periodReopenContent(p.period, p.transaction ?? null), ev);
        chain(lastPeriodHash, p.period.id, ev);
        lastPeriodHash.set(p.period.id, ev.afterHash);
      }
      if (p.transaction) lastTxHash.set(p.transaction.id, null);
      if (p.originalId) lastTxHash.set(p.originalId, null);
      assertPristineClosingLegs(ev, p.transaction ?? null);
      break;
    case 'ledger.autoExportPath':
      // Policy, not ledger content — it touches no entity, so there is no chain
      // to extend, but the recorded hash is still re-derived from its payload.
      await derived('', {ledgerAutoExportPath: p.path ?? null}, ev);
      break;
    }
  }

  // (d) Replay: the audit stream folded into expected state must equal raw
  // state, entity for entity — with (b)'s content-hash comparison for
  // posted/void rows (the out-of-band-mutation detector).
  const replayed = replayLedgerAudit(events);
  for (const [id, expected] of Object.entries(replayed.transactions)) {
    const raw = transactions.get(id);
    if (!raw) {
      flag('replay-divergence', `audit replay expects transaction ${id} (${expected.state}) but raw storage has no such row`, id);
      continue;
    }
    const rawHash = await sha256Hex(canonicalLedgerJson(transactionContent(raw)));
    const expectedHash = await sha256Hex(canonicalLedgerJson(transactionContent(expected)));
    if (rawHash !== expectedHash) {
      if (raw.state === 'posted' || raw.state === 'void') {
        flag(
          'posted-hash-mismatch',
          `${raw.state} transaction ${id} content hash ${rawHash} differs from the audit-derived hash ${expectedHash} — mutated outside the ledger`,
          id,
        );
      } else {
        flag('replay-divergence', `draft transaction ${id} diverges from the audit-derived content`, id);
      }
    }
  }
  for (const id of transactions.keys()) {
    if (!replayed.transactions[id]) {
      flag('replay-divergence', `raw transaction ${id} has no audit trail (never created through the ledger)`, id);
    }
  }
  for (const [id, expected] of Object.entries(replayed.accounts)) {
    const raw = accounts.get(id);
    if (!raw) {
      flag('replay-divergence', `audit replay expects account ${id} (${expected.name}) but raw storage has no such row`, id);
      continue;
    }
    const rawHash = await sha256Hex(canonicalLedgerJson(accountContent(raw)));
    const expectedHash = await sha256Hex(canonicalLedgerJson(accountContent(expected)));
    if (rawHash !== expectedHash) {
      flag('replay-divergence', `account ${id} (${raw.name}) diverges from the audit-derived content`, id);
    }
  }
  for (const id of accounts.keys()) {
    if (!replayed.accounts[id]) {
      flag('replay-divergence', `raw account ${id} has no audit trail (never created through the ledger)`, id);
    }
  }
  // Reconciliations (LGR-11) get the same treatment. `ids.reconciliations` is
  // optional purely because the settings row is untrusted input here — a real
  // seeded ledger always records all four.
  const reconciliations = new Map<string, LedgerReconciliation>(
    ids.reconciliations
      ? (
        await db.query<RawRow>(
          `SELECT ${ROW_COLS} FROM pages WHERE database_id = $1 AND deleted_at IS NULL`,
          [ids.reconciliations],
        )
      ).map((r) => [r.id, reconciliationFromRaw(r)])
      : [],
  );
  for (const [id, expected] of Object.entries(replayed.reconciliations)) {
    const raw = reconciliations.get(id);
    if (!raw) {
      flag('replay-divergence', `audit replay expects reconciliation ${id} (${expected.status}) but raw storage has no such row`, id);
      continue;
    }
    const rawHash = await sha256Hex(canonicalLedgerJson(reconciliationContent(raw)));
    const expectedHash = await sha256Hex(canonicalLedgerJson(reconciliationContent(expected)));
    if (rawHash !== expectedHash) {
      flag('replay-divergence', `reconciliation ${id} diverges from the audit-derived content`, id);
    }
  }
  for (const id of reconciliations.keys()) {
    if (!replayed.reconciliations[id]) {
      flag('replay-divergence', `raw reconciliation ${id} has no audit trail (never created through the ledger)`, id);
    }
  }
  // Periods (LGR-12): raw storage is the `ledgerPeriods` settings row (see
  // `ledger.ts` for why it is a settings row and not a fifth database). Read
  // RAW — not through LedgerStore.listPeriods — and compared entity for entity
  // against the replay, in both directions, exactly like the page-row entities.
  // The `settings` table provably exists here (the ids read above succeeded);
  // an absent row is an empty history, which a book with no closes should show.
  const periodValueRows = await db.query<{value: unknown}>(
    'SELECT value FROM settings WHERE key = \'ledgerPeriods\'',
  );
  const periods = new Map<string, LedgerPeriod>();
  if (periodValueRows.length > 0) {
    const raw = parseJson<unknown>(periodValueRows[0].value, []);
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        const period = periodFromRawValue(entry);
        if (period.id !== '') periods.set(period.id, period);
      }
    }
  }
  for (const [id, expected] of Object.entries(replayed.periods)) {
    const raw = periods.get(id);
    if (!raw) {
      flag('replay-divergence', `audit replay expects period ${id} (${expected.start}..${expected.end}, ${expected.status}) but raw storage has no such record`, id);
      continue;
    }
    const rawHash = await sha256Hex(canonicalLedgerJson(periodContent(raw)));
    const expectedHash = await sha256Hex(canonicalLedgerJson(periodContent(expected)));
    if (rawHash !== expectedHash) {
      flag('replay-divergence', `period ${id} diverges from the audit-derived content`, id);
    }
  }
  for (const id of periods.keys()) {
    if (!replayed.periods[id]) {
      flag('replay-divergence', `raw period ${id} has no audit trail (never closed through the ledger)`, id);
    }
  }

  // (e) Entry numbers: posted/void entries carry exactly the dense set 1..N.
  const entryNos: number[] = [];
  for (const tx of transactions.values()) {
    if (tx.state !== 'posted' && tx.state !== 'void') continue;
    if (tx.entryNo == null) {
      flag('entry-no-missing', `${tx.state} transaction ${tx.id} has no entry number`, tx.id);
      continue;
    }
    entryNos.push(tx.entryNo);
  }
  entryNos.sort((a, b) => a - b);
  const seen = new Set<number>();
  for (const n of entryNos) {
    if (seen.has(n)) flag('entry-no-duplicate', `entry number ${n} is assigned to more than one transaction`);
    seen.add(n);
  }
  const unique = [...seen].sort((a, b) => a - b);
  for (let i = 0; i < unique.length; i += 1) {
    if (unique[i] !== i + 1) {
      flag('entry-no-gap', `entry numbers are not dense: expected ${i + 1} next, found ${unique[i]}`);
      break; // one gap finding is enough — everything after is shifted
    }
  }

  // (f) Evidence manifests (LGR-14).
  const checkedEvidence = await checkEvidenceManifests(db, transactions, accounts, flag);

  return {
    initialized: true,
    checkedTransactions: transactions.size,
    checkedPostings: postings.length,
    checkedAccounts: accounts.size,
    checkedAuditEvents: events.length,
    checkedPeriods: periods.size,
    checkedEvidence,
    findings,
  };
}

/** A content-hash asset id: 64 lowercase hex chars (the SHA-256 of the bytes). */
const ASSET_ID_RE = /^[0-9a-f]{64}$/;

/**
 * Normalize a BYTEA column value to bytes: PGlite and postgres.js hand back a
 * `Uint8Array`; some drivers hand back the `\x…` hex string. Independent of the
 * store's own normalizer on purpose (this module decodes raw storage itself).
 */
function toBytes(raw: Uint8Array | string): Uint8Array {
  if (typeof raw !== 'string') return raw;
  const hex = raw.startsWith('\\x') ? raw.slice(2) : raw;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** SHA-256 hex of raw BYTES (the asset-store id function), isomorphic. */
async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Check (f) — evidence manifests vs the content-addressed asset store (LGR-14).
 *
 * Scope: POSTED and VOID entries only. Their manifests are FROZEN (inside the
 * audited content, so the row-vs-payload checks above already pin the manifest
 * itself); what nothing above looks at is whether the STORE still honours the
 * manifest — the bytes behind each hash. A draft's manifest is deliberately out
 * of scope: it is mutable, `post` re-resolves it against the store inside the
 * posting transaction, and a missing draft attachment is a user-fixable state,
 * not tamper evidence.
 *
 * Detection taxonomy (each its own code — an operator responds differently):
 *  - REPLACED (`evidence-asset-replaced`): the row exists but its bytes no
 *    longer hash to their id. The receipt-swap. No API can produce this state
 *    (ids are derived from bytes at upload; nothing updates `bytes`), and the
 *    swap leaves every ledger row and hash untouched — this re-hash is the ONLY
 *    detector, which is why the tamper test pins it (do not delete this check).
 *  - REMOVED (`evidence-asset-missing`): the row is gone. Also surgery-only:
 *    the GC keeps any asset whose id appears in any page's properties (the
 *    posted manifest does exactly that) or holds a live `asset_refs` edge (the
 *    tx-row ref), and no route or store method deletes asset rows. "Never
 *    existed" is not a reachable explanation — `post` verified presence inside
 *    the posting transaction.
 *  - SIZE DRIFT (`evidence-size-mismatch`): bytes hash correctly but their
 *    count differs from the manifest's `size` — doctored store metadata or a
 *    consistently-rewritten manifest.
 *  - MALFORMED (`evidence-manifest-invalid`): an item the checks above cannot
 *    even be run on; flagged, never skipped (a skip would make malforming the
 *    manifest the cheapest way to retire its checks).
 *
 * Also runs the CURRENT-POLICY advisory (`evidence-required-missing`, F2): a
 * bare posted/void entry (no manifest, not a reversal, not a closing entry)
 * with a leg on an account that CURRENTLY has `evidenceRequired`. This reads
 * the account rows AS THEY ARE — deliberately, because the flag itself is the
 * thing the traceless bypass toggles (SQL it off, post bare, SQL it back on:
 * every other check is clean by construction, since the restored row matches
 * its audit trail again). See the finding-code docstring for the advisory
 * framing and the carve-out reasoning.
 *
 * Returns the number of manifest items checked — the green-on-nothing guard's
 * observable: a fixture that expects `checkedEvidence > 0` cannot pass while
 * the whole section silently stops running (the LGR-22 lesson).
 */
async function checkEvidenceManifests(
  db: Db,
  transactions: ReadonlyMap<string, LedgerTransaction>,
  accounts: ReadonlyMap<string, LedgerAccount>,
  flag: (code: LedgerVerifyCode, message: string, entityId?: string) => void,
): Promise<number> {
  interface ManifestItem {
    txId: string;
    txState: string;
    filename: string;
    sha256: string;
    size: number;
  }
  const items: ManifestItem[] = [];
  let checked = 0;
  for (const tx of transactions.values()) {
    if (tx.state !== 'posted' && tx.state !== 'void') continue;
    // The current-policy advisory (F2). Void entries stay in scope: a reversed
    // bare entry is still the entry that could not answer for itself, and
    // hiding it behind its own reversal would make reversing the cheapest way
    // to clear the report.
    if (tx.evidence.length === 0 && tx.reverses === null && tx.kind !== 'closing') {
      const required = [...new Set(tx.postings.map((p) => p.accountId))]
        .map((id) => accounts.get(id))
        .filter((a): a is LedgerAccount => a !== undefined && a.evidenceRequired);
      if (required.length > 0) {
        const names = required.map((a) => a.name).join(', ');
        flag(
          'evidence-required-missing',
          `policy advisory — ${tx.state} transaction ${tx.id} (entry #${tx.entryNo ?? '?'}) has no evidence, but ${required.length === 1 ? `account ${names} currently requires` : `accounts ${names} currently require`} it. Not tamper evidence: entries posted before the requirement was turned on land here by design.`,
          tx.id,
        );
      }
    }
    for (const raw of tx.evidence) {
      checked += 1;
      const filename = (raw as {filename?: unknown} | null)?.filename;
      const sha256 = (raw as {sha256?: unknown} | null)?.sha256;
      const size = (raw as {size?: unknown} | null)?.size;
      if (
        typeof filename !== 'string' ||
        typeof sha256 !== 'string' ||
        !ASSET_ID_RE.test(sha256) ||
        typeof size !== 'number' ||
        !Number.isSafeInteger(size) ||
        size < 0
      ) {
        flag(
          'evidence-manifest-invalid',
          `${tx.state} transaction ${tx.id} carries a malformed evidence item ${JSON.stringify(raw)} — the writer only stores {filename, sha256, size}, so this was written out-of-band`,
          tx.id,
        );
        continue;
      }
      items.push({txId: tx.id, txState: tx.state, filename, sha256, size});
    }
  }
  if (items.length === 0) return checked;

  // One read for the distinct hashes; bytes are re-hashed per DISTINCT asset
  // (dedup — the store itself is content-addressed, so N manifests of one
  // receipt are one digest).
  const distinct = [...new Set(items.map((i) => i.sha256))];
  let assetRows: Array<{id: string; size: number | string; bytes: Uint8Array | string}> = [];
  try {
    assetRows = await db.query<{id: string; size: number | string; bytes: Uint8Array | string}>(
      'SELECT id, size, bytes FROM assets WHERE id = ANY($1)',
      [distinct],
    );
  } catch (err) {
    // A library whose migrations never created the asset store cannot hold any
    // of the bytes these manifests promise — that is N missing assets, reported
    // below, not a crash and not a silent pass. Any other failure propagates
    // (isMissingRelation is deliberately narrow).
    if (!isMissingRelation(err, 'assets')) throw err;
  }
  const byId = new Map(assetRows.map((r) => [r.id, r]));
  const actualHash = new Map<string, string>();
  const actualSize = new Map<string, number>();
  for (const row of assetRows) {
    const bytes = toBytes(row.bytes);
    actualHash.set(row.id, await sha256HexOfBytes(bytes));
    actualSize.set(row.id, bytes.byteLength);
  }

  for (const item of items) {
    const row = byId.get(item.sha256);
    if (!row) {
      flag(
        'evidence-asset-missing',
        `${item.txState} transaction ${item.txId} records evidence "${item.filename}" (${item.sha256}, ${item.size} bytes) but the asset store no longer holds it — the receipt was removed after posting`,
        item.txId,
      );
      continue;
    }
    const rehash = actualHash.get(item.sha256);
    if (rehash !== item.sha256) {
      flag(
        'evidence-asset-replaced',
        `${item.txState} transaction ${item.txId} evidence "${item.filename}": the stored bytes hash to ${rehash ?? 'nothing'}, not the recorded ${item.sha256} — the receipt was replaced after posting`,
        item.txId,
      );
      continue;
    }
    if (actualSize.get(item.sha256) !== item.size) {
      flag(
        'evidence-size-mismatch',
        `${item.txState} transaction ${item.txId} evidence "${item.filename}" (${item.sha256}): manifest records ${item.size} bytes but the store holds ${actualSize.get(item.sha256) ?? 0}`,
        item.txId,
      );
    }
  }
  return checked;
}

/** Defensive raw projection of one stored periods-array element. */
function periodFromRawValue(raw: unknown): LedgerPeriod {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: str(r.id),
    start: str(r.start),
    end: str(r.end),
    status: r.status === 'reopened' ? 'reopened' : 'closed',
    closingEntryId: strOrNull(r.closingEntryId),
    reopenEntryId: strOrNull(r.reopenEntryId),
    closedAt: str(r.closedAt),
    closedBy: str(r.closedBy),
    reopenedAt: strOrNull(r.reopenedAt),
    reopenedBy: strOrNull(r.reopenedBy),
  };
}
