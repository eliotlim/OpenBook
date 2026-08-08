/**
 * Server ledger core (LGR-3) — the ONE writer of ledger data.
 *
 * Ledger data lives in FOUR server-managed OpenBook databases (accounts /
 * transactions / postings / reconciliations), seeded on a `restricted` host page
 * and marked `managed` (the C1 AI-usage precedent). Rows are ordinary pages;
 * every ledger value is a database property keyed by the stable `LEDGER_PROP`
 * ids. The functions on {@link LedgerStore} are the ONLY code that writes those
 * rows: `PageStore` refuses direct writes/deletes to ledger rows at the STORE
 * layer (not just the HTTP routes), so browser-local mode — which bypasses HTTP
 * entirely via `LocalDataClient` — is enforced identically.
 *
 * Enforced invariants (REJECT with typed {@link LedgerError}s, never advise):
 *  1. Post: Σ amount_minor = 0, ≥2 postings (n-ary compound entries are
 *     first-class, capped at {@link MAX_POSTINGS_PER_TRANSACTION}), at least one
 *     NONZERO posting (a balanced no-op is noise, not an entry), every posting
 *     resolves to an OPEN account, every amount a safe signed integer of minor
 *     units, currency uniform per transaction. A REVERSAL is held to the same
 *     bar — it cannot post into a closed account either (reopen it first), so
 *     "closed ⇒ zero balance" stays a real invariant rather than advice.
 *  2. Posted transactions and their postings are immutable; corrections are a
 *     new reversing transaction (`reverses` set); void happens only via the
 *     reversal pair (the original flips to `void` inside the reverse).
 *  3. Draft mutation/deletion is allowed (deletion is permanent + audited).
 *  4. `reconciled` postings can't change cleared state except through a
 *     reconciliation finish/reopen (LGR-11). There is no opt-out parameter:
 *     `setPostingCleared` refuses every transition touching `reconciled`, and
 *     the two reconciliation writers are the only code that reaches that state.
 *  5. Every ledger mutation appends exactly ONE audit event (who / when /
 *     action / entity ids / before-after content hash) to the append-only
 *     `ledger_audit` table — in the SAME transaction as the mutation. Each event
 *     is HASH-CHAINED to its predecessor (`prev_hash`, migration 0021), which
 *     detects an unrecomputed database-level edit or middle deletion. It does
 *     NOT detect head/tail truncation or a fully recomputed rewrite (the hash is
 *     unkeyed and the log unanchored — off-box anchoring is LGR-18). See
 *     {@link verifyLedgerAuditChain} for the exact guarantee.
 *  6. Entry numbers are a server-assigned monotonic sequence per library
 *     (never the collision-prone client-assigned `unique_id`).
 *
 * Atomicity: a journal-entry post/reverse/create is ONE `Db.begin` transaction —
 * transaction row + N posting rows + the audit event commit or roll back
 * together (PGlite serializes via its FIFO mutex; Postgres uses a real tx).
 *
 * Browser-safe: no Node imports (store.ts bundles this into the webview build).
 */

import {
  LEDGER_AUDIT_ACTIONS,
  LEDGER_DEFAULT_TRANSACTION_LIMIT,
  LEDGER_MAX_TRANSACTION_LIMIT,
  LEDGER_PROP,
  LedgerError,
  MoneyError,
  assertUniformCurrency,
  buildLedgerBeancount,
  buildLedgerPostingsCsv,
  canonicalLedgerJson,
  closedPeriodContaining,
  emptyPageSnapshot,
  isIncomeStatementAccountType,
  isValidCurrencyCode,
  isValidLedgerAccountName,
  isValidLedgerDate,
  isValidMinor,
  LEDGER_RECONCILIATION_STATUSES,
  ledgerAuditEventHash,
  ledgerRestorePayloadContent,
  negateAmount,
  parseLedgerExportSection,
  sumAmounts,
  verifyLedgerAuditChain,
  type DatabaseProperty,
  type DatabaseSchema,
  type LedgerAccount,
  type LedgerAccountInput,
  type LedgerAccountPatch,
  type LedgerAuditAction,
  type LedgerAuditChainResult,
  type LedgerAuditEvent,
  type LedgerClearedState,
  type LedgerDraftInput,
  type LedgerDraftPatch,
  type LedgerEvidence,
  type LedgerEvidenceInput,
  type LedgerExportSection,
  type LedgerInfo,
  type LedgerPeriod,
  type LedgerPeriodCloseInput,
  type LedgerPeriodCloseResult,
  type LedgerPeriodReopenResult,
  type LedgerPosting,
  type LedgerPostingInput,
  type LedgerReconciliation,
  type LedgerReconciliationInput,
  type LedgerReconciliationPatch,
  type LedgerReconciliationPostingChange,
  type LedgerReconciliationStatus,
  type LedgerReconciliationSummary,
  type LedgerReverseOptions,
  type LedgerSectionBook,
  type LedgerSectionPosting,
  type LedgerSectionReconciliation,
  type LedgerSectionRestoreResult,
  type LedgerSectionTransaction,
  type LedgerTransaction,
  type LedgerTransactionState,
  type Principal,
} from '@book.dev/sdk';
import {randomUUID} from './uuid';
import type {Db} from './dbCore';
import type {PageStore} from './store';

/**
 * The `settings` key holding the seeded ledger ids. `store.ts` reads it (via
 * this export — ledger.ts is import-safe from the store: no Node imports) to
 * gate its generic write paths against ledger rows.
 */
export const LEDGER_DB_SETTING_KEY = 'ledgerDb';

/** The `settings` key backing the per-library monotonic entry-number sequence. */
export const LEDGER_ENTRY_SEQ_SETTING_KEY = 'ledgerEntrySeq';

/**
 * The `settings` key holding the accounting periods (LGR-12) as a JSON array of
 * `LedgerPeriod` records — NOT a fifth managed database, deliberately:
 *
 *  - A book seeded before LGR-12 could never grow a fifth database: the seed's
 *    adopt check (`ensureSetup`) returns early the moment the transactions
 *    database resolves, and creating one lazily cannot run inside a `Db.begin`
 *    (`upsertPage`/`createDatabase` each open their own transaction — the
 *    embedded PGlite mutex is non-reentrant; see `doSeed`). A settings row is
 *    simply ABSENT until the first close, on old and new books identically.
 *  - The row IS the lock the close flow needs: `post`/`reverse` take it
 *    `FOR SHARE`, `closePeriod`/`reopenPeriod` `FOR UPDATE`, at the `settings`
 *    slot the proven lock order already holds (see `loadAccountPostingsOn`).
 *  - The LGR-22 seed-only lesson (options frozen at seed time — the comment on
 *    `buildReconciliationsSchema`) is a whole-database problem here: a managed
 *    schema cannot be evolved on existing books, let alone created.
 *
 * A book holds a handful of period records, so a single JSONB array is the
 * right size; the settings UI reads them through `GET /api/ledger/periods`.
 */
export const LEDGER_PERIODS_SETTING_KEY = 'ledgerPeriods';

/** The account name `closePeriod` resolves when no explicit id is given. */
export const LEDGER_RETAINED_EARNINGS_ACCOUNT = 'Equity:RetainedEarnings';

const LEDGER_HOST_TITLE = 'Ledger';

/**
 * The seeded ids recorded in `settings` under {@link LEDGER_DB_SETTING_KEY}.
 * A page hosts at most ONE database (`databases_page_id_key`), so the ledger is
 * a restricted ROOT page (`hostPageId`) with four restricted CHILD pages
 * (`hostPages.*`), each hosting one of the managed databases.
 */
export interface LedgerIds {
  hostPageId: string;
  accounts: string;
  transactions: string;
  postings: string;
  reconciliations: string;
  hostPages: {accounts: string; transactions: string; postings: string; reconciliations: string};
}

/** Raw page-row shape the ledger queries read. */
interface Row {
  id: string;
  name: string | null;
  properties: Record<string, unknown> | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * One of an account's postings as the reconciliation paths carry it: the
 * projected entity, its RAW row (so a write can patch the stored properties
 * without a second read of a row it already holds a lock on), and the state of
 * the entry it belongs to.
 */
interface AccountPostingRow {
  posting: LedgerPosting & {row: Row};
  state: LedgerTransactionState | null;
}

interface AuditRow {
  seq: number | string;
  id: string;
  actor_subject: string;
  actor_name: string;
  action: string;
  entity_ids: unknown;
  payload: unknown;
  before_hash: string | null;
  after_hash: string | null;
  /** Nullable: genesis event, or an event written before migration 0021. */
  prev_hash?: string | null;
  created_at: Date | string;
}

const toIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const parseJson = <T>(value: T | string | null | undefined, fallback: T): T => {
  if (value == null) return fallback;
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
};

const str = (raw: unknown): string => (typeof raw === 'string' ? raw : '');
const strOrNull = (raw: unknown): string | null => (typeof raw === 'string' && raw.length > 0 ? raw : null);

/** SHA-256 hex of a string (isomorphic — Node ≥19, browser, sidecar). */
async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const ROW_COLS = 'id, name, properties, created_at, updated_at';

/**
 * Maximum postings in one journal entry (LGR-3 F6). Compound entries are
 * first-class, but the whole post runs inside a single transaction that holds
 * the embedded backend's global FIFO mutex AND the entry-number sequence row
 * lock — an unbounded entry is therefore a wedge vector (2000 postings measured
 * at ~1.2 s of exclusive database time, growing linearly). 1000 legs is far
 * beyond any real compound entry (a large payroll run splits per employee).
 */
const MAX_POSTINGS_PER_TRANSACTION = 1000;

/** Maximum length of a transaction description (LGR-3 F5) AND of a posting memo
 *  (LGR-16 — same free text, same audit-payload copy, so deliberately the same
 *  bound). Long values are copied into EVERY audit payload, so this bounds the
 *  log's growth too. */
const MAX_DESCRIPTION_LENGTH = 1000;

/**
 * Maximum postings ONE reconciliation may freeze or release (LGR-11), mirroring
 * {@link MAX_POSTINGS_PER_TRANSACTION}.
 *
 * WHAT IT BOUNDS, and why that is the whole design: a freeze writes ONE audit
 * event carrying the after-state of every posting it froze, so the payload grows
 * linearly with the WRITTEN set (~190 B a posting measured). At this cap the
 * worst case is a ~190 KB row; unbounded, a 20k-posting account would write
 * ~3.8 MB into a single append-only row that can never be pruned.
 *
 * WHAT IT MUST NOT BOUND: how many postings the account HOLDS. The first version
 * capped that, and it was a brick, not a bound — `start` on a small account,
 * ordinary posting until the account passes the cap, and `finish` then refused
 * forever with no cancel and no reopen. Every long-lived current account reaches
 * a thousand postings eventually, with no adversary involved, so a cardinality
 * cap makes reconciliation permanently unavailable on exactly the accounts that
 * need it most. A cap on the WRITTEN set always has a remedy the user can reach:
 * untick rows, or reconcile in more than one pass.
 *
 * The lock hold on a very large account is a real cost and is deliberately NOT
 * capped: `finish`/`reopen` lock every posting on the account inside one
 * `Db.begin`. That is a performance concern with a bounded blast radius, and
 * paying it beats refusing to reconcile the account at all.
 */
const MAX_RECONCILIATION_POSTINGS = 1000;

/**
 * Maximum evidence attachments on ONE journal entry (LGR-14), in the spirit of
 * {@link MAX_POSTINGS_PER_TRANSACTION}: the manifest is copied into every audit
 * payload the entry appears in, so an unbounded list is unbounded append-only
 * log growth. Measured worst case (Sasha's F5 figure): ~620 B an item — a
 * 255-char multibyte filename dominates — so the caps bound one payload's
 * manifest at ~62 KB. Deliberately a size CAP and not a filename byte-length
 * cap: 62 KB is an acceptable worst case for an append-only row, and a
 * character cap is the bound a user can actually reason about. A hundred
 * receipts on one entry is far beyond any real bookkeeping shape anyway (a
 * batch of receipts is a batch of entries).
 */
const MAX_EVIDENCE_PER_TRANSACTION = 100;

/**
 * Maximum evidence FILENAME length (LGR-14), in CHARACTERS. Deliberately
 * tighter than {@link MAX_DESCRIPTION_LENGTH}: a filename is an identifier,
 * not prose, and every byte of it is copied into the audit payloads. 255 is
 * the common filesystem bound, so any name a real file ever had fits.
 */
const MAX_EVIDENCE_FILENAME_LENGTH = 255;

/** A content-hash asset id: 64 lowercase hex chars (the SHA-256 of the bytes). */
const ASSET_ID_RE = /^[0-9a-f]{64}$/;

/**
 * Characters an evidence filename must NOT contain (LGR-14 F3): a strict
 * SUPERSET of the bank-import sanitizer's `UNSAFE_TEXT` (`importModel.ts` —
 * C0/C1 controls incl. the NUL that previously escaped as a raw Postgres
 * 22P05 → untyped 500; SHY; U+061C ALM and U+180E; ZWSP/ZWJ/ZWNJ + LRM/RLM;
 * RLO/LRO/PDF; the ENTIRE U+2060–206F block, word joiner through the
 * directional isolates and the deprecated formatting controls; interlinear
 * annotation; and the U+E0000–E007F TAG BLOCK — the standard channel for
 * smuggling instructions past a human into an agent, and this ledger is
 * MCP-readable — which is why the `u` flag), PLUS two of this field's own:
 * U+2028/2029 line/paragraph separators (a filename is a single line of the
 * verifier report) and U+FEFF (BOM-as-ZWNBSP). A filename is the one field
 * that flows verbatim into the VERIFIER's integrity report, where
 * `receipt<U+202E> fdp.exe` reading as something it is not is precisely the
 * deception an integrity report must not carry. REJECTED with a typed error,
 * not stripped: unlike a pasted bank cell, a filename arrives from a file
 * picker — a control character in it is a client bug or an attack, and
 * silently renaming evidence would make the stored manifest disagree with
 * what the user saw attach.
 */
const EVIDENCE_FILENAME_FORBIDDEN_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/u;

/**
 * Advisory-lock key serializing audit-chain appends (see
 * {@link LedgerStore.appendAuditTx}). Transaction-scoped, so it is released on
 * commit or rollback with no cleanup path to get wrong. An arbitrary but fixed
 * 64-bit constant — it only has to be distinct from any other advisory lock the
 * application takes.
 *
 * Exported since LGR-15: the backup-restore door (`store.ts`) takes the SAME
 * lock while installing a bundle's audit stream, so a restore can never
 * interleave with a live append computing its `prev_hash` from a moving tail.
 * LOCK ORDER there mirrors {@link LedgerStore.doSeed}: settings-row claim
 * first, then this lock — one order everywhere, no cycle.
 */
export const LEDGER_AUDIT_CHAIN_LOCK = 0x1e_d6_e5_a0;

/**
 * {@link sumAmounts}, with any {@link MoneyError} translated into the typed
 * ledger contract (LGR-3 F4). A raw `MoneyRangeError` escaping the ledger API
 * surfaced as an HTTP 500 rather than a typed `{error, code}` body — and on the
 * read path it permanently blocked the very `updateAccount(status:'closed')`
 * call that would have let an operator resolve the overflow.
 */
function sumMinorOrThrow(amounts: number[], context: string): number {
  try {
    return sumAmounts(amounts);
  } catch (err) {
    if (err instanceof MoneyError) {
      throw new LedgerError('invalid-amount', `${context}: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Validate one optional free-text ledger field (LGR-3 F5): a string within
 * {@link MAX_DESCRIPTION_LENGTH}. A non-string 500'd; a multi-megabyte value
 * blew the btree index limit and bloated every audit payload.
 *
 * `nullable` is for fields whose ABSENT value is an explicit `null` on the
 * entity (a posting memo) rather than an omitted key (a description).
 */
function assertFreeText(value: unknown, field: string, opts: {nullable?: boolean} = {}): void {
  if (value === undefined) return;
  if (value === null) {
    if (opts.nullable) return;
    throw new LedgerError('invalid-input', `${field} must be a string, got null`);
  }
  if (typeof value !== 'string') {
    throw new LedgerError('invalid-input', `${field} must be a string, got ${typeof value}`);
  }
  if (value.length > MAX_DESCRIPTION_LENGTH) {
    throw new LedgerError(
      'invalid-input',
      `${field} must be at most ${MAX_DESCRIPTION_LENGTH} characters, got ${value.length}`,
    );
  }
}

/** Validate an optional transaction description. See {@link assertFreeText}. */
function assertDescription(description: unknown): void {
  assertFreeText(description, 'description');
}

/**
 * Validate a draft's evidence input list (LGR-14) — SHAPE only; whether each
 * named asset actually exists is checked inside the mutation's transaction
 * ({@link LedgerStore.resolveEvidenceTx}). The manifest is a SET: a duplicate
 * hash is rejected rather than silently collapsed, because two entries with
 * one hash is a client bug the server should name, not paper over.
 */
function validateEvidenceInputs(evidence: LedgerEvidenceInput[] | undefined): LedgerEvidenceInput[] | undefined {
  if (evidence === undefined) return undefined;
  if (!Array.isArray(evidence)) {
    throw new LedgerError('invalid-input', 'evidence must be an array of {sha256, filename}');
  }
  if (evidence.length > MAX_EVIDENCE_PER_TRANSACTION) {
    throw new LedgerError(
      'invalid-input',
      `a journal entry may carry at most ${MAX_EVIDENCE_PER_TRANSACTION} evidence attachments, got ${evidence.length}`,
    );
  }
  const seen = new Set<string>();
  const out: LedgerEvidenceInput[] = [];
  for (const item of evidence) {
    const sha256 = (item as {sha256?: unknown} | null)?.sha256;
    const filename = (item as {filename?: unknown} | null)?.filename;
    if (typeof sha256 !== 'string' || !ASSET_ID_RE.test(sha256)) {
      throw new LedgerError('invalid-input', `evidence sha256 must be 64 lowercase hex chars (the asset id), got ${JSON.stringify(sha256)}`);
    }
    if (typeof filename !== 'string' || filename.trim() === '') {
      throw new LedgerError('invalid-input', 'every evidence attachment needs a non-empty filename');
    }
    if (filename.length > MAX_EVIDENCE_FILENAME_LENGTH) {
      throw new LedgerError(
        'invalid-input',
        `an evidence filename must be at most ${MAX_EVIDENCE_FILENAME_LENGTH} characters, got ${filename.length}`,
      );
    }
    if (EVIDENCE_FILENAME_FORBIDDEN_RE.test(filename)) {
      // F3: typed here, not a raw 22P05 500 from a NUL reaching Postgres — and
      // never stored, so a BIDI override can't reorder a line of the verifier's
      // integrity report (see EVIDENCE_FILENAME_FORBIDDEN_RE).
      throw new LedgerError(
        'invalid-input',
        `evidence filename ${JSON.stringify(filename)} contains control or bidirectional-formatting characters — rename the file and re-attach it`,
      );
    }
    if (seen.has(sha256)) {
      throw new LedgerError('invalid-input', `duplicate evidence attachment ${sha256} — the manifest is a set of distinct files`);
    }
    seen.add(sha256);
    out.push({sha256, filename});
  }
  return out;
}

/**
 * The server-enforced double-entry ledger over the page store. Construct via
 * `store.ledger` (one instance per store); every method is safe to call from
 * both the HTTP routes and `LocalDataClient`.
 */
export class LedgerStore {
  /** In-flight seed, shared so concurrent first inits create ONE set of databases. */
  private seeding: Promise<LedgerInfo> | null = null;

  /** LGR-7: post-commit mutation listeners (the auto-export trigger seam). */
  private readonly mutationListeners = new Set<() => void>();

  constructor(
    private readonly store: PageStore,
    private readonly db: Db,
  ) {}

  /**
   * Subscribe to ledger mutations (LGR-7). The listener fires AFTER each
   * successful (committed) mutation — seed, account create/update, draft
   * create/update/delete, post, reverse, cleared change — over BOTH surfaces
   * (HTTP routes and `LocalDataClient` hit the same methods). Fire-and-forget:
   * a throwing listener is contained and never fails the mutation. Returns an
   * unsubscribe.
   */
  onMutation(listener: () => void): () => void {
    this.mutationListeners.add(listener);
    return () => this.mutationListeners.delete(listener);
  }

  /** Notify listeners after a COMMITTED mutation (never inside the tx). */
  private notifyMutation(): void {
    for (const listener of this.mutationListeners) {
      try {
        listener();
      } catch {
        // A listener failure must never surface into the mutation path.
      }
    }
  }

  // ── Setup / identity ─────────────────────────────────────────────────────────

  /** The recorded ledger ids, or `null` when the ledger has never been seeded. */
  ids(): Promise<LedgerIds | null> {
    return this.store.ledgerIds();
  }

  private async requireIds(): Promise<LedgerIds> {
    const ids = await this.ids();
    if (!ids) throw new LedgerError('not-initialized', 'the ledger has not been initialized on this library');
    return ids;
  }

  /** Whether the ledger exists, and where it lives. */
  async info(): Promise<LedgerInfo> {
    const ids = await this.ids();
    if (!ids) return {exists: false, hostPageId: null, databases: null};
    return {
      exists: true,
      hostPageId: ids.hostPageId,
      databases: {
        accounts: ids.accounts,
        transactions: ids.transactions,
        postings: ids.postings,
        reconciliations: ids.reconciliations,
      },
    };
  }

  /**
   * Idempotently seed the ledger: a restricted host page + the four managed
   * databases, ids recorded in `settings`. A re-run adopts the recorded ids
   * (verifying they still resolve); concurrent first calls share one in-flight
   * seed. Appends the `ledger.init` audit event on the run that actually seeds.
   */
  async ensureSetup(actor?: Principal): Promise<LedgerInfo> {
    const existing = await this.ids();
    if (existing && (await this.store.getDatabase(existing.transactions))) return this.info();
    if (this.seeding) return this.seeding;
    this.seeding = this.doSeed(actor).finally(() => {
      this.seeding = null;
    });
    return this.seeding;
  }

  private async doSeed(actor?: Principal): Promise<LedgerInfo> {
    // Restrict the root BEFORE anything hangs off it so the ledger is never
    // briefly world-readable (the C1 usage-DB posture). A page hosts at most one
    // database, so each of the four databases gets its own restricted child page
    // (visibility 'inherit' resolves to the instance default, NOT the parent —
    // ancestor inheritance isn't implemented — so each child is restricted
    // explicitly).
    const host = await this.store.upsertPage({name: LEDGER_HOST_TITLE, data: emptyPageSnapshot()}, actor);
    await this.store.setPageVisibility(host.id, 'restricted', {internal: true});
    const seedDb = async (name: string, schema: DatabaseSchema): Promise<{dbId: string; pageId: string}> => {
      const page = await this.store.upsertPage({name, data: emptyPageSnapshot(), parentId: host.id}, actor);
      await this.store.setPageVisibility(page.id, 'restricted', {internal: true});
      const database = await this.store.createDatabase({pageId: page.id, name, schema});
      return {dbId: database.id, pageId: page.id};
    };
    const accounts = await seedDb('Ledger accounts', buildAccountsSchema());
    const transactions = await seedDb('Ledger transactions', buildTransactionsSchema());
    const postings = await seedDb('Ledger postings', buildPostingsSchema());
    const reconciliations = await seedDb('Ledger reconciliations', buildReconciliationsSchema());
    const ids: LedgerIds = {
      hostPageId: host.id,
      accounts: accounts.dbId,
      transactions: transactions.dbId,
      postings: postings.dbId,
      reconciliations: reconciliations.dbId,
      hostPages: {
        accounts: accounts.pageId,
        transactions: transactions.pageId,
        postings: postings.pageId,
        reconciliations: reconciliations.pageId,
      },
    };
    // ATOMICITY of the seed (Quinn N3). The two steps that MUST commit together
    // are recording the ids — which ARMS all of the store-level write guards —
    // and the `ledger.init` audit event that opens the log: a crash between them
    // would leave an armed, guarded ledger whose audit chain has no genesis
    // event, and the chain could then never be verified from its origin. They
    // share one transaction here.
    //
    // The host pages + databases created ABOVE are deliberately NOT in that
    // transaction: they go through `store.upsertPage` / `setPageVisibility` /
    // `createDatabase`, each of which opens its own `begin`, and the embedded
    // PGlite backend serializes transactions through a non-reentrant FIFO mutex
    // — calling them inside an open transaction deadlocks the process.
    //
    // A crash between those creations and this commit is NON-CORRUPTING but NOT
    // self-healing: `upsertPage` mints a fresh UUID per call and the adopt check
    // keys off the settings row, so a retry seeds an entirely NEW set and strands
    // the first one — a handful of empty `restricted` pages titled "Ledger",
    // "Ledger accounts", … plus four unreferenced databases carrying ledger
    // schemas. Nothing reclaims them automatically (an operator can delete them).
    // Integrity is unaffected: the stranded set is empty, no guard ever armed for
    // it, no ledger API can reach it, and nothing partially-armed is observable.
    // CLAIM the ids row rather than upsert it (LGR-15, S3). The pre-transaction
    // `ids()` read above is a TOCTOU window: a concurrent backup RESTORE (or a
    // second seeder on real Postgres) can land `ledgerDb` between that read and
    // this commit, and a blind `DO UPDATE` would then OVERWRITE the winner's ids
    // — orphaning an entire restored ledger while this seed's `ledger.init`
    // chains onto the restored tail. `DO NOTHING RETURNING` makes the row a
    // claim: the loser sees no row back, writes nothing (no audit event), and
    // ADOPTS whatever won — its freshly created host pages become the
    // documented non-corrupting strand (see the atomicity note above).
    const won = await this.db.begin(async (tx) => {
      const claim = await tx.query<{key: string}>(
        `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO NOTHING RETURNING key`,
        [LEDGER_DB_SETTING_KEY, JSON.stringify(ids)],
      );
      if (claim.length === 0) return false;
      await this.appendAuditTx(tx, actor, 'ledger.init', [host.id], {hostPageId: host.id, databases: ids}, null, null);
      return true;
    });
    // The settings row was written on the transaction, bypassing `setSetting`'s
    // cache invalidation — drop the store's cached ids so every guard arms now
    // (and, on a lost race, so `info()` reports the WINNER's ledger).
    this.store.invalidateLedgerIds();
    if (won) this.notifyMutation();
    return this.info();
  }

  /**
   * Record a sharing change on a ledger page in the audit log (LGR-3 F3). ACL
   * grants are the sanctioned way to share the ledger (unlike a visibility flip,
   * a grant names its grantee), but they must never be SILENT — who was given
   * what, on which ledger page, belongs in the same append-only trail as the
   * postings. Called by {@link PageStore.setPageAcl}/`removePageAcl`.
   */
  async recordAclChange(
    kind: 'grant' | 'revoke',
    pageId: string,
    grant: {subject: string | null; email: string | null; level: string | null},
    actor?: Principal,
  ): Promise<void> {
    await this.db.begin(async (tx) => {
      await this.appendAuditTx(tx, actor, 'ledger.acl', [pageId], {kind, pageId, ...grant}, null, null);
    });
  }

  // ── Accounts ─────────────────────────────────────────────────────────────────

  async listAccounts(): Promise<LedgerAccount[]> {
    const ids = await this.requireIds();
    const rows = await this.db.query<Row>(
      `SELECT ${ROW_COLS} FROM pages WHERE database_id = $1 AND deleted_at IS NULL ORDER BY name ASC, created_at ASC`,
      [ids.accounts],
    );
    return rows.map(accountFromRow);
  }

  async getAccount(id: string): Promise<LedgerAccount | null> {
    const ids = await this.requireIds();
    const rows = await this.db.query<Row>(
      `SELECT ${ROW_COLS} FROM pages WHERE id = $1 AND database_id = $2 AND deleted_at IS NULL`,
      [id, ids.accounts],
    );
    return rows.length > 0 ? accountFromRow(rows[0]) : null;
  }

  async createAccount(input: LedgerAccountInput, actor?: Principal): Promise<LedgerAccount> {
    const ids = await this.requireIds();
    if (!isValidLedgerAccountName(input.name)) {
      throw new LedgerError('invalid-input', 'account name must be non-empty, colon-delimited segments (e.g. "Assets:Bank:Checking")');
    }
    if (!['asset', 'liability', 'equity', 'revenue', 'expense'].includes(input.type)) {
      throw new LedgerError('invalid-input', `invalid account type: ${JSON.stringify(input.type)}`);
    }
    const currency = input.currency ?? 'USD';
    if (!isValidCurrencyCode(currency)) {
      throw new LedgerError('invalid-input', `invalid currency code: ${JSON.stringify(currency)}`);
    }
    if (input.evidenceRequired !== undefined && typeof input.evidenceRequired !== 'boolean') {
      throw new LedgerError('invalid-input', `evidenceRequired must be a boolean, got ${typeof input.evidenceRequired}`);
    }
    const id = randomUUID();
    const properties = {
      [LEDGER_PROP.account.type]: input.type,
      [LEDGER_PROP.account.status]: 'open',
      [LEDGER_PROP.account.currency]: currency,
      // LGR-14: ONE stored representation of "off" — the key is absent. This is
      // what keeps a new account, a toggled-off account and a pre-LGR-14
      // account byte-identical in properties AND in the content hash.
      ...(input.evidenceRequired === true ? {[LEDGER_PROP.account.evidenceRequired]: true} : {}),
    };
    const created = await this.db.begin(async (tx) => {
      const rows = await this.insertRowTx(tx, ids.accounts, input.name, properties, id);
      const account = accountFromRow(rows);
      await this.appendAuditTx(tx, actor, 'account.create', [id], {account}, null, await sha256Hex(canonicalLedgerJson(accountContent(account))));
      return account;
    });
    this.notifyMutation();
    return created;
  }

  /**
   * Rename / close / reopen an account. Sane default (noted in the API doc):
   * closing is allowed ONLY at zero posted balance — a nonzero balance rejects
   * with `nonzero-balance` (move the balance with a transaction first).
   *
   * The balance check runs INSIDE the transaction, after the account row is
   * `FOR UPDATE`-locked (LGR-3 F9): computing it beforehand was a check-then-act
   * race against a concurrent post — both operations read a zero balance, then
   * one closed the account while the other posted into it, leaving a CLOSED
   * account holding a nonzero balance and breaking the invariant the check
   * exists to maintain. `validatePostable` takes `FOR SHARE` on the same rows,
   * so a post in flight blocks the close (and vice versa) rather than
   * interleaving with it.
   */
  async updateAccount(id: string, patch: LedgerAccountPatch, actor?: Principal): Promise<LedgerAccount> {
    const ids = await this.requireIds();
    if (patch.name !== undefined && !isValidLedgerAccountName(patch.name)) {
      throw new LedgerError('invalid-input', 'account name must be non-empty, colon-delimited segments');
    }
    if (patch.status !== undefined && !['open', 'closed'].includes(patch.status)) {
      throw new LedgerError('invalid-input', `invalid account status: ${JSON.stringify(patch.status)}`);
    }
    if (patch.evidenceRequired !== undefined && typeof patch.evidenceRequired !== 'boolean') {
      throw new LedgerError('invalid-input', `evidenceRequired must be a boolean, got ${typeof patch.evidenceRequired}`);
    }
    const account = await this.db.begin(async (tx) => {
      const rows = await tx.query<Row>(
        `SELECT ${ROW_COLS} FROM pages WHERE id = $1 AND database_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [id, ids.accounts],
      );
      if (rows.length === 0) throw new LedgerError('not-found', 'account not found');
      if (patch.status === 'closed') {
        const balance = await this.accountPostedBalanceOn(tx, ids, id);
        if (balance !== 0) {
          throw new LedgerError('nonzero-balance', `cannot close an account with a nonzero posted balance (${balance} minor units)`);
        }
      }
      const before = accountFromRow(rows[0]);
      const props = parseJson<Record<string, unknown>>(rows[0].properties, {});
      if (patch.status !== undefined) props[LEDGER_PROP.account.status] = patch.status;
      if (patch.evidenceRequired !== undefined) {
        // LGR-14, same one-representation rule as `createAccount`: `true` is
        // stored, `false` is the ABSENT key — so the content hash's
        // omit-while-false rule sees exactly one shape for "off".
        if (patch.evidenceRequired) props[LEDGER_PROP.account.evidenceRequired] = true;
        else delete props[LEDGER_PROP.account.evidenceRequired];
      }
      const updated = await tx.query<Row>(
        `UPDATE pages SET name = $3, properties = $4::jsonb, updated_at = now() WHERE id = $1 AND database_id = $2
         RETURNING ${ROW_COLS}`,
        [id, ids.accounts, patch.name ?? before.name, JSON.stringify(props)],
      );
      const after = accountFromRow(updated[0]);
      await this.appendAuditTx(
        tx,
        actor,
        'account.update',
        [id],
        {account: after},
        await sha256Hex(canonicalLedgerJson(accountContent(before))),
        await sha256Hex(canonicalLedgerJson(accountContent(after))),
      );
      return after;
    });
    this.notifyMutation();
    return account;
  }

  /** The account's POSTED balance in minor units (drafts excluded), summed exactly. */
  async accountPostedBalance(accountId: string): Promise<number> {
    const ids = await this.requireIds();
    return this.accountPostedBalanceOn(this.db, ids, accountId);
  }

  /** {@link accountPostedBalance} on a caller-supplied queryable, so the close
   *  path can compute it inside its own locked transaction. */
  private async accountPostedBalanceOn(q: Db, ids: LedgerIds, accountId: string): Promise<number> {
    const postings = await q.query<Row>(
      `SELECT ${ROW_COLS} FROM pages WHERE database_id = $1 AND deleted_at IS NULL AND properties->>'${LEDGER_PROP.posting.account}' = $2`,
      [ids.postings, accountId],
    );
    if (postings.length === 0) return 0;
    const txRows = await q.query<{id: string; properties: Record<string, unknown> | string | null}>(
      'SELECT id, properties FROM pages WHERE database_id = $1 AND deleted_at IS NULL',
      [ids.transactions],
    );
    const stateById = new Map<string, string>();
    for (const t of txRows) {
      stateById.set(t.id, str(parseJson<Record<string, unknown>>(t.properties, {})[LEDGER_PROP.transaction.state]));
    }
    const amounts: number[] = [];
    for (const p of postings) {
      const props = parseJson<Record<string, unknown>>(p.properties, {});
      const txId = str(props[LEDGER_PROP.posting.transaction]);
      const state = stateById.get(txId);
      // Posted AND void entries both count: a void original is offset exactly by
      // its posted reversal, so including both keeps the arithmetic honest.
      if (state !== 'posted' && state !== 'void') continue;
      const amount = props[LEDGER_PROP.posting.amount];
      if (!isValidMinor(amount)) throw new LedgerError('invalid-amount', `stored amount is not a safe integer: ${String(amount)}`);
      amounts.push(amount);
    }
    // A stored-state overflow must stay inside the typed ledger contract (F4):
    // an escaping MoneyRangeError became an HTTP 500 that permanently blocked
    // reads AND the close path for the affected account.
    return sumMinorOrThrow(amounts, 'account balance');
  }

  // ── Transactions ─────────────────────────────────────────────────────────────

  /**
   * Every live transaction with its postings attached, in the caller's chosen
   * transaction order. ONE place builds the tx↔postings join (the list read and
   * the canonical export both use it).
   *
   * Posting order is `(position, created_at, id)` — the trailing `id` is what
   * makes it a TOTAL order: `position` is assigned `MAX(position)+1`, which can
   * tie under READ COMMITTED on real Postgres, and `created_at` can tie inside
   * one transaction, so without it row order would be plan-dependent and the
   * export's "same data ⇒ identical bytes" guarantee could break on Postgres
   * while holding on PGlite.
   */
  private async loadTransactionsWithPostings(ids: LedgerIds, txOrderBy: string): Promise<LedgerTransaction[]> {
    const txRows = await this.db.query<Row>(
      `SELECT ${ROW_COLS} FROM pages WHERE database_id = $1 AND deleted_at IS NULL ${txOrderBy}`,
      [ids.transactions],
    );
    const postingRows = await this.db.query<Row>(
      `SELECT ${ROW_COLS} FROM pages WHERE database_id = $1 AND deleted_at IS NULL
       ORDER BY position ASC, created_at ASC, id ASC`,
      [ids.postings],
    );
    const postingsByTx = new Map<string, LedgerPosting[]>();
    for (const row of postingRows) {
      const posting = postingFromRow(row);
      const list = postingsByTx.get(posting.transactionId) ?? [];
      list.push(posting);
      postingsByTx.set(posting.transactionId, list);
    }
    return txRows.map((row) => transactionFromRow(row, postingsByTx.get(row.id) ?? []));
  }

  async listTransactions(opts: {state?: LedgerTransactionState; limit?: number} = {}): Promise<LedgerTransaction[]> {
    const ids = await this.requireIds();
    let out = await this.loadTransactionsWithPostings(ids, 'ORDER BY created_at DESC, id DESC');
    if (opts.state) out = out.filter((t) => t.state === opts.state);
    // The cap is the SDK's exported constant, not a literal: the ledger plugin's
    // reports compare their page size against the same value to decide whether
    // they read the whole book, and a drifting literal would let a truncated
    // read render as a complete total.
    const limit = Math.max(1, Math.min(LEDGER_MAX_TRANSACTION_LIMIT, Math.floor(opts.limit ?? LEDGER_DEFAULT_TRANSACTION_LIMIT)));
    return out.slice(0, limit);
  }

  async getTransaction(id: string): Promise<LedgerTransaction | null> {
    const ids = await this.requireIds();
    const rows = await this.db.query<Row>(
      `SELECT ${ROW_COLS} FROM pages WHERE id = $1 AND database_id = $2 AND deleted_at IS NULL`,
      [id, ids.transactions],
    );
    if (rows.length === 0) return null;
    const postings = await this.postingsForTx(this.db, ids, id);
    return transactionFromRow(rows[0], postings);
  }

  /**
   * Create a DRAFT transaction with its postings, atomically (one transaction:
   * tx row + N posting rows + the audit event). Amounts are validated as safe
   * signed integers ALREADY at draft time (typed rejection — an invalid amount
   * never even lands in a draft); balance/accounts are enforced at post.
   */
  async createDraft(input: LedgerDraftInput, actor?: Principal): Promise<LedgerTransaction> {
    const ids = await this.requireIds();
    if (!isValidLedgerDate(input.date)) {
      throw new LedgerError('invalid-input', `date must be an ISO YYYY-MM-DD date, got ${JSON.stringify(input.date)}`);
    }
    assertDescription(input.description);
    const postings = (input.postings ?? []).map((p) => validatePostingInput(p));
    if (postings.length > MAX_POSTINGS_PER_TRANSACTION) {
      throw new LedgerError(
        'invalid-input',
        `a journal entry may have at most ${MAX_POSTINGS_PER_TRANSACTION} postings, got ${postings.length}`,
      );
    }
    const evidenceInputs = validateEvidenceInputs(input.evidence);
    const txId = randomUUID();
    const created = await this.db.begin(async (tx) => {
      // Resolve BEFORE the row insert so a bad attachment rejects with nothing
      // written; the refs go in after the row exists (they FK onto it).
      const evidence = evidenceInputs ? await this.resolveEvidenceTx(tx, evidenceInputs) : [];
      const row = await this.insertRowTx(tx, ids.transactions, input.description ?? null, {
        [LEDGER_PROP.transaction.date]: input.date,
        [LEDGER_PROP.transaction.description]: input.description ?? '',
        [LEDGER_PROP.transaction.state]: 'draft',
        ...(evidence.length > 0 ? {[LEDGER_PROP.transaction.evidence]: evidence} : {}),
      }, txId);
      if (evidence.length > 0) await this.syncEvidenceRefsTx(tx, txId, evidence, []);
      const inserted = await this.insertPostingsTx(tx, ids, txId, postings);
      const transaction = transactionFromRow(row, inserted);
      await this.appendAuditTx(
        tx,
        actor,
        'transaction.create',
        [txId],
        {transaction},
        null,
        await sha256Hex(canonicalLedgerJson(transactionContent(transaction))),
      );
      return transaction;
    });
    this.notifyMutation();
    return created;
  }

  /**
   * Update a DRAFT (date / description / wholesale postings replacement).
   * Posted and void transactions are IMMUTABLE — typed `immutable` rejection.
   */
  async updateDraft(id: string, patch: LedgerDraftPatch, actor?: Principal): Promise<LedgerTransaction> {
    const ids = await this.requireIds();
    if (patch.date !== undefined && !isValidLedgerDate(patch.date)) {
      throw new LedgerError('invalid-input', `date must be an ISO YYYY-MM-DD date, got ${JSON.stringify(patch.date)}`);
    }
    assertDescription(patch.description);
    const replacement = patch.postings?.map((p) => validatePostingInput(p));
    if (replacement && replacement.length > MAX_POSTINGS_PER_TRANSACTION) {
      throw new LedgerError(
        'invalid-input',
        `a journal entry may have at most ${MAX_POSTINGS_PER_TRANSACTION} postings, got ${replacement.length}`,
      );
    }
    const evidenceReplacement = validateEvidenceInputs(patch.evidence);
    const updated = await this.db.begin(async (tx) => {
      const {row, props, before} = await this.lockDraftTx(tx, ids, id);
      if (patch.date !== undefined) props[LEDGER_PROP.transaction.date] = patch.date;
      if (patch.description !== undefined) props[LEDGER_PROP.transaction.description] = patch.description;
      if (evidenceReplacement !== undefined) {
        // Wholesale replacement, the `postings` contract (LGR-14). Sizes come
        // from the asset store inside this same transaction; refs on the tx row
        // page follow the manifest.
        const evidence = await this.resolveEvidenceTx(tx, evidenceReplacement);
        if (evidence.length > 0) props[LEDGER_PROP.transaction.evidence] = evidence;
        else delete props[LEDGER_PROP.transaction.evidence];
        await this.syncEvidenceRefsTx(tx, id, evidence, before.evidence);
      }
      const updated = await tx.query<Row>(
        `UPDATE pages SET name = $3, properties = $4::jsonb, updated_at = now() WHERE id = $1 AND database_id = $2
         RETURNING ${ROW_COLS}`,
        [id, ids.transactions, patch.description !== undefined ? patch.description : row.name, JSON.stringify(props)],
      );
      let postings: LedgerPosting[];
      if (replacement) {
        await tx.query(
          `DELETE FROM pages WHERE database_id = $1 AND properties->>'${LEDGER_PROP.posting.transaction}' = $2`,
          [ids.postings, id],
        );
        postings = await this.insertPostingsTx(tx, ids, id, replacement);
      } else {
        postings = await this.postingsForTx(tx, ids, id);
      }
      const transaction = transactionFromRow(updated[0], postings);
      await this.appendAuditTx(
        tx,
        actor,
        'transaction.update',
        [id],
        {transaction},
        await sha256Hex(canonicalLedgerJson(transactionContent(before))),
        await sha256Hex(canonicalLedgerJson(transactionContent(transaction))),
      );
      return transaction;
    });
    this.notifyMutation();
    return updated;
  }

  /**
   * Delete a DRAFT and its postings. Permanent (never via the trash — a restore
   * could resurrect rows behind the ledger's back) and audited. Posted/void
   * transactions reject with `immutable`.
   */
  async deleteDraft(id: string, actor?: Principal): Promise<boolean> {
    const ids = await this.requireIds();
    const deleted = await this.db.begin(async (tx) => {
      const {before} = await this.lockDraftTx(tx, ids, id);
      await tx.query(
        `DELETE FROM pages WHERE database_id = $1 AND properties->>'${LEDGER_PROP.posting.transaction}' = $2`,
        [ids.postings, id],
      );
      await tx.query('DELETE FROM pages WHERE id = $1 AND database_id = $2', [id, ids.transactions]);
      await this.appendAuditTx(
        tx,
        actor,
        'transaction.delete',
        [id],
        {transactionId: id},
        await sha256Hex(canonicalLedgerJson(transactionContent(before))),
        null,
      );
      return true;
    });
    this.notifyMutation();
    return deleted;
  }

  /**
   * POST a draft — the enforcement heart. ONE transaction validates every
   * invariant, assigns the monotonic entry number, stamps posted_at/posted_by
   * (set once, never mutated), snapshots the evidence manifest (LGR-14 — each
   * attached asset re-checked against the content-addressed store, sizes taken
   * from the store's own rows), and appends the audit event. Any failure rolls
   * the whole thing back.
   *
   * THE EVIDENCE GATE (LGR-14): when any posting's account has
   * `evidenceRequired` and the entry has no evidence attached, the post is
   * REJECTED (`evidence-required`) — enforced HERE, at the store layer, so
   * `LocalDataClient` (which bypasses HTTP entirely) is gated identically and
   * a block that forgot to disable its own button still cannot post. Only this
   * door is gated: a REVERSAL is exempt (its evidence IS the original entry's
   * — since F1 the manifest is literally carried onto the reversing entry, see
   * {@link reverse} — and demanding a fresh receipt to undo a mistake would
   * make required accounts uncorrectable), and server-generated closing
   * entries are derived arithmetic with no receipt to attach.
   *
   * PRESENCE-ONLY, by design (Sasha residual 1): the gate asserts that SOME
   * file was attached, not that it is a relevant one — that judgement is the
   * bookkeeper's, and no server check can make it. Read the manifest as "this
   * entry can answer with what was filed at post time", never as attestation
   * that the filing is correct.
   */
  async post(id: string, actor?: Principal): Promise<LedgerTransaction> {
    const ids = await this.requireIds();
    const posted = await this.db.begin(async (tx) => {
      const {props, before} = await this.lockDraftTx(tx, ids, id, 'post');
      const postings = await this.postingsForTx(tx, ids, id);
      const accounts = await this.validatePostable(tx, ids, postings);
      // LGR-14: the post-time SNAPSHOT. What was attached to the draft is
      // re-resolved against the asset store inside this transaction — an asset
      // that vanished since attach (only reachable by out-of-band surgery; the
      // manifest itself GC-protects the bytes) rejects the post rather than
      // freezing a manifest the store cannot honour. A plain read, no lock —
      // asset rows are content-addressed and immutable.
      const manifest = await this.resolveEvidenceTx(
        tx,
        before.evidence.map((e) => ({sha256: e.sha256, filename: e.filename})),
      ).catch((err) => {
        if (err instanceof LedgerError && err.code === 'not-found') {
          throw new LedgerError(
            'invalid-state',
            `${err.message} — the attached file is gone from the asset store; detach it or re-upload it, then post`,
          );
        }
        throw err;
      });
      if (manifest.length === 0) {
        const required = [...new Set(postings.map((p) => p.accountId))]
          .map((accountId) => accounts.get(accountId))
          .filter((a): a is LedgerAccount => a !== undefined && a.evidenceRequired);
        if (required.length > 0) {
          const names = required.map((a) => a.name).join(', ');
          const subject = required.length === 1 ? `account ${names} requires` : `accounts ${names} require`;
          const object = required.length === 1 ? 'the account' : 'those accounts';
          throw new LedgerError(
            'evidence-required',
            `${subject} evidence — attach a receipt (or other supporting file) to this entry before posting, or turn off "evidence required" on ${object}`,
          );
        }
      }
      // LGR-12: the entry's DATE must not fall inside a closed period. After
      // the account locks and before the entry-number sequence — the periods
      // row sits at the `settings` slot of the lock order, ahead of
      // `ledgerEntrySeq` (see `readPeriodsOn`).
      await this.assertDateInOpenPeriodTx(tx, str(props[LEDGER_PROP.transaction.date]), 'post');
      const entryNo = await this.nextEntryNumberTx(tx);
      props[LEDGER_PROP.transaction.state] = 'posted';
      props[LEDGER_PROP.transaction.postedAt] = new Date().toISOString();
      props[LEDGER_PROP.transaction.postedBy] = actor?.subject ?? '';
      props[LEDGER_PROP.transaction.entryNo] = entryNo;
      // The manifest recorded at post (LGR-14): frozen with the entry from here
      // on — it is inside `transactionContent`, so inside the audit hashes.
      props[LEDGER_PROP.transaction.evidence] = manifest;
      const updated = await tx.query<Row>(
        `UPDATE pages SET properties = $3::jsonb, updated_at = now() WHERE id = $1 AND database_id = $2 RETURNING ${ROW_COLS}`,
        [id, ids.transactions, JSON.stringify(props)],
      );
      const transaction = transactionFromRow(updated[0], postings);
      await this.appendAuditTx(
        tx,
        actor,
        'transaction.post',
        [id],
        {transaction},
        await sha256Hex(canonicalLedgerJson(transactionContent(before))),
        await sha256Hex(canonicalLedgerJson(transactionContent(transaction))),
      );
      return transaction;
    });
    this.notifyMutation();
    return posted;
  }

  /**
   * REVERSE a posted transaction: atomically create AND post the reversing
   * entry (postings negated, `reverses` linked, its own entry number, the
   * ORIGINAL'S EVIDENCE MANIFEST carried verbatim — LGR-14 F1, see the inline
   * comment) and flip the original to `void` — the only sanctioned mutation of
   * a posted entry, and the only way to void one. Exactly ONE audit event
   * covers the pair.
   *
   * A reversal touching a CLOSED account is REJECTED (`account-closed`); reopen
   * the account first. The reversing entry is a real posting like any other, and
   * "closed ⇒ zero balance" is only a true invariant if nothing can post into a
   * closed account — a reversal admitted through the back door would leave a
   * closed account holding a balance, which is exactly the state the close rule
   * exists to prevent. Reopening is a one-call, audited step.
   */
  async reverse(id: string, opts: LedgerReverseOptions = {}, actor?: Principal): Promise<LedgerTransaction> {
    const ids = await this.requireIds();
    if (opts.date !== undefined && !isValidLedgerDate(opts.date)) {
      throw new LedgerError('invalid-input', `date must be an ISO YYYY-MM-DD date, got ${JSON.stringify(opts.date)}`);
    }
    assertDescription(opts.description);
    const reversal = await this.db.begin(async (tx) => {
      const rows = await tx.query<Row>(
        `SELECT ${ROW_COLS} FROM pages WHERE id = $1 AND database_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [id, ids.transactions],
      );
      if (rows.length === 0) throw new LedgerError('not-found', 'transaction not found');
      const originalProps = parseJson<Record<string, unknown>>(rows[0].properties, {});
      const originalState = str(originalProps[LEDGER_PROP.transaction.state]);
      if (originalState !== 'posted') {
        throw new LedgerError('invalid-state', `only a posted transaction can be reversed (state: ${originalState || 'unknown'})`);
      }
      const originalPostings = await this.postingsForTx(tx, ids, id);
      const original = transactionFromRow(rows[0], originalPostings);
      // LGR-12: a CLOSING entry is not reversible through this door. Voiding it
      // is exactly what `reopenPeriod` does — inside the same transaction that
      // unlocks the range and updates the period record. A direct reversal
      // would leave a period claiming "closed, by entry X" over a void X.
      if (original.kind === 'closing') {
        throw new LedgerError(
          'invalid-state',
          `transaction ${id} is a period-closing entry — it is voided by reopening its period, not by a direct reversal`,
        );
      }
      const beforeHash = await sha256Hex(canonicalLedgerJson(transactionContent(original)));

      // The reversing leg carries the ORIGINAL leg's memo (LGR-16): a reversal
      // is the correction of a specific leg, and "gross wages" is what makes it
      // legible next to the entry it undoes. Nothing is invented — an original
      // with no memo reverses to no memo.
      const negated = originalPostings.map((p) => ({
        accountId: p.accountId,
        amountMinor: p.amountMinor === 0 ? 0 : -p.amountMinor,
        cleared: 'pending' as const,
        memo: p.memo,
      }));
      // The reversing entry is posted, so it satisfies EVERY posting invariant —
      // including open accounts (see the docstring: a reversal must not be a back
      // door into a closed account) and uniform currency.
      await this.validatePostable(tx, ids, negated.map((p, i) => ({
        id: `reversal-${i}`,
        transactionId: '',
        accountId: p.accountId,
        amountMinor: p.amountMinor,
        cleared: 'pending' as const,
        reconciliationId: null,
        memo: p.memo,
      })));

      // LGR-12 (the LGR-6 hook, now real): the REVERSAL is itself a dated entry
      // on the books, so its date must not fall inside a closed period either —
      // the default date is the ORIGINAL's, which is exactly where a closed
      // period is most likely to catch it. Same guard, same slot as `post`.
      await this.assertDateInOpenPeriodTx(tx, opts.date ?? original.date, 'reverse');

      const reversingId = randomUUID();
      const entryNo = await this.nextEntryNumberTx(tx);
      const description = opts.description ?? `Reversal of ${original.description || original.id}`;
      const reversingRow = await this.insertRowTx(tx, ids.transactions, description, {
        [LEDGER_PROP.transaction.date]: opts.date ?? original.date,
        [LEDGER_PROP.transaction.description]: description,
        [LEDGER_PROP.transaction.state]: 'posted',
        [LEDGER_PROP.transaction.postedAt]: new Date().toISOString(),
        [LEDGER_PROP.transaction.postedBy]: actor?.subject ?? '',
        [LEDGER_PROP.transaction.reverses]: id,
        [LEDGER_PROP.transaction.entryNo]: entryNo,
        // LGR-14 F1: the reversal CARRIES the original's manifest, verbatim.
        // "A reversal's evidence is the original entry it undoes" was already
        // this module's stated justification for exempting reversals from the
        // evidence gate — carrying the manifest makes that literal, and it
        // closes the laundering hatch: reverse E, then reverse the reversal,
        // and the live entry (E's legs re-enacted) would otherwise end bare —
        // clean badge, clean CSV, clean verifier — with no SQL touched. With
        // carry-forward every entry in a reversal CHAIN answers with the same
        // receipts as the entry that started it (idempotent under double
        // reversal). Copied, NOT re-resolved: this is the original's frozen
        // record — sizes included — not a fresh attestation, and re-checking
        // the store here would let the very tampering the verifier exists to
        // catch block the correction workflow too.
        [LEDGER_PROP.transaction.evidence]: original.evidence,
      }, reversingId);
      // Ref the carried assets to the reversal row too (read-gate + GC follow
      // the manifest wherever it lives). Only the assets the store still holds:
      // a missing one is verifier territory, and an FK failure here would turn
      // a tampered receipt into an unreversible entry.
      if (original.evidence.length > 0) {
        const present = await tx.query<{id: string}>(
          'SELECT id FROM assets WHERE id = ANY($1)',
          [original.evidence.map((e) => e.sha256)],
        );
        await this.syncEvidenceRefsTx(tx, reversingId, original.evidence.filter((e) => present.some((r) => r.id === e.sha256)), []);
      }
      const reversingPostings = await this.insertPostingsTx(tx, ids, reversingId, negated);
      // Void the original — its financial content (postings, amounts, entry
      // number, posted_at/by) never changes; only the state flips.
      originalProps[LEDGER_PROP.transaction.state] = 'void';
      await tx.query(
        'UPDATE pages SET properties = $3::jsonb, updated_at = now() WHERE id = $1 AND database_id = $2',
        [id, ids.transactions, JSON.stringify(originalProps)],
      );
      const transaction = transactionFromRow(reversingRow, reversingPostings);
      await this.appendAuditTx(
        tx,
        actor,
        'transaction.reverse',
        [reversingId, id],
        {transaction, originalId: id, originalState: 'void'},
        beforeHash,
        await sha256Hex(canonicalLedgerJson(transactionContent(transaction))),
      );
      return transaction;
    });
    this.notifyMutation();
    return reversal;
  }

  // ── Postings (cleared-state workflow + the LGR-11 reconciliation hook) ───────

  async getPosting(id: string): Promise<LedgerPosting | null> {
    const ids = await this.requireIds();
    const rows = await this.db.query<Row>(
      `SELECT ${ROW_COLS} FROM pages WHERE id = $1 AND database_id = $2 AND deleted_at IS NULL`,
      [id, ids.postings],
    );
    return rows.length > 0 ? postingFromRow(rows[0]) : null;
  }

  /**
   * Change a posting's cleared state — the generic `pending ↔ cleared` workflow
   * flip. Cleared state is workflow metadata, so it stays mutable on a posted
   * transaction (the financial content does not).
   *
   * `reconciled` is UNREACHABLE from here, in either direction. It is reached
   * only by {@link finishReconciliation} and left only by
   * {@link reopenReconciliation} — invariant 4, with no escape hatch.
   *
   * (LGR-3 shipped this guard with a `via: 'reconciliation'` opt-out, expecting
   * LGR-11 to call it per posting. LGR-11 does not: a freeze writes ONE audit
   * event covering its whole set, so it goes through the shared
   * {@link writePostingClearedTx} writer instead. That left `via` as a
   * parameter no product code passed and any caller could — an unaudited way to
   * unfreeze a reconciled posting. It is gone.)
   *
   * A leg on a DRAFT entry is rejected too: "has it cleared the bank" is not a
   * meaningful question about an entry that is not on the books. A draft may
   * still be BORN `cleared` through {@link LedgerPostingInput} — that is how the
   * bank import carries a statement line's settled state into the entry it
   * creates — but it cannot be flipped afterwards.
   */
  async setPostingCleared(
    id: string,
    cleared: LedgerClearedState,
    actor?: Principal,
  ): Promise<LedgerPosting> {
    const ids = await this.requireIds();
    if (!['pending', 'cleared', 'reconciled'].includes(cleared)) {
      throw new LedgerError('invalid-input', `invalid cleared state: ${JSON.stringify(cleared)}`);
    }
    const changed = await this.db.begin(async (tx) => {
      const rows = await tx.query<Row>(
        `SELECT ${ROW_COLS} FROM pages WHERE id = $1 AND database_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [id, ids.postings],
      );
      if (rows.length === 0) throw new LedgerError('not-found', 'posting not found');
      const existing = postingFromRow(rows[0]);
      const current = existing.cleared;
      if (current === 'reconciled' || cleared === 'reconciled') {
        throw new LedgerError(
          'reconciled-locked',
          'a reconciled posting can only change cleared state through a reconciliation finish or reopen (LGR-11)',
        );
      }
      const state = await this.entryStateOn(tx, ids, existing.transactionId);
      if (state !== 'posted' && state !== 'void') {
        throw new LedgerError(
          'posting-not-reconcilable',
          `posting ${id} belongs to a ${state ?? 'missing'} entry — cleared state is a question about money that has reached the books`,
        );
      }
      const posting = postingFromRow(await this.writePostingClearedTx(tx, ids, rows[0], cleared, existing.reconciliationId));
      await this.appendAuditTx(
        tx,
        actor,
        'posting.cleared',
        [id, posting.transactionId],
        {postingId: id, transactionId: posting.transactionId, cleared},
        await sha256Hex(canonicalLedgerJson({id, cleared: current})),
        await sha256Hex(canonicalLedgerJson({id, cleared})),
      );
      return posting;
    });
    this.notifyMutation();
    return changed;
  }

  // ── Statement reconciliation (LGR-11) ────────────────────────────────────────
  //
  // The workflow that catches what an import missed, doubled, or fat-fingered:
  // match the account's postings against a bank statement until
  //
  //     statement balance − cleared balance = 0
  //
  // and only then FINISH, which freezes the matched postings at `reconciled`
  // (invariant 4 — the only writers that may reach it) and stamps them with the
  // reconciliation's id. Reopening is explicit and audited and unfreezes them.
  //
  // THE GATE LIVES HERE, not in the UI. `finish` recomputes the difference from
  // storage INSIDE its own transaction, holding the reconciliation row and every
  // one of the account's posting rows — so a toggle that lands between a
  // client's read and its finish makes the finish REJECT rather than commit a
  // reconciliation that was never actually balanced. A client that bypasses the
  // block entirely gets exactly the same answer.

  /** Reconciliations, newest statement first. Filters are ANDed. */
  async listReconciliations(opts: {accountId?: string; status?: LedgerReconciliationStatus} = {}): Promise<LedgerReconciliation[]> {
    const ids = await this.requireIds();
    const rows = await this.db.query<Row>(
      `SELECT ${ROW_COLS} FROM pages WHERE database_id = $1 AND deleted_at IS NULL`,
      [ids.reconciliations],
    );
    let out = rows.map(reconciliationFromRow);
    if (opts.accountId !== undefined) out = out.filter((r) => r.accountId === opts.accountId);
    if (opts.status !== undefined) out = out.filter((r) => r.status === opts.status);
    // A TOTAL order: statement date, then creation, then id — two statements
    // recorded on the same day must not swap between reads.
    return out.sort((a, b) => {
      if (a.statementDate !== b.statementDate) return a.statementDate < b.statementDate ? 1 : -1;
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
  }

  /** One reconciliation with its LIVE arithmetic, or `null` when it is unknown. */
  async getReconciliation(id: string): Promise<LedgerReconciliationSummary | null> {
    const ids = await this.requireIds();
    const rows = await this.db.query<Row>(
      `SELECT ${ROW_COLS} FROM pages WHERE id = $1 AND database_id = $2 AND deleted_at IS NULL`,
      [id, ids.reconciliations],
    );
    if (rows.length === 0) return null;
    return this.summarizeOn(this.db, ids, reconciliationFromRow(rows[0]));
  }

  /**
   * START a reconciliation: an account, the statement's closing date, and its
   * closing balance in debit-positive minor units.
   *
   * A second OPEN reconciliation on the same account is REJECTED
   * (`reconciliation-exists`). Two open matches against one account cannot both
   * be true — they would share the same `cleared` postings, so finishing either
   * one would silently freeze postings the other was still counting, and the
   * loser's difference would move without anyone touching it. The check runs
   * inside the transaction with the ACCOUNT row locked `FOR UPDATE`, because
   * check-then-act on an unlocked read lets two concurrent starts both find
   * nothing open and both insert.
   */
  async startReconciliation(input: LedgerReconciliationInput, actor?: Principal): Promise<LedgerReconciliation> {
    const ids = await this.requireIds();
    if (typeof input?.accountId !== 'string' || input.accountId.trim() === '') {
      throw new LedgerError('invalid-input', 'a reconciliation needs an accountId');
    }
    if (!isValidLedgerDate(input.statementDate)) {
      throw new LedgerError('invalid-input', `statementDate must be an ISO YYYY-MM-DD date, got ${JSON.stringify(input.statementDate)}`);
    }
    if (!isValidMinor(input.statementBalanceMinor)) {
      throw new LedgerError(
        'invalid-amount',
        `statementBalanceMinor must be a safe signed integer of minor units, got ${String(input.statementBalanceMinor)}`,
      );
    }
    const id = randomUUID();
    const created = await this.db.begin(async (tx) => {
      const account = await this.lockAccountTx(tx, ids, input.accountId);
      const open = await this.openReconciliationOn(tx, ids, input.accountId);
      if (open) {
        throw new LedgerError(
          'reconciliation-exists',
          `account ${account.name} already has an open reconciliation (${open.id}, statement ${open.statementDate}) — finish or reopen that one first`,
        );
      }
      // NO cap probe here, deliberately — see {@link MAX_RECONCILIATION_POSTINGS}.
      // The cap is on the set `finish`/`reopen` WRITE, not on how many postings
      // the account happens to hold, because every long-lived current account
      // outgrows any fixed bound: barring `start` on cardinality would make
      // reconciliation permanently unavailable on exactly the accounts that
      // need it most. It also kept `start` walking the postings and their
      // parent entries while already holding the ACCOUNT row, which is the
      // lock-order inversion that deadlocked against `post`.
      const row = await this.insertRowTx(tx, ids.reconciliations, null, {
        [LEDGER_PROP.reconciliation.account]: input.accountId,
        [LEDGER_PROP.reconciliation.statementDate]: input.statementDate,
        [LEDGER_PROP.reconciliation.statementBalance]: input.statementBalanceMinor,
        [LEDGER_PROP.reconciliation.status]: 'open',
      }, id);
      const reconciliation = reconciliationFromRow(row);
      await this.appendAuditTx(
        tx,
        actor,
        'reconciliation.start',
        [id, input.accountId],
        {reconciliation},
        null,
        await sha256Hex(canonicalLedgerJson(reconciliationContent(reconciliation))),
      );
      return reconciliation;
    });
    this.notifyMutation();
    return created;
  }

  /**
   * Match (`cleared`) or unmatch (`pending`) ONE posting inside an OPEN
   * reconciliation — the checklist tick.
   *
   * This is deliberately NOT {@link setPostingCleared} with extra arguments: the
   * generic surface is an account-agnostic workflow flip, whereas a tick inside
   * a reconciliation additionally asserts that the posting is on THIS
   * reconciliation's account and is a real posted leg. Rejections:
   *  - the reconciliation is finished → `invalid-state` (reopen it first);
   *  - the posting is on another account → `posting-not-reconcilable`;
   *  - the posting belongs to a DRAFT entry → `posting-not-reconcilable` (a
   *    draft is not on the books, so it cannot be on a statement either);
   *  - the posting is already `reconciled` → `reconciled-locked`. By
   *    construction that means a DIFFERENT, finished reconciliation owns it:
   *    this call requires an open reconciliation, and finishing is the only
   *    thing that freezes. Its own reconciliation's id is named so the caller
   *    knows which statement to reopen.
   */
  async setReconciliationPostingCleared(
    reconciliationId: string,
    postingId: string,
    cleared: 'pending' | 'cleared',
    actor?: Principal,
  ): Promise<LedgerReconciliationSummary> {
    const ids = await this.requireIds();
    if (cleared !== 'pending' && cleared !== 'cleared') {
      throw new LedgerError(
        'invalid-input',
        `a reconciliation tick is pending or cleared, got ${JSON.stringify(cleared)} (reconciled is reached by finishing, never by ticking)`,
      );
    }
    const summary = await this.db.begin(async (tx) => {
      const {reconciliation} = await this.lockReconciliationTx(tx, ids, reconciliationId, 'open');
      const rows = await tx.query<Row>(
        `SELECT ${ROW_COLS} FROM pages WHERE id = $1 AND database_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [postingId, ids.postings],
      );
      if (rows.length === 0) throw new LedgerError('not-found', 'posting not found');
      const posting = postingFromRow(rows[0]);
      if (posting.accountId !== reconciliation.accountId) {
        throw new LedgerError(
          'posting-not-reconcilable',
          `posting ${postingId} is on another account — a reconciliation only matches postings on ${reconciliation.accountId}`,
        );
      }
      const state = await this.entryStateOn(tx, ids, posting.transactionId);
      if (state !== 'posted' && state !== 'void') {
        throw new LedgerError(
          'posting-not-reconcilable',
          `posting ${postingId} belongs to a ${state ?? 'missing'} entry — only an entry that has reached the books (posted, or voided by a reversal) can appear on a statement`,
        );
      }
      const current = posting.cleared;
      if (current === 'reconciled') {
        throw new LedgerError(
          'reconciled-locked',
          `posting ${postingId} is frozen by finished reconciliation ${posting.reconciliationId ?? '(unknown)'} — reopen that reconciliation to change it`,
        );
      }
      if (current !== cleared) {
        // A tick never touches `reconciliationId`: it is an OPEN match, and
        // only `finish` stamps ownership.
        await this.writePostingClearedTx(tx, ids, rows[0], cleared, posting.reconciliationId);
        // The SAME action the generic flip records, so the replay reducer and
        // the verifier need no new case for a tick: it is the same state change,
        // reached through a narrower door. The reconciliation id rides along in
        // the payload so the trail says which statement the tick belonged to.
        await this.appendAuditTx(
          tx,
          actor,
          'posting.cleared',
          [postingId, posting.transactionId, reconciliationId],
          {postingId, transactionId: posting.transactionId, cleared, reconciliationId},
          await sha256Hex(canonicalLedgerJson({id: postingId, cleared: current})),
          await sha256Hex(canonicalLedgerJson({id: postingId, cleared})),
        );
      }
      return this.summarizeOn(tx, ids, reconciliation);
    });
    this.notifyMutation();
    return summary;
  }

  /**
   * FINISH a reconciliation — allowed ONLY at a difference of exactly zero.
   *
   * The difference is recomputed here, from storage, inside this transaction,
   * with the reconciliation row and every one of the account's posting rows
   * locked `FOR UPDATE`. That is what makes the zero real rather than reported:
   * a caller cannot hand in a difference, and a concurrent tick either lands
   * before this transaction (and is counted) or blocks until it commits.
   *
   * On success every posting currently ticked `cleared` freezes at `reconciled`
   * carrying this reconciliation's id. Postings already `reconciled` under an
   * EARLIER statement are left exactly as they are — they still count towards
   * the cleared balance (they are cleared money), but they belong to the
   * reconciliation that froze them and only its reopen may release them.
   */
  async finishReconciliation(id: string, actor?: Principal): Promise<LedgerReconciliationSummary> {
    const ids = await this.requireIds();
    const summary = await this.db.begin(async (tx) => {
      const {reconciliation: before, row} = await this.lockReconciliationTx(tx, ids, id, 'open');
      const postings = await this.loadAccountPostingsOn(tx, ids, before.accountId, 'write');
      const {summary: current, matched} = this.reconcileState(before, postings);
      // EXACTLY the rows that were counted, never a re-derived superset (see
      // `reconcileState`). Rows already `reconciled` under an earlier statement
      // are counted but belong to that statement, so they are left alone.
      const toFreeze = matched.filter(({posting}) => posting.cleared === 'cleared');
      // CAPACITY before BALANCE: "this statement matched more postings than one
      // audit row may carry" is true whatever the difference reads, and the
      // remedy (untick some rows) differs from the remedy for an imbalance.
      this.assertWritableSet(toFreeze.length, 'finish');
      if (current.differenceMinor !== 0) {
        throw new LedgerError(
          'reconciliation-unbalanced',
          `a reconciliation can only be finished at a difference of exactly 0.00 — this one is out by ${current.differenceMinor} minor units (statement ${before.statementBalanceMinor}, cleared ${current.clearedBalanceMinor})`,
        );
      }
      const changes: LedgerReconciliationPostingChange[] = [];
      for (const {posting} of toFreeze) {
        await this.writePostingClearedTx(tx, ids, posting.row, 'reconciled', id);
        changes.push({postingId: posting.id, transactionId: posting.transactionId, cleared: 'reconciled', reconciliationId: id});
      }
      const after = await this.setReconciliationStatusTx(tx, ids, {id, row}, 'finished');
      // ONE event for the whole freeze — the `transaction.reverse` precedent:
      // the reconciliation's new status and every posting it froze commit
      // together, so the audit log must record them together too.
      await this.appendAuditTx(
        tx,
        actor,
        'reconciliation.finish',
        [id, before.accountId],
        {reconciliation: after, postings: changes},
        await sha256Hex(canonicalLedgerJson(reconciliationContent(before))),
        await sha256Hex(canonicalLedgerJson(reconciliationContent(after))),
      );
      return this.summarizeOn(tx, ids, after);
    });
    this.notifyMutation();
    return summary;
  }

  /**
   * AMEND an OPEN reconciliation's statement (LGR-22): a new closing date, a new
   * closing balance, or both. The difference is recomputed against the new
   * target and returned.
   *
   * THIS IS THE RECOVERY PATH FOR A MISTYPED TARGET, and without it the account
   * was bricked: `finish` demands a difference of exactly zero, a wrong target
   * cannot reach zero at any tick, `reopen` applies only to a FINISHED
   * reconciliation, and `start` refuses a second open one. The only remaining
   * exits were posting a fake entry to force the difference to zero — corrupting
   * the books to escape a dead end — or editing the database by hand.
   *
   * IT TOUCHES NO POSTING, in either direction. The ticks already made are
   * observations about the bank ("this leg is on the statement"), and correcting
   * a typo in the target does not un-observe any of them — which is also what
   * makes this the cheap fix rather than the expensive one: the checklist
   * survives. `finishReconciliation` remains the only writer that can reach
   * `reconciled` (invariant 4), and it is untouched by this.
   *
   * LOCKS: the reconciliation row and nothing else. The account is not locked
   * because the identity of the open reconciliation on it does not change (a
   * `start` racing this one still finds this row open and is still rejected),
   * and the postings are not locked because none are read or written — so this
   * writer sits at the head of the RECONCILIATION → POSTING → TRANSACTION →
   * ACCOUNT order and can deadlock against nothing.
   */
  async amendReconciliation(
    id: string,
    patch: LedgerReconciliationPatch,
    actor?: Principal,
  ): Promise<LedgerReconciliationSummary> {
    const ids = await this.requireIds();
    const hasDate = patch?.statementDate !== undefined;
    const hasBalance = patch?.statementBalanceMinor !== undefined;
    if (!hasDate && !hasBalance) {
      throw new LedgerError(
        'invalid-input',
        'an amend must change the statement date, the statement balance, or both — an empty patch would write an audit event for a mutation that never happened',
      );
    }
    // Validated with the SAME predicates `start` uses, and deliberately so: a
    // date or a balance that could not have been started with must not be
    // reachable by amending into it.
    if (hasDate && !isValidLedgerDate(patch.statementDate)) {
      throw new LedgerError('invalid-input', `statementDate must be an ISO YYYY-MM-DD date, got ${JSON.stringify(patch.statementDate)}`);
    }
    if (hasBalance && !isValidMinor(patch.statementBalanceMinor)) {
      throw new LedgerError(
        'invalid-amount',
        `statementBalanceMinor must be a safe signed integer of minor units, got ${String(patch.statementBalanceMinor)}`,
      );
    }
    const summary = await this.db.begin(async (tx) => {
      const {reconciliation: before, row} = await this.lockReconciliationTx(tx, ids, id, 'open');
      const props = parseJson<Record<string, unknown>>(row.properties, {});
      if (hasDate) props[LEDGER_PROP.reconciliation.statementDate] = patch.statementDate;
      if (hasBalance) props[LEDGER_PROP.reconciliation.statementBalance] = patch.statementBalanceMinor;
      const updated = await tx.query<Row>(
        `UPDATE pages SET properties = $3::jsonb, updated_at = now() WHERE id = $1 AND database_id = $2 RETURNING ${ROW_COLS}`,
        [id, ids.reconciliations, JSON.stringify(props)],
      );
      const after = reconciliationFromRow(updated[0]);
      await this.appendAuditTx(
        tx,
        actor,
        'reconciliation.amend',
        [id, before.accountId],
        {reconciliation: after},
        await sha256Hex(canonicalLedgerJson(reconciliationContent(before))),
        await sha256Hex(canonicalLedgerJson(reconciliationContent(after))),
      );
      return this.summarizeOn(tx, ids, after);
    });
    this.notifyMutation();
    return summary;
  }

  /**
   * ABANDON an OPEN reconciliation (LGR-22): end it without balancing it.
   *
   * A STATUS TRANSITION, NOT A DELETE. The attempt happened; a book that simply
   * loses the row cannot tell a later reader (or an auditor) the difference
   * between "this account has never been reconciled" and "someone tried, could
   * not make it agree, and gave up" — and the second is the one worth knowing
   * about. The audit log would carry the abandonment either way, but the LIST
   * a bookkeeper actually reads is the reconciliations, not the audit stream.
   *
   * TERMINAL. `abandoned` is not reopenable: reopening exists to unfreeze what a
   * finish froze, and an abandoned reconciliation froze nothing. Resuming an
   * abandoned match is `start`, which is now unblocked — `openReconciliationOn`
   * asks for `open`, so the account is free the moment this commits.
   *
   * POSTING-NEUTRAL, which is the requirement that makes it safe to offer at
   * all: not one posting's `cleared` state or `reconciliationId` is read or
   * written here. An open reconciliation owns no frozen postings by construction
   * (only `finish` stamps ownership), so there is nothing to release, and the
   * ticks stay exactly as the user left them — ready for the next statement.
   */
  async abandonReconciliation(id: string, actor?: Principal): Promise<LedgerReconciliation> {
    const ids = await this.requireIds();
    const abandoned = await this.db.begin(async (tx) => {
      const {reconciliation: before, row} = await this.lockReconciliationTx(tx, ids, id, 'open');
      const after = await this.setReconciliationStatusTx(tx, ids, {id, row}, 'abandoned');
      await this.appendAuditTx(
        tx,
        actor,
        'reconciliation.abandon',
        [id, before.accountId],
        {reconciliation: after},
        await sha256Hex(canonicalLedgerJson(reconciliationContent(before))),
        await sha256Hex(canonicalLedgerJson(reconciliationContent(after))),
      );
      return after;
    });
    this.notifyMutation();
    return abandoned;
  }

  /**
   * REOPEN a finished reconciliation: explicit, audited, and the ONLY thing that
   * unfreezes what it froze. Its postings go back to `cleared` (they did match
   * the statement — reopening reverses the freeze, not the match) with their
   * `reconciliationId` cleared.
   *
   * Rejected while ANOTHER reconciliation on the same account is open
   * (`reconciliation-exists`), for the same reason `start` is: two open matches
   * against one account cannot both be the truth.
   */
  async reopenReconciliation(id: string, actor?: Principal): Promise<LedgerReconciliationSummary> {
    const ids = await this.requireIds();
    const summary = await this.db.begin(async (tx) => {
      const {reconciliation: before, row} = await this.lockReconciliationTx(tx, ids, id, 'finished');
      // POSTINGS + their entries BEFORE the account row. Reopening creates an
      // open reconciliation, so it owes `start`'s serialization — but taking the
      // ACCOUNT row first inverted the lock order against `post`, which holds a
      // transaction row and waits on the account. Acquiring the account LAST
      // keeps RECONCILIATION → POSTING → TRANSACTION → ACCOUNT → advisory, and
      // the one-open-per-account check still runs holding the account row, so
      // nothing about F2's serialization changes.
      const postings = await this.loadAccountPostingsOn(tx, ids, before.accountId, 'write');
      const owned = postings.filter(({posting}) => posting.reconciliationId === id);
      // Defensive: `finish` already refused to freeze more than the cap, so a
      // set larger than it can only come from a raw-SQL edit or a book written
      // before the cap existed. Refusing is still better than writing an audit
      // row of unbounded size.
      this.assertWritableSet(owned.length, 'reopen');
      await this.lockAccountTx(tx, ids, before.accountId);
      const other = await this.openReconciliationOn(tx, ids, before.accountId);
      if (other) {
        throw new LedgerError(
          'reconciliation-exists',
          `reconciliation ${other.id} (statement ${other.statementDate}) is already open on this account — finish it before reopening an earlier statement`,
        );
      }
      const changes: LedgerReconciliationPostingChange[] = [];
      for (const {posting} of owned) {
        await this.writePostingClearedTx(tx, ids, posting.row, 'cleared', null);
        changes.push({postingId: posting.id, transactionId: posting.transactionId, cleared: 'cleared', reconciliationId: null});
      }
      const after = await this.setReconciliationStatusTx(tx, ids, {id, row}, 'open');
      await this.appendAuditTx(
        tx,
        actor,
        'reconciliation.reopen',
        [id, before.accountId],
        {reconciliation: after, postings: changes},
        await sha256Hex(canonicalLedgerJson(reconciliationContent(before))),
        await sha256Hex(canonicalLedgerJson(reconciliationContent(after))),
      );
      return this.summarizeOn(tx, ids, after);
    });
    this.notifyMutation();
    return summary;
  }

  // ── Period close (LGR-12) ────────────────────────────────────────────────────
  //
  // Closing a period does three things in ONE transaction: posts the closing
  // entry (income-statement balances → retained earnings) through the ordinary
  // posting machinery, records the period, and LOCKS the range — from that
  // commit on, `post` and `reverse` reject `period-closed` for any entry DATED
  // inside it. Reopening is the explicit, audited inverse: it voids the closing
  // entry via the ordinary reversal machinery and unlocks the range, keeping
  // the period record as history.
  //
  // THE GATE LIVES HERE, not in the UI (the reconciliation-finish precedent): a
  // client that bypasses every block still posts through this store, and the
  // date check runs inside the posting transaction holding the periods row.

  /** Every period record — closed and reopened history, oldest range first. */
  async listPeriods(): Promise<LedgerPeriod[]> {
    await this.requireIds();
    return this.readPeriodsOn(this.db, 'none');
  }

  /**
   * CLOSE a period: generate the closing entry, record the period, lock the
   * range. Open reconciliations dated inside the close are a WARNING carried in
   * the result — never a gate (a bookkeeper may close a quarter while a
   * statement is still being matched; the notice names what is unfinished).
   *
   * THE CLOSING ENTRY IS A REAL LEDGER TRANSACTION: inserted through the same
   * row writers `reverse` uses, validated by `validatePostable`, carrying its
   * own monotonic entry number — so it survives `verifyLedger`, appears in
   * registers and exports, and is reversible by the ordinary reversal machinery
   * (which is exactly how `reopenPeriod` voids it). Its amounts sweep each
   * income-statement account's CUMULATIVE posted balance as of `end` — not just
   * the range's activity — because prior closes already zeroed prior activity,
   * and "the flow accounts read zero the day after a close" must hold on a book
   * whose first close does not start at its first entry. That claim is only
   * unconditional because closes are ENFORCED chronological: a close whose
   * `end` precedes an already-closed period's `end` rejects
   * `period-out-of-order` (see the check below for the double-sweep it
   * prevents).
   *
   * CONCURRENCY (the order-compliant shape — see `loadAccountPostingsOn` for
   * the lock graph): the balances are computed on an UNLOCKED read first, the
   * closing legs validated (ACCOUNT `FOR SHARE`), and only then is the periods
   * settings row taken `FOR UPDATE` — at which point the balances are
   * RECOMPUTED. A posting that committed in between makes the two computations
   * differ and the close rejects `period-close-conflict` (retry against the
   * settled book); a posting still in flight blocks on its own `FOR SHARE` of
   * the periods row, re-reads after this commit, and rejects `period-closed`.
   * Computing under the lock FIRST would need the periods row before the
   * account rows — the settings-before-ACCOUNT inversion the lock order exists
   * to forbid. PGlite serializes transactions, so the conflict path is
   * unreachable in the test suite: it is code-review-verified, exactly like
   * the reconciliation lock choreography.
   */
  async closePeriod(input: LedgerPeriodCloseInput, actor?: Principal): Promise<LedgerPeriodCloseResult> {
    const ids = await this.requireIds();
    if (!isValidLedgerDate(input?.start) || !isValidLedgerDate(input?.end)) {
      throw new LedgerError('invalid-input', 'a period close needs ISO YYYY-MM-DD start and end dates');
    }
    if (input.end < input.start) {
      throw new LedgerError('invalid-input', `a period cannot end (${input.end}) before it starts (${input.start})`);
    }
    if (input.retainedEarningsAccountId !== undefined && (typeof input.retainedEarningsAccountId !== 'string' || input.retainedEarningsAccountId.trim() === '')) {
      throw new LedgerError('invalid-input', 'retainedEarningsAccountId must be a non-empty account id when given');
    }
    const result = await this.db.begin(async (tx) => {
      // Resolve the equity account the entry closes INTO (unlocked read — the
      // account row is locked `FOR SHARE` by `validatePostable` below).
      const retained = await this.resolveRetainedEarningsOn(tx, ids, input.retainedEarningsAccountId);
      // Preliminary balances, unlocked (see the docstring for why twice).
      const first = await this.incomeBalancesAsOf(tx, ids, input.end);
      const closingPostings = this.buildClosingPostings(first, retained.id);
      if (closingPostings.length > 0) {
        await this.validatePostable(tx, ids, closingPostings);
      }
      // The periods row, FOR UPDATE — the lock every post/reverse shares.
      const periods = await this.readPeriodsOn(tx, 'update');
      const overlap = periods.find(
        (p) => p.status === 'closed' && p.start <= input.end && input.start <= p.end,
      );
      if (overlap) {
        throw new LedgerError(
          'period-overlap',
          `the range ${input.start} – ${input.end} overlaps the closed period ${overlap.start} – ${overlap.end} (${overlap.id}) — reopen that period first`,
        );
      }
      // CHRONOLOGICAL ORDER IS ENFORCED, not assumed (Quinn R1). The sweep is
      // cumulative as of `end`, which is only correct when no LATER close
      // already swept the same balances: close Q2 then Q1 and Q1's recompute
      // cannot see Q2's later-dated closing entry, so it re-sweeps Q1's
      // income — revenue ends up with a DEBIT balance, retained earnings
      // double-counts, and both periods' day-after-zero claims are false while
      // `verifyLedger` stays green (the books are store-written). Rejecting
      // out-of-order closes keeps "closing entry = cumulative sweep as of end"
      // unconditionally true; the alternative (subtracting later closing
      // entries) breaks retroactively the moment the later period is reopened
      // and its entry voided.
      const laterClose = periods
        .filter((p) => p.status === 'closed' && p.end > input.end)
        .sort((a, b) => (a.end < b.end ? -1 : 1))[0];
      if (laterClose) {
        throw new LedgerError(
          'period-out-of-order',
          `periods close in chronological order: ${laterClose.start} – ${laterClose.end} is already closed and ends after ${input.end} — close ranges ending after ${laterClose.end}, or reopen that period first`,
        );
      }
      // Authoritative recompute under the lock; any drift is a concurrent post.
      const second = await this.incomeBalancesAsOf(tx, ids, input.end);
      if (!balancesEqual(first, second)) {
        throw new LedgerError(
          'period-close-conflict',
          'the books changed while this close was being prepared — retry the close against the settled book',
        );
      }
      // Warn-not-block: reconciliations still OPEN with a statement dated on or
      // before the close. Surfaced, named, and carried into the audit payload —
      // never a gate.
      const openReconciliations: LedgerReconciliation[] = [];
      const recRows = await tx.query<Row>(
        `SELECT ${ROW_COLS} FROM pages
          WHERE database_id = $1 AND deleted_at IS NULL
            AND properties->>'${LEDGER_PROP.reconciliation.status}' = 'open'`,
        [ids.reconciliations],
      );
      for (const row of recRows) {
        const rec = reconciliationFromRow(row);
        if (rec.statementDate <= input.end) openReconciliations.push(rec);
      }
      openReconciliations.sort((a, b) => (a.statementDate < b.statementDate ? -1 : a.statementDate > b.statementDate ? 1 : a.id < b.id ? -1 : 1));

      // The closing entry — through the same machinery `reverse` posts with.
      let closingEntry: LedgerTransaction | null = null;
      if (closingPostings.length > 0) {
        const closingId = randomUUID();
        const entryNo = await this.nextEntryNumberTx(tx);
        const description = `Closing entry — ${input.start} to ${input.end}`;
        const row = await this.insertRowTx(tx, ids.transactions, description, {
          [LEDGER_PROP.transaction.date]: input.end,
          [LEDGER_PROP.transaction.description]: description,
          [LEDGER_PROP.transaction.state]: 'posted',
          [LEDGER_PROP.transaction.postedAt]: new Date().toISOString(),
          [LEDGER_PROP.transaction.postedBy]: actor?.subject ?? '',
          [LEDGER_PROP.transaction.entryNo]: entryNo,
          [LEDGER_PROP.transaction.kind]: 'closing',
          [LEDGER_PROP.transaction.evidence]: [],
        }, closingId);
        const inserted = await this.insertPostingsTx(
          tx,
          ids,
          closingId,
          closingPostings.map((p) => ({accountId: p.accountId, amountMinor: p.amountMinor, memo: null})),
        );
        closingEntry = transactionFromRow(row, inserted);
      }

      const now = new Date().toISOString();
      const period: LedgerPeriod = {
        id: randomUUID(),
        start: input.start,
        end: input.end,
        status: 'closed',
        closingEntryId: closingEntry?.id ?? null,
        reopenEntryId: null,
        closedAt: now,
        closedBy: actor?.subject ?? '',
        reopenedAt: null,
        reopenedBy: null,
      };
      await this.writePeriodsTx(tx, [...periods, period]);
      // ONE event for the whole close (the `transaction.reverse` precedent):
      // the period record and the entry it posted commit together, so the
      // audit log records them together — and the afterHash covers BOTH, so
      // consistent surgery on either half is caught by the verifier's
      // re-derivation even though nothing later extends this chain.
      await this.appendAuditTx(
        tx,
        actor,
        'period.close',
        closingEntry ? [period.id, closingEntry.id] : [period.id],
        {
          period,
          transaction: closingEntry,
          openReconciliationIds: openReconciliations.map((r) => r.id),
        },
        null,
        await sha256Hex(canonicalLedgerJson(periodCloseContent(period, closingEntry))),
      );
      return {period, closingEntry, openReconciliations};
    });
    this.notifyMutation();
    return result;
  }

  /**
   * REOPEN a closed period: explicit, audited, and the ONLY way to void a
   * closing entry. The reversal goes through the same machinery `reverse` uses
   * (negated legs, `reverses` link, own entry number, original flipped to
   * `void`), dated on the closing entry's own date — legal again because the
   * period's status flips to `reopened` in the SAME transaction, and checked
   * against every OTHER closed period through the one shared predicate.
   *
   * The period record is KEPT (status `reopened`, reversal id recorded), not
   * deleted: the settings UI and the audit trail must be able to show that a
   * close happened and was undone. Closing the range again writes a new record.
   */
  async reopenPeriod(id: string, actor?: Principal): Promise<LedgerPeriodReopenResult> {
    const ids = await this.requireIds();
    const result = await this.db.begin(async (tx) => {
      // Find the period on an unlocked read first: the closing entry's row lock
      // (TRANSACTION) must be taken before the periods row (settings) to keep
      // the lock order, and the entry id is stored on the period.
      const preview = (await this.readPeriodsOn(tx, 'none')).find((p) => p.id === id);
      if (!preview) throw new LedgerError('not-found', 'period not found');
      if (preview.status !== 'closed') {
        throw new LedgerError('invalid-state', `period ${id} is already reopened — close the range again to re-lock it`);
      }

      // The reversal pair, prepared through the ordinary machinery.
      let original: LedgerTransaction | null = null;
      let originalRow: Row | null = null;
      if (preview.closingEntryId) {
        const rows = await tx.query<Row>(
          `SELECT ${ROW_COLS} FROM pages WHERE id = $1 AND database_id = $2 AND deleted_at IS NULL FOR UPDATE`,
          [preview.closingEntryId, ids.transactions],
        );
        if (rows.length === 0) {
          throw new LedgerError('invalid-state', `period ${id} names closing entry ${preview.closingEntryId}, which no longer exists — the book was edited outside the ledger`);
        }
        originalRow = rows[0];
        original = transactionFromRow(rows[0], await this.postingsForTx(tx, ids, preview.closingEntryId));
        if (original.state !== 'posted') {
          throw new LedgerError('invalid-state', `closing entry ${original.id} is ${original.state}, not posted — the book was edited outside the ledger`);
        }
        await this.validatePostable(tx, ids, original.postings.map((p, i) => ({
          id: `reopen-${i}`,
          transactionId: '',
          accountId: p.accountId,
          amountMinor: p.amountMinor === 0 ? 0 : -p.amountMinor,
          cleared: 'pending' as const,
          reconciliationId: null,
          memo: p.memo,
        })));
      }

      // NOW the periods row, FOR UPDATE — and the record re-checked under it.
      const periods = await this.readPeriodsOn(tx, 'update');
      const index = periods.findIndex((p) => p.id === id);
      if (index < 0 || periods[index].status !== 'closed') {
        throw new LedgerError('invalid-state', `period ${id} changed while reopening — re-read and retry`);
      }
      const before = periods[index];

      let reversal: LedgerTransaction | null = null;
      const reopened: LedgerPeriod = {
        ...before,
        status: 'reopened',
        reopenedAt: new Date().toISOString(),
        reopenedBy: actor?.subject ?? '',
      };
      const updated = [...periods];
      updated[index] = reopened;

      if (original && originalRow) {
        // The reversal is DATED (on the closing entry's date) — held to the
        // period locks like any other entry, judged against the list as it
        // stands AFTER this reopen. Other closed periods cannot contain this
        // date (overlap is rejected at close), so this is defensive.
        const blocked = closedPeriodContaining(updated, original.date);
        if (blocked) {
          throw new LedgerError(
            'period-closed',
            `the reversal would be dated ${original.date}, inside the closed period ${blocked.start} – ${blocked.end} — reopen that period first`,
          );
        }
        const reversingId = randomUUID();
        reopened.reopenEntryId = reversingId;
        const entryNo = await this.nextEntryNumberTx(tx);
        const description = `Reversal of closing entry — ${before.start} to ${before.end}`;
        const reversingRow = await this.insertRowTx(tx, ids.transactions, description, {
          [LEDGER_PROP.transaction.date]: original.date,
          [LEDGER_PROP.transaction.description]: description,
          [LEDGER_PROP.transaction.state]: 'posted',
          [LEDGER_PROP.transaction.postedAt]: new Date().toISOString(),
          [LEDGER_PROP.transaction.postedBy]: actor?.subject ?? '',
          [LEDGER_PROP.transaction.reverses]: original.id,
          [LEDGER_PROP.transaction.entryNo]: entryNo,
          [LEDGER_PROP.transaction.evidence]: [],
        }, reversingId);
        const reversingPostings = await this.insertPostingsTx(tx, ids, reversingId, original.postings.map((p) => ({
          accountId: p.accountId,
          amountMinor: p.amountMinor === 0 ? 0 : -p.amountMinor,
          cleared: 'pending' as const,
          memo: p.memo,
        })));
        const originalProps = parseJson<Record<string, unknown>>(originalRow.properties, {});
        originalProps[LEDGER_PROP.transaction.state] = 'void';
        await tx.query(
          'UPDATE pages SET properties = $3::jsonb, updated_at = now() WHERE id = $1 AND database_id = $2',
          [original.id, ids.transactions, JSON.stringify(originalProps)],
        );
        reversal = transactionFromRow(reversingRow, reversingPostings);
      }

      await this.writePeriodsTx(tx, updated);
      // beforeHash re-derives to the close event's afterHash by construction
      // (same combined shape, and a posted entry's content is immutable), so
      // the period's hash chain links close → reopen; the afterHash covers the
      // reopened record AND the reversal, so consistent surgery on either is
      // caught even though nothing later extends this chain.
      await this.appendAuditTx(
        tx,
        actor,
        'period.reopen',
        [reopened.id, ...(reversal ? [reversal.id] : []), ...(original ? [original.id] : [])],
        {
          period: reopened,
          transaction: reversal,
          originalId: original?.id ?? null,
          originalState: original ? 'void' : null,
        },
        await sha256Hex(canonicalLedgerJson(periodCloseContent(before, original))),
        await sha256Hex(canonicalLedgerJson(periodReopenContent(reopened, reversal))),
      );
      return {period: reopened, reversal};
    });
    this.notifyMutation();
    return result;
  }

  // ── Period internals (LGR-12) ────────────────────────────────────────────────

  /**
   * THE date-lock predicate's store half — one guard shared by every writer
   * that puts a dated entry on the books (`post`, `reverse`, and the closing /
   * reopening entries themselves via their own paths). The pure containment
   * test is the SDK's `closedPeriodContaining`, which the UI shares.
   *
   * Takes the periods row `FOR SHARE`, which is what makes the lock REAL on
   * real Postgres: a `closePeriod` holds it `FOR UPDATE` from before its
   * authoritative balance read through commit, so a post either commits before
   * that read (and is counted by the closing entry) or blocks here, re-reads
   * the committed list, and rejects. Sits at the `settings` slot of the lock
   * order, BEFORE `ledgerEntrySeq` — every writer that touches both takes them
   * in that order (see `loadAccountPostingsOn` for the full graph).
   */
  private async assertDateInOpenPeriodTx(tx: Db, date: string, action: 'post' | 'reverse'): Promise<void> {
    const periods = await this.readPeriodsOn(tx, 'share');
    const hit = closedPeriodContaining(periods, date);
    if (hit) {
      // Range notation is `start – end` everywhere a range is written — the
      // same notation the UI's formatPeriodRange uses (one fact, one spelling).
      throw new LedgerError(
        'period-closed',
        `cannot ${action} an entry dated ${date}: the period ${hit.start} – ${hit.end} is closed — reopen it first, or date the entry outside it`,
      );
    }
  }

  /**
   * Read the periods list on the caller's queryable. `lock` semantics:
   *  - `'none'`: plain read (list surfaces, previews); an absent row is `[]`.
   *  - `'share'` / `'update'`: the row is CREATED empty first when absent
   *    (`ON CONFLICT DO NOTHING` — one exclusive insert, once per book) and
   *    then locked. Existence-before-lock is load-bearing: `FOR SHARE` on an
   *    absent row locks nothing, and an unlocked first close could then race
   *    a concurrent post into the very range being closed.
   *
   * FAILS OPEN on a corrupt row, deliberately: a value that is not an array
   * degrades to `[]`, so an out-of-band edit that mangles the row LIFTS the
   * locks rather than wedging every post. That is the ledger's detect-not-
   * prevent posture (Quinn-reviewed): the corruption itself is caught by the
   * verifier's replay comparison (`replay-divergence` — audit says periods
   * exist, raw storage shows none), the same way every other out-of-band
   * mutation is caught, and a fail-CLOSED reading would turn one corrupt byte
   * into a book that can never post again.
   */
  private async readPeriodsOn(q: Db, lock: 'none' | 'share' | 'update'): Promise<LedgerPeriod[]> {
    if (lock !== 'none') {
      await q.query(
        'INSERT INTO settings (key, value) VALUES ($1, \'[]\'::jsonb) ON CONFLICT (key) DO NOTHING',
        [LEDGER_PERIODS_SETTING_KEY],
      );
    }
    const rows = await q.query<{value: unknown}>(
      `SELECT value FROM settings WHERE key = $1${lock === 'share' ? ' FOR SHARE' : lock === 'update' ? ' FOR UPDATE' : ''}`,
      [LEDGER_PERIODS_SETTING_KEY],
    );
    if (rows.length === 0) return [];
    const raw = parseJson<unknown>(rows[0].value, []);
    if (!Array.isArray(raw)) return [];
    return raw.map(periodFromStored).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.closedAt < b.closedAt ? -1 : 1));
  }

  /** The ONE writer of the periods list. Caller holds the row `FOR UPDATE`. */
  private async writePeriodsTx(tx: Db, periods: LedgerPeriod[]): Promise<void> {
    await tx.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [LEDGER_PERIODS_SETTING_KEY, JSON.stringify(periods)],
    );
  }

  /** Resolve the account the closing entry credits. Unlocked read (see caller). */
  private async resolveRetainedEarningsOn(q: Db, ids: LedgerIds, explicitId: string | undefined): Promise<LedgerAccount> {
    const rows = explicitId !== undefined
      ? await q.query<Row>(
        `SELECT ${ROW_COLS} FROM pages WHERE id = $1 AND database_id = $2 AND deleted_at IS NULL`,
        [explicitId, ids.accounts],
      )
      : await q.query<Row>(
        `SELECT ${ROW_COLS} FROM pages WHERE database_id = $1 AND deleted_at IS NULL AND name = $2
         ORDER BY created_at ASC, id ASC`,
        [ids.accounts, LEDGER_RETAINED_EARNINGS_ACCOUNT],
      );
    if (rows.length === 0) {
      throw new LedgerError(
        'account-not-found',
        explicitId !== undefined
          ? `retained-earnings account ${explicitId} does not exist`
          : `no account named ${LEDGER_RETAINED_EARNINGS_ACCOUNT} exists — create it (type: equity) or name the account to close into`,
      );
    }
    const account = accountFromRow(rows[0]);
    if (account.type !== 'equity') {
      throw new LedgerError('invalid-input', `the closing entry must close into an EQUITY account; ${account.name} is ${account.type}`);
    }
    // `open` is enforced by validatePostable too; rejecting here names the
    // account before any legs are computed.
    if (account.status !== 'open') {
      throw new LedgerError('account-closed', `retained-earnings account ${account.name} is closed — reopen it first`);
    }
    return account;
  }

  /**
   * Every income-statement account's CUMULATIVE posted balance as of `end`
   * (postings on posted/void entries dated ≤ `end`), keyed by account id;
   * zero balances excluded. Classification comes from the SDK's ONE list
   * (`isIncomeStatementAccountType`) — the same fact the report folds read.
   */
  private async incomeBalancesAsOf(q: Db, ids: LedgerIds, end: string): Promise<Map<string, number>> {
    const accountRows = await q.query<Row>(
      `SELECT ${ROW_COLS} FROM pages WHERE database_id = $1 AND deleted_at IS NULL`,
      [ids.accounts],
    );
    const incomeIds = new Set<string>();
    for (const row of accountRows) {
      if (isIncomeStatementAccountType(accountFromRow(row).type)) incomeIds.add(row.id);
    }
    const txRows = await q.query<{id: string; properties: Record<string, unknown> | string | null}>(
      'SELECT id, properties FROM pages WHERE database_id = $1 AND deleted_at IS NULL',
      [ids.transactions],
    );
    const counted = new Set<string>();
    for (const t of txRows) {
      const props = parseJson<Record<string, unknown>>(t.properties, {});
      const state = str(props[LEDGER_PROP.transaction.state]);
      const date = str(props[LEDGER_PROP.transaction.date]);
      // Posted AND void both count — a void original is offset exactly by its
      // posted reversal (the `accountPostedBalanceOn` convention).
      if ((state === 'posted' || state === 'void') && date !== '' && date <= end) counted.add(t.id);
    }
    const postingRows = await q.query<Row>(
      `SELECT ${ROW_COLS} FROM pages WHERE database_id = $1 AND deleted_at IS NULL`,
      [ids.postings],
    );
    const amounts = new Map<string, number[]>();
    for (const row of postingRows) {
      const posting = postingFromRow(row);
      if (!counted.has(posting.transactionId) || !incomeIds.has(posting.accountId)) continue;
      if (!isValidMinor(posting.amountMinor)) {
        throw new LedgerError('invalid-amount', `stored amount is not a safe integer: ${String(posting.amountMinor)}`);
      }
      const list = amounts.get(posting.accountId) ?? [];
      list.push(posting.amountMinor);
      amounts.set(posting.accountId, list);
    }
    const balances = new Map<string, number>();
    for (const [accountId, list] of amounts) {
      const balance = sumMinorOrThrow(list, 'closing balance');
      if (balance !== 0) balances.set(accountId, balance);
    }
    return balances;
  }

  /**
   * The closing entry's legs: one per nonzero income-statement balance (negated
   * — the leg that ZEROES the account) plus the retained-earnings leg carrying
   * the sum. Balanced by construction; empty when there is nothing to close.
   * Sorted by account id so the entry (and its audit hash) is deterministic.
   */
  private buildClosingPostings(balances: Map<string, number>, retainedEarningsId: string): LedgerPosting[] {
    if (balances.size === 0) return [];
    const legs = [...balances.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([accountId, balance]) => ({accountId, amountMinor: negateAmount(balance)}));
    // Σ legs + RE = 0 exactly: RE carries the negation of the legs' own sum.
    const retained = negateAmount(sumMinorOrThrow(legs.map((l) => l.amountMinor), 'closing entry total'));
    legs.push({accountId: retainedEarningsId, amountMinor: retained});
    return legs.map((leg, i) => ({
      id: `closing-${i}`,
      transactionId: '',
      accountId: leg.accountId,
      amountMinor: leg.amountMinor,
      cleared: 'pending' as const,
      reconciliationId: null,
      memo: null,
    }));
  }

  // ── Canonical export (LGR-7) ─────────────────────────────────────────────────

  /**
   * Record a change of the ledger auto-export target in the append-only audit
   * log (LGR-7 S4). Where copies of the book are written is exactly the kind of
   * change that must not be invisible: without this, an attacker who reached
   * the setting leaves no trace inside the ledger's own record. No-op when the
   * ledger has never been seeded (there is no book to audit yet).
   */
  async auditAutoExportPath(before: string | null, after: string | null, actor?: Principal): Promise<void> {
    if (!(await this.ids())) return;
    await this.db.begin(async (tx) => {
      await this.appendAuditTx(
        tx,
        actor,
        'ledger.autoExportPath',
        [],
        {path: after, previous: before},
        before === null ? null : await sha256Hex(canonicalLedgerJson({ledgerAutoExportPath: before})),
        await sha256Hex(canonicalLedgerJson({ledgerAutoExportPath: after})),
      );
    });
  }

  /**
   * The whole ledger as the canonical postings CSV (see sdk
   * `buildLedgerPostingsCsv` for the byte-stability contract). Unlike
   * {@link listTransactions} this read is UNBOUNDED — an export must always
   * carry the entire book, never a page of it. Built in-memory: a book is
   * small (thousands of rows, not millions); revisit streaming only if that
   * ever changes.
   */
  async exportPostingsCsv(): Promise<string> {
    const ids = await this.requireIds();
    const accounts = await this.listAccounts();
    // The CSV builder imposes its own canonical transaction order, so the SQL
    // order here only needs to be TOTAL (id) — never plan-dependent.
    const transactions = await this.loadTransactionsWithPostings(ids, 'ORDER BY id ASC');
    return buildLedgerPostingsCsv(accounts, transactions);
  }

  /**
   * The whole ledger as a Beancount journal (LGR-13) — the SAME read model as
   * {@link exportPostingsCsv} (one read model, two serializers), serialized by
   * the sdk's pure `buildLedgerBeancount` (byte-stable; drafts excluded;
   * `balance` assertions after each closed period). Unlike the insurance CSV
   * this REFUSES a corrupt book with a typed error — the reference export must
   * never serialize data the ledger cannot vouch for.
   */
  async exportBeancount(): Promise<string> {
    const ids = await this.requireIds();
    const accounts = await this.listAccounts();
    const transactions = await this.loadTransactionsWithPostings(ids, 'ORDER BY id ASC');
    const periods = await this.listPeriods();
    return buildLedgerBeancount(accounts, transactions, periods);
  }

  // ── Audit log (append-only; read is the only public surface) ─────────────────

  /** Read audit events, newest first. `before` pages by `seq` (exclusive). */
  async listAudit(opts: {limit?: number; before?: number} = {}): Promise<LedgerAuditEvent[]> {
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
    const rows =
      opts.before != null && Number.isFinite(opts.before)
        ? await this.db.query<AuditRow>(
          'SELECT * FROM ledger_audit WHERE seq < $2 ORDER BY seq DESC LIMIT $1',
          [limit, Math.floor(opts.before)],
        )
        : await this.db.query<AuditRow>('SELECT * FROM ledger_audit ORDER BY seq DESC LIMIT $1', [limit]);
    return rows.map(auditFromRow);
  }

  /**
   * The FULL audit stream, ascending `seq`, verbatim — the whole-space backup's
   * source (LGR-15). Unpaginated on purpose: a backup that silently carried a
   * prefix of the tamper-evidence chain would restore as a book whose history
   * ends mid-sentence, which the verifier would then (rightly) reject.
   */
  async exportAuditStream(): Promise<LedgerAuditEvent[]> {
    const rows = await this.db.query<AuditRow>('SELECT * FROM ledger_audit ORDER BY seq ASC');
    return rows.map(auditFromRow);
  }

  // ── LX-4: restore an export's ledger-records section (empty target only) ─────

  /** In-flight section restore, so concurrent calls serialize in-process (the
   *  `seeding` pattern) and the emptiness gate is re-checked by the runner. */
  private restoringSection: Promise<LedgerSectionRestoreResult> | null = null;

  /**
   * Restore a site export's embedded {@link LedgerExportSection} (LX-2) into
   * THIS library by REPLAYING it through the ledger writer's own public
   * mutations — `createAccount` / `createDraft` / `post` / `reverse` /
   * reconciliation and period calls — never a direct row write. Every replayed
   * mutation appends its ordinary audit event, so the restored book carries a
   * complete, fresh, verifiable history; a final `ledger.restore` provenance
   * event (the LGR-15 convention, extended — see `ledgerRestorePayloadContent`)
   * brackets the replay, naming the actor, the section's content hash, the
   * source book's exported audit-chain anchor, and the honest degradation
   * counters.
   *
   * EMPTY TARGET ONLY (v1 — merge semantics are explicitly out of scope): a
   * library that already keeps ANY ledger data — an account, a journal entry
   * (drafts included), a reconciliation, or a period record — refuses with a
   * typed `invalid-state` naming what exists and what to do instead. A never-
   * seeded or seeded-but-empty ledger restores.
   *
   * WHAT AN HTML EXPORT CANNOT CARRY, degraded honestly, never silently:
   *  - evidence BYTES (LGR-14) — manifests are dropped and counted
   *    (`evidenceDropped`); recover receipts from a backup bundle (LGR-15);
   *  - the source AUDIT STREAM — the export carries only its head anchor
   *    (recorded on the provenance event); the replay mints a fresh chain;
   *  - entry numbers / posted-at stamps — reassigned by the writer in replay
   *    order (report numbers are date-driven and unaffected).
   *
   * NOT ATOMIC, stated plainly: each replayed mutation commits in its own
   * transaction (the writer's methods each open `Db.begin`, and the embedded
   * PGlite backend cannot nest them). The section is therefore deep-validated
   * UP FRONT (`parseLedgerExportSection` — the same validator the UI previews
   * with) so a mid-replay writer rejection is a bug or an environment failure,
   * not an expected path; if one still happens the error says the target holds
   * a partial book and must not be used without review.
   */
  async restoreExportSection(section: LedgerExportSection, actor?: Principal): Promise<LedgerSectionRestoreResult> {
    if (this.restoringSection) {
      throw new LedgerError('invalid-state', 'another ledger-records restore is already running on this library — wait for it to finish');
    }
    const parsed = parseLedgerExportSection(section);
    if (!parsed.ok) {
      throw new LedgerError('invalid-input', `the embedded ledger records are not a coherent book — ${parsed.reason}; re-export from the source library, or restore from a backup bundle instead`);
    }
    // A period closed over a book with NO equity account could never replay
    // (the close must sweep into an equity account). Unreachable from a real
    // export; refused up front so it cannot abort a replay halfway.
    if (parsed.book.periods.length > 0 && !parsed.book.accounts.some((a) => a.type === 'equity')) {
      throw new LedgerError('invalid-input', 'the embedded ledger records close accounting periods but carry no equity account to close into');
    }
    const run = this.doRestoreSection(section, parsed.book, actor).finally(() => {
      this.restoringSection = null;
    });
    this.restoringSection = run;
    return run;
  }

  /** Refuse unless this library keeps NO ledger data (see restoreExportSection). */
  private async assertEmptyLedgerForRestore(): Promise<void> {
    const ids = await this.ids();
    if (!ids) return; // never seeded — trivially empty
    const held: string[] = [];
    const count = async (databaseId: string): Promise<number> => {
      const rows = await this.db.query<{n: number | string}>(
        'SELECT COUNT(*) AS n FROM pages WHERE database_id = $1 AND deleted_at IS NULL',
        [databaseId],
      );
      return Number(rows[0]?.n ?? 0);
    };
    const accounts = await count(ids.accounts);
    if (accounts > 0) held.push(`${accounts} account${accounts === 1 ? '' : 's'}`);
    const entries = await count(ids.transactions);
    if (entries > 0) held.push(`${entries} journal entr${entries === 1 ? 'y' : 'ies'} (drafts included)`);
    const recs = await count(ids.reconciliations);
    if (recs > 0) held.push(`${recs} reconciliation${recs === 1 ? '' : 's'}`);
    const periods = await this.readPeriodsOn(this.db, 'none');
    if (periods.length > 0) held.push(`${periods.length} period record${periods.length === 1 ? '' : 's'}`);
    if (held.length > 0) {
      throw new LedgerError(
        'invalid-state',
        `this library already keeps books — ${held.join(', ')} — and importing ledger records can only restore into an empty ledger (merging is not supported). ` +
          'Restore into a fresh library instead, or back up and clear this library first if you meant to replace its books.',
      );
    }
  }

  private async doRestoreSection(
    section: LedgerExportSection,
    book: LedgerSectionBook,
    actor?: Principal,
  ): Promise<LedgerSectionRestoreResult> {
    await this.assertEmptyLedgerForRestore();
    await this.ensureSetup(actor);
    // Re-check after the seed: `assertEmptyLedgerForRestore` read pre-seed
    // state, and a concurrent writer could have landed rows in between (the
    // in-process `restoringSection` latch serializes restores, not ordinary
    // writes). Still a narrowing, not a lock — the residual cross-process race
    // is documented in the recovery runbook.
    await this.assertEmptyLedgerForRestore();

    // ── Accounts. Created OPEN and without the evidence gate: a closed status
    // would refuse the very postings being replayed into it, and the evidence
    // gate would refuse bare replays (the bytes are not in an HTML export).
    // Both are re-asserted at the end, after all posting activity.
    const accountMap = new Map<string, string>();
    for (const a of book.accounts) {
      const created = await this.createAccount({name: a.name, type: a.type, currency: a.currency}, actor);
      accountMap.set(a.id, created.id);
    }
    const mappedAccount = (sourceId: string): string => {
      const id = accountMap.get(sourceId);
      if (!id) throw new LedgerError('invalid-state', `restore bug: no replayed account for source account ${sourceId}`);
      return id;
    };

    // Closing entries and reopen reversals are NOT replayed directly — the
    // period replay below regenerates them through closePeriod/reopenPeriod,
    // the only doors that may write them.
    const periodEntries = new Set<string>();
    for (const p of book.periods) {
      if (p.closingEntryId) periodEntries.add(p.closingEntryId);
      if (p.reopenEntryId) periodEntries.add(p.reopenEntryId);
    }

    // ── Journal entries, in the section's replay order (entry number, drafts
    // last). Ordinary entries first; reversals re-enacted through `reverse`
    // afterwards so the pair-link and void flip are the writer's own.
    const txMap = new Map<string, string>();
    const postingMap = new Map<string, string>();
    const mapPostingsInOrder = (source: LedgerSectionTransaction, landedPostings: LedgerPosting[]): void => {
      // createDraft inserts postings in input order and postingsForTx reads
      // them back by `position`, so a positional zip is exact.
      source.postings.forEach((p, i) => {
        const landed = landedPostings[i];
        if (landed) postingMap.set(p.id, landed.id);
      });
    };
    let transactionsReplayed = 0;
    let postingsReplayed = 0;
    for (const tx of book.transactions) {
      if (periodEntries.has(tx.id) || tx.reverses !== null) continue;
      const postings: LedgerPostingInput[] = tx.postings.map((p) => ({
        accountId: mappedAccount(p.accountId),
        amountMinor: p.amountMinor,
        // A draft's cleared ticks can only be set AT creation (the flip surface
        // rejects drafts); a posted entry's are replayed later, after the
        // reconciliation pass, so a finish can never freeze the wrong set.
        ...(tx.state === 'draft' && p.cleared === 'cleared' ? {cleared: 'cleared' as const} : {}),
        memo: p.memo,
      }));
      const draft = await this.createDraft({date: tx.date, description: tx.description, postings}, actor);
      const landed = tx.state === 'draft' ? draft : await this.post(draft.id, actor);
      txMap.set(tx.id, landed.id);
      mapPostingsInOrder(tx, landed.postings);
      transactionsReplayed += 1;
      postingsReplayed += landed.postings.length;
    }
    for (const tx of book.transactions) {
      if (periodEntries.has(tx.id) || tx.reverses === null) continue;
      const originalId = txMap.get(tx.reverses);
      if (!originalId) throw new LedgerError('invalid-state', `restore bug: reversal ${tx.id} replayed before its original ${tx.reverses}`);
      const reversal = await this.reverse(originalId, {date: tx.date, description: tx.description}, actor);
      txMap.set(tx.id, reversal.id);
      // The writer negates the ORIGINAL's legs in the original's order; the
      // section's reversal was born the same way, so the positional zip holds
      // here too (the parser verified leg-for-leg negation).
      mapPostingsInOrder(tx, reversal.postings);
      transactionsReplayed += 1;
      postingsReplayed += reversal.postings.length;
    }

    // ── Reconciliations, per account: ENDED ones (finished/abandoned) in
    // creation order, the at-most-one OPEN one last — the one-open-per-account
    // rule replayed in the only order that satisfies it.
    const postingsByRec = new Map<string, LedgerSectionPosting[]>();
    for (const tx of book.transactions) {
      for (const p of tx.postings) {
        if (p.reconciliationId !== null) {
          postingsByRec.set(p.reconciliationId, [...(postingsByRec.get(p.reconciliationId) ?? []), p]);
        }
      }
    }
    const recsByAccount = new Map<string, LedgerSectionReconciliation[]>();
    for (const rec of book.reconciliations) {
      recsByAccount.set(rec.accountId, [...(recsByAccount.get(rec.accountId) ?? []), rec]);
    }
    let reconciliationsReplayed = 0;
    let reconciliationsDowngraded = 0;
    for (const recs of recsByAccount.values()) {
      const ordered = [...recs].sort((a, b) => {
        if ((a.status === 'open') !== (b.status === 'open')) return a.status === 'open' ? 1 : -1;
        return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;
      });
      for (const rec of ordered) {
        const started = await this.startReconciliation(
          {accountId: mappedAccount(rec.accountId), statementDate: rec.statementDate, statementBalanceMinor: rec.statementBalanceMinor},
          actor,
        );
        reconciliationsReplayed += 1;
        if (rec.status === 'abandoned') {
          await this.abandonReconciliation(started.id, actor);
          continue;
        }
        if (rec.status === 'open') continue; // stays open, ticks are re-made below
        // Finished: tick exactly the postings this reconciliation froze, then
        // finish — the difference recomputes to zero because the ticked set and
        // the statement balance are the source book's own zero.
        for (const p of postingsByRec.get(rec.id) ?? []) {
          const postingId = postingMap.get(p.id);
          if (!postingId) throw new LedgerError('invalid-state', `restore bug: no replayed posting for frozen source posting ${p.id}`);
          await this.setReconciliationPostingCleared(started.id, postingId, 'cleared', actor);
        }
        try {
          await this.finishReconciliation(started.id, actor);
        } catch (err) {
          if (err instanceof LedgerError && err.code === 'reconciliation-unbalanced') {
            // An exotic source history (a finish whose balance leaned on a
            // reconciliation that was later reopened) cannot be re-frozen
            // exactly. Degrade HONESTLY: abandon the attempt (audited), leave
            // the ticks cleared, count it — workflow metadata only, the
            // amounts and report numbers are untouched.
            await this.abandonReconciliation(started.id, actor);
            reconciliationsDowngraded += 1;
            continue;
          }
          throw err;
        }
      }
    }

    // ── Cleared ticks on posted/void entries (drafts were born with theirs).
    // After the reconciliation pass, so a replayed finish freezes only its own.
    for (const tx of book.transactions) {
      if (txMap.get(tx.id) === undefined || tx.state === 'draft') continue;
      for (const p of tx.postings) {
        if (p.cleared !== 'cleared') continue;
        const postingId = postingMap.get(p.id);
        if (!postingId) throw new LedgerError('invalid-state', `restore bug: no replayed posting for source posting ${p.id}`);
        const landed = await this.getPosting(postingId);
        if (landed && landed.cleared === 'pending') await this.setPostingCleared(postingId, 'cleared', actor);
      }
    }

    // ── Periods, replayed in the source's own close/reopen chronology (a
    // reopen may legally precede a later, lower-ranged close — interleaving by
    // timestamp is what keeps closePeriod's chronological-order rule satisfied
    // exactly as the source satisfied it).
    const periodEvents: Array<{at: string; kind: 'close' | 'reopen'; period: LedgerPeriod}> = [];
    for (const p of book.periods) {
      periodEvents.push({at: p.closedAt || '', kind: 'close', period: p});
      if (p.status === 'reopened') periodEvents.push({at: p.reopenedAt || p.closedAt || '', kind: 'reopen', period: p});
    }
    periodEvents.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.kind === b.kind ? 0 : a.kind === 'close' ? -1 : 1));
    const periodMap = new Map<string, string>();
    let periodEntriesReplayed = 0;
    const retainedEarningsFor = (period: LedgerPeriod): string | undefined => {
      // The account the source's closing entry swept INTO: its non-income leg.
      if (period.closingEntryId) {
        const closing = book.transactions.find((t) => t.id === period.closingEntryId);
        const equityLeg = closing?.postings.find((p) => {
          const account = book.accounts.find((a) => a.id === p.accountId);
          return account !== undefined && !isIncomeStatementAccountType(account.type);
        });
        if (equityLeg) return mappedAccount(equityLeg.accountId);
      }
      // A close with nothing to sweep still resolves a retained-earnings
      // account: prefer the conventional name, else any equity account.
      const byName = book.accounts.find((a) => a.name === LEDGER_RETAINED_EARNINGS_ACCOUNT && a.type === 'equity');
      const equity = byName ?? book.accounts.find((a) => a.type === 'equity');
      return equity ? mappedAccount(equity.id) : undefined;
    };
    for (const ev of periodEvents) {
      if (ev.kind === 'close') {
        const retainedEarningsAccountId = retainedEarningsFor(ev.period);
        const closed = await this.closePeriod(
          {start: ev.period.start, end: ev.period.end, ...(retainedEarningsAccountId ? {retainedEarningsAccountId} : {})},
          actor,
        );
        periodMap.set(ev.period.id, closed.period.id);
        if (closed.closingEntry) {
          periodEntriesReplayed += 1;
          if (ev.period.closingEntryId) txMap.set(ev.period.closingEntryId, closed.closingEntry.id);
        }
      } else {
        const landedId = periodMap.get(ev.period.id);
        if (!landedId) throw new LedgerError('invalid-state', `restore bug: period ${ev.period.id} reopened before it was closed`);
        const reopened = await this.reopenPeriod(landedId, actor);
        if (reopened.reversal) {
          periodEntriesReplayed += 1;
          if (ev.period.reopenEntryId) txMap.set(ev.period.reopenEntryId, reopened.reversal.id);
        }
      }
    }

    // ── Account finalization: the closed statuses and evidence gates deferred
    // above, now that no further posting will touch them. Closing succeeds
    // because the replayed balances equal the source's, where the invariant
    // "closed ⇒ zero posted balance" already held.
    for (const a of book.accounts) {
      if (a.status !== 'closed' && !a.evidenceRequired) continue;
      await this.updateAccount(
        mappedAccount(a.id),
        {...(a.status === 'closed' ? {status: 'closed' as const} : {}), ...(a.evidenceRequired ? {evidenceRequired: true} : {})},
        actor,
      );
    }

    // ── Provenance (LGR-15's `ledger.restore` convention, extended — one
    // payload family, ONE derived shape shared with the verifier). Bracketing
    // the replay: every event before this one carries the restored content;
    // this one names the actor, the section's content hash, the source book's
    // exported chain anchor, and the honest degradation counters.
    const tally = await this.db.query<{n: number | string}>('SELECT COUNT(*) AS n FROM ledger_audit');
    const payload: Record<string, unknown> = {
      bundleSha: await sha256Hex(canonicalLedgerJson(section as unknown as Record<string, unknown>)),
      auditEvents: Number(tally[0]?.n ?? 0),
      assets: 0,
      source: 'export-section',
      ...(book.auditHead ? {sourceAuditHeadSeq: book.auditHead.seq, sourceAuditHeadHash: book.auditHead.hash} : {}),
      evidenceDropped: book.evidenceDropped,
      reconciliationsDowngraded,
    };
    await this.db.begin(async (tx) => {
      await this.appendAuditTx(
        tx,
        actor,
        'ledger.restore',
        [],
        payload,
        null,
        await sha256Hex(canonicalLedgerJson(ledgerRestorePayloadContent(payload))),
      );
    });
    this.notifyMutation();

    return {
      restored: {
        accounts: book.accounts.length,
        transactions: transactionsReplayed + periodEntriesReplayed,
        postings: postingsReplayed,
        reconciliations: reconciliationsReplayed,
        periods: book.periods.length,
      },
      evidenceDropped: book.evidenceDropped,
      reconciliationsDowngraded,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  /** Lock a transaction row and require it to be a DRAFT. */
  private async lockDraftTx(
    tx: Db,
    ids: LedgerIds,
    id: string,
    action: 'mutate' | 'post' = 'mutate',
  ): Promise<{row: Row; props: Record<string, unknown>; before: LedgerTransaction}> {
    const rows = await tx.query<Row>(
      `SELECT ${ROW_COLS} FROM pages WHERE id = $1 AND database_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [id, ids.transactions],
    );
    if (rows.length === 0) throw new LedgerError('not-found', 'transaction not found');
    const props = parseJson<Record<string, unknown>>(rows[0].properties, {});
    const state = str(props[LEDGER_PROP.transaction.state]);
    if (state !== 'draft') {
      throw action === 'post'
        ? new LedgerError('invalid-state', `only a draft can be posted (state: ${state || 'unknown'})`)
        : new LedgerError(
          'immutable',
          `a ${state || 'posted'} transaction is immutable — corrections require a reversing transaction`,
        );
    }
    const postings = await this.postingsForTx(tx, ids, id);
    return {row: rows[0], props, before: transactionFromRow(rows[0], postings)};
  }

  /**
   * Invariant 1 — everything a post must satisfy, validated inside the post tx.
   *
   * The account rows are resolved in ONE `= ANY($1)` query and locked
   * `FOR SHARE` (LGR-3 F6/F9): the per-posting round-trip made a large compound
   * entry's cost linear in its legs while holding the global write mutex, and an
   * UNLOCKED read let a concurrent `updateAccount(status:'closed')` commit
   * between this check and the post, producing a posting into a closed account.
   * `FOR SHARE` lets concurrent posts proceed together while blocking a close.
   *
   * RETURNS the locked accounts by id (LGR-14): `post` reads
   * `evidenceRequired` off exactly these rows — the same `FOR SHARE` locks, the
   * same ACCOUNT slot in the lock order, no second read and no new lock class —
   * so a concurrent toggle serializes against the post exactly as a close does.
   */
  private async validatePostable(tx: Db, ids: LedgerIds, postings: LedgerPosting[]): Promise<Map<string, LedgerAccount>> {
    if (postings.length < 2) {
      throw new LedgerError('too-few-postings', `a journal entry needs at least 2 postings, got ${postings.length}`);
    }
    if (postings.length > MAX_POSTINGS_PER_TRANSACTION) {
      throw new LedgerError(
        'invalid-input',
        `a journal entry may have at most ${MAX_POSTINGS_PER_TRANSACTION} postings, got ${postings.length}`,
      );
    }
    for (const p of postings) {
      if (!isValidMinor(p.amountMinor)) {
        throw new LedgerError('invalid-amount', `posting amount must be a safe signed integer of minor units, got ${String(p.amountMinor)}`);
      }
    }
    const total = sumMinorOrThrow(postings.map((p) => p.amountMinor), 'posting total');
    if (total !== 0) {
      throw new LedgerError('unbalanced', `postings must sum to zero, got ${total} minor units`);
    }
    // An all-zero entry balances trivially but moves nothing — it is noise in
    // the books, not a journal entry, so at least one leg must be nonzero.
    if (postings.every((p) => p.amountMinor === 0)) {
      throw new LedgerError('invalid-amount', 'a journal entry needs at least one nonzero posting');
    }
    const accountIds = [...new Set(postings.map((p) => p.accountId))];
    const rows = await tx.query<Row>(
      `SELECT ${ROW_COLS} FROM pages
        WHERE id = ANY($1) AND database_id = $2 AND deleted_at IS NULL
        ORDER BY id
        FOR SHARE`,
      [accountIds, ids.accounts],
    );
    const byId = new Map(rows.map((row) => [row.id, accountFromRow(row)]));
    const currencies: string[] = [];
    for (const p of postings) {
      const account = byId.get(p.accountId);
      if (!account) {
        throw new LedgerError('account-not-found', `posting references a nonexistent account: ${p.accountId}`);
      }
      if (account.status !== 'open') {
        throw new LedgerError('account-closed', `posting references a closed account: ${account.name}`);
      }
      currencies.push(account.currency);
    }
    try {
      assertUniformCurrency(currencies);
    } catch (err) {
      if (err instanceof MoneyError) throw new LedgerError('currency-mismatch', err.message);
      throw err;
    }
    return byId;
  }

  /**
   * Invariant 6 — the next entry number: a per-library monotonic sequence kept
   * in `settings`, advanced with an atomic upsert INSIDE the posting transaction
   * (so a rolled-back post leaves no gap, and concurrent posts serialize on the
   * row — the PGlite mutex or Postgres's row lock). Never the client-assigned
   * `unique_id`, which is collision-prone across clients.
   */
  private async nextEntryNumberTx(tx: Db): Promise<number> {
    const rows = await tx.query<{n: string | number}>(
      `INSERT INTO settings (key, value) VALUES ($1, to_jsonb(1))
       ON CONFLICT (key) DO UPDATE SET value = to_jsonb(COALESCE((settings.value #>> '{}')::bigint, 0) + 1)
       RETURNING (value #>> '{}') AS n`,
      [LEDGER_ENTRY_SEQ_SETTING_KEY],
    );
    const n = Number(rows[0]?.n);
    if (!Number.isSafeInteger(n) || n < 1) throw new LedgerError('invalid-state', 'entry-number sequence corrupted');
    return n;
  }

  // ── Reconciliation internals (LGR-11) ────────────────────────────────────────

  /**
   * Lock the ACCOUNT row `FOR UPDATE`, so the "one open reconciliation per
   * account" check is not a check-then-act race.
   *
   * BOTH writers that can create an open reconciliation take this: `start`, and
   * `reopen` (which turns a finished one back into an open one). Holding only
   * the reconciliation row is not enough — a start and a reopen, or two reopens
   * of DIFFERENT finished statements, touch disjoint rows, so on real Postgres
   * neither blocks the other, both read "nothing open", and both commit. The
   * advisory audit lock does not save it: it is taken after both checks. The
   * account row is the one row every path on this account shares.
   */
  private async lockAccountTx(tx: Db, ids: LedgerIds, accountId: string): Promise<LedgerAccount> {
    const rows = await tx.query<Row>(
      `SELECT ${ROW_COLS} FROM pages WHERE id = $1 AND database_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [accountId, ids.accounts],
    );
    if (rows.length === 0) {
      throw new LedgerError('account-not-found', `reconciliation references a nonexistent account: ${accountId}`);
    }
    return accountFromRow(rows[0]);
  }

  /** The account's OPEN reconciliation, or `null`. Read on the caller's tx. */
  private async openReconciliationOn(q: Db, ids: LedgerIds, accountId: string): Promise<LedgerReconciliation | null> {
    const rows = await q.query<Row>(
      `SELECT ${ROW_COLS} FROM pages
        WHERE database_id = $1 AND deleted_at IS NULL
          AND properties->>'${LEDGER_PROP.reconciliation.account}' = $2
          AND properties->>'${LEDGER_PROP.reconciliation.status}' = 'open'
        ORDER BY created_at ASC, id ASC`,
      [ids.reconciliations, accountId],
    );
    return rows.length > 0 ? reconciliationFromRow(rows[0]) : null;
  }

  /**
   * Lock a reconciliation row and require the named status. The RAW row comes
   * back with the entity so a status flip can patch the properties it already
   * holds a lock on instead of reading the row a second time.
   *
   * The rejection names the status the row IS IN, derived from the row rather
   * than inferred from the status the caller wanted. The version that branched
   * on `required` alone had only two answers for three statuses, so amending an
   * ABANDONED reconciliation was met with "is finished — reopen it before
   * changing what it matched": an instruction that does not apply, pointing at a
   * control that is not offered, for a state the row is not in.
   */
  private async lockReconciliationTx(
    tx: Db,
    ids: LedgerIds,
    id: string,
    required: LedgerReconciliationStatus,
  ): Promise<{reconciliation: LedgerReconciliation; row: Row}> {
    const rows = await tx.query<Row>(
      `SELECT ${ROW_COLS} FROM pages WHERE id = $1 AND database_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [id, ids.reconciliations],
    );
    if (rows.length === 0) throw new LedgerError('not-found', 'reconciliation not found');
    const reconciliation = reconciliationFromRow(rows[0]);
    if (reconciliation.status !== required) {
      throw new LedgerError('invalid-state', reconciliationStateRefusal(id, reconciliation.status, required));
    }
    return {reconciliation, row: rows[0]};
  }

  /**
   * The ONE writer of a posting's cleared state + reconciliation id.
   *
   * {@link setPostingCleared} (the public pending ⇄ cleared flip) and the
   * reconciliation freeze/thaw both go through here, so there is exactly one
   * place that knows how those two properties are stored. The caller is
   * responsible for the guard that makes the write legal and for the audit
   * event — the freeze writes ONE event for its whole set, so it cannot borrow
   * the per-posting event `setPostingCleared` appends.
   */
  private async writePostingClearedTx(
    tx: Db,
    ids: LedgerIds,
    row: Row,
    cleared: LedgerClearedState,
    reconciliationId: string | null,
  ): Promise<Row> {
    const props = parseJson<Record<string, unknown>>(row.properties, {});
    props[LEDGER_PROP.posting.cleared] = cleared;
    props[LEDGER_PROP.posting.reconciliation] = reconciliationId;
    const updated = await tx.query<Row>(
      `UPDATE pages SET properties = $3::jsonb, updated_at = now() WHERE id = $1 AND database_id = $2 RETURNING ${ROW_COLS}`,
      [row.id, ids.postings, JSON.stringify(props)],
    );
    return updated[0];
  }

  /**
   * Flip a reconciliation's status, returning the stored-after entity. The
   * caller already holds this row `FOR UPDATE` via {@link lockReconciliationTx}
   * and hands its RAW row straight in — re-SELECTing it would be a second read
   * of a row we are already holding, and the version that did so also dropped
   * the `deleted_at IS NULL` predicate the lock read applies.
   */
  private async setReconciliationStatusTx(
    tx: Db,
    ids: LedgerIds,
    before: {id: string; row: Row},
    status: LedgerReconciliationStatus,
  ): Promise<LedgerReconciliation> {
    const props = parseJson<Record<string, unknown>>(before.row.properties, {});
    props[LEDGER_PROP.reconciliation.status] = status;
    const updated = await tx.query<Row>(
      `UPDATE pages SET properties = $3::jsonb, updated_at = now() WHERE id = $1 AND database_id = $2 RETURNING ${ROW_COLS}`,
      [before.id, ids.reconciliations, JSON.stringify(props)],
    );
    return reconciliationFromRow(updated[0]);
  }

  /**
   * Every posting on one account, paired with the state of the entry it belongs
   * to — in TWO queries, never one per posting.
   *
   * BATCHED, not N+1 (LGR-3 F6's lesson, re-learned): the per-posting state read
   * this replaces cost 2·N round trips on every checkbox tick and every read of
   * a reconciliation, all of them inside a `Db.begin` that holds the embedded
   * backend's process-wide FIFO mutex. On a 2,000-posting current account one
   * tick measured 2,008 queries and stalled every other database call in the
   * process for ~300 ms. `validatePostable` already says this in its own
   * docstring; the same `= ANY($1)` shape is used here.
   *
   * LOCKING, when `lock` is `'write'` (finish / reopen):
   *  - postings `FOR UPDATE`, in id order. {@link setPostingCleared} takes no
   *    reconciliation lock, so without this a generic cleared-state flip could
   *    commit between the difference check and the freeze.
   *  - parent transactions `FOR SHARE`, in id order. This one is not optional
   *    either: `post` locks the TRANSACTION row and never the posting rows, so
   *    an unlocked state read let a draft-but-cleared leg — excluded from the
   *    difference — be POSTED between the read and the commit, at which point it
   *    counts, and the reconciliation is finished and out of balance. `FOR
   *    SHARE` blocks the post without blocking a concurrent finish.
   *
   * LOCK ORDER — the whole graph, because getting it wrong here deadlocked
   * against `post` once already. Every writer acquires in this order and no
   * other:
   *
   *     RECONCILIATION → POSTING → TRANSACTION → ACCOUNT
   *       → settings[ledgerPeriods → ledgerEntrySeq] → audit advisory (leaf)
   *
   * The `settings` level is ordered INTERNALLY too (LGR-12): the periods row
   * (`readPeriodsOn` — `FOR SHARE` in post/reverse, `FOR UPDATE` in
   * closePeriod/reopenPeriod) always precedes the entry-number row
   * (`nextEntryNumberTx`); every writer that touches both takes them in that
   * order. `closePeriod` enters the spine at ACCOUNT (`validatePostable` on the
   * closing legs — its earlier balance reads are UNLOCKED, revalidated under
   * the periods row; see its docstring), and `reopenPeriod` runs the full
   * spine: TRANSACTION (the closing entry) → ACCOUNT → settings → advisory.
   *
   * `post` sits on the same spine (`lockDraftTx` takes TRANSACTION, then
   * `validatePostable` takes ACCOUNT `FOR SHARE`, then the period guard takes
   * the periods settings row `FOR SHARE`), which is why `start` and
   * `reopen` must NOT take the account row before walking postings: T1 `post`
   * holding a transaction row and waiting on account A, against T2 holding A and
   * waiting `FOR SHARE` on that same transaction row — which is in its set
   * precisely because it has a leg on A — is a cycle Postgres breaks with a
   * `40P01` abort surfacing as an untyped 500. `start` therefore takes no
   * posting locks at all, and `reopen` acquires the account row LAST.
   *
   * Both row locks here are taken in id order, so two writers on overlapping
   * accounts cannot deadlock against each other either. PGlite serializes every
   * transaction, so NONE of this is reachable in the test suite — it is
   * code-review-verified, exactly like the audit advisory lock.
   */
  private async loadAccountPostingsOn(
    q: Db,
    ids: LedgerIds,
    accountId: string,
    lock: 'none' | 'write',
  ): Promise<AccountPostingRow[]> {
    const rows = await q.query<Row>(
      `SELECT ${ROW_COLS} FROM pages
        WHERE database_id = $1 AND deleted_at IS NULL
          AND properties->>'${LEDGER_PROP.posting.account}' = $2
        ORDER BY id ASC
        ${lock === 'write' ? 'FOR UPDATE' : ''}`,
      [ids.postings, accountId],
    );
    const postings = rows.map((row) => ({row, posting: postingFromRow(row)}));
    const txIds = [...new Set(postings.map(({posting}) => posting.transactionId).filter((id) => id !== ''))];
    const stateById = new Map<string, LedgerTransactionState>();
    if (txIds.length > 0) {
      const txRows = await q.query<{id: string; properties: Record<string, unknown> | string | null}>(
        `SELECT id, properties FROM pages
          WHERE id = ANY($1) AND database_id = $2 AND deleted_at IS NULL
          ORDER BY id
          ${lock === 'write' ? 'FOR SHARE' : ''}`,
        [txIds, ids.transactions],
      );
      for (const txRow of txRows) {
        const state = str(parseJson<Record<string, unknown>>(txRow.properties, {})[LEDGER_PROP.transaction.state]);
        if (state !== '') stateById.set(txRow.id, state as LedgerTransactionState);
      }
    }
    return postings.map(({row, posting}) => ({
      posting: {...posting, row},
      state: stateById.get(posting.transactionId) ?? null,
    }));
  }

  /**
   * The cap, applied to the set a writer is about to MUTATE — never to how many
   * postings the account holds. See {@link MAX_RECONCILIATION_POSTINGS} for why
   * that distinction is the difference between a bound and a brick.
   */
  private assertWritableSet(size: number, op: 'finish' | 'reopen'): void {
    if (size <= MAX_RECONCILIATION_POSTINGS) return;
    throw new LedgerError(
      'reconciliation-too-large',
      op === 'finish'
        ? `this reconciliation matched ${size} postings, and one statement may freeze at most ${MAX_RECONCILIATION_POSTINGS} — untick the postings that belong to another statement, or reconcile this account in more than one pass`
        : `this reconciliation holds ${size} postings, and one reopen may release at most ${MAX_RECONCILIATION_POSTINGS}`,
    );
  }

  /**
   * ONE entry's state, or `null` when it does not exist. Used only where a
   * single posting is in hand (the tick, and the generic cleared-state flip) —
   * anything that walks a whole account batches the read instead (see
   * {@link loadAccountPostingsOn}).
   */
  private async entryStateOn(q: Db, ids: LedgerIds, txId: string): Promise<LedgerTransactionState | null> {
    if (txId === '') return null;
    const rows = await q.query<{properties: Record<string, unknown> | string | null}>(
      'SELECT properties FROM pages WHERE id = $1 AND database_id = $2 AND deleted_at IS NULL',
      [txId, ids.transactions],
    );
    if (rows.length === 0) return null;
    const state = str(parseJson<Record<string, unknown>>(rows[0].properties, {})[LEDGER_PROP.transaction.state]);
    return state === '' ? null : (state as LedgerTransactionState);
  }

  /**
   * {@link summarizeFrom} over an unlocked read of the account.
   *
   * NOT capped, and deliberately so: a tick and a read neither lock the set nor
   * write it, and refusing to SHOW a reconciliation on a large account would be
   * the same brick the cardinality cap was. It does build one in-memory array of
   * every posting on the account per tick and per read, which is bounded only by
   * the account's size — acceptable at the two-query cost this now runs at, and
   * the thing to revisit first if very large accounts ever become the norm.
   */
  private async summarizeOn(q: Db, ids: LedgerIds, reconciliation: LedgerReconciliation): Promise<LedgerReconciliationSummary> {
    return this.summarizeFrom(reconciliation, await this.loadAccountPostingsOn(q, ids, reconciliation.accountId, 'none'));
  }

  /**
   * The bookkeeper's arithmetic, in one place: statement balance − cleared
   * balance = the difference to explain.
   *
   * The CLEARED BALANCE is Σ of every `cleared` or `reconciled` posting on the
   * account that reaches the books (posted or void — a void original is offset
   * exactly by its posted reversal, which is how `accountPostedBalance` counts
   * too, so the two agree by construction). Drafts contribute nothing: they are
   * not on the books, so they cannot be on a statement.
   *
   * `reconciled` postings from EARLIER statements are counted, deliberately:
   * they are cleared money sitting in the account, and a statement's closing
   * balance includes every one of them. Excluding them would make the very first
   * reconciliation the only one that could ever reach zero.
   */
  private summarizeFrom(reconciliation: LedgerReconciliation, postings: readonly AccountPostingRow[]): LedgerReconciliationSummary {
    return this.reconcileState(reconciliation, postings).summary;
  }

  /**
   * {@link summarizeFrom}, plus the matched rows themselves.
   *
   * `finish` freezes EXACTLY the rows this returns, rather than re-deriving the
   * set from a second predicate. That is structural, not stylistic: the version
   * that filtered the freeze on `cleared === 'cleared'` alone froze a strict
   * SUPERSET of what it had counted — a draft leg born `cleared: 'cleared'`
   * (which {@link validatePostingInput} permits, and the bank import relies on)
   * was excluded from the difference by the `posted | void` test here, yet
   * frozen and stamped by the writer. Posting that draft afterwards then made a
   * FINISHED reconciliation report a nonzero difference, and deleting it
   * destroyed a frozen posting with no `reconciled-locked`, no event, and a
   * clean verifier report. One predicate, one set, no drift.
   */
  private reconcileState(
    reconciliation: LedgerReconciliation,
    postings: readonly AccountPostingRow[],
  ): {summary: LedgerReconciliationSummary; matched: AccountPostingRow[]} {
    const matched = postings.filter(
      ({posting, state}) => (state === 'posted' || state === 'void') && posting.cleared !== 'pending',
    );
    for (const {posting} of matched) {
      if (!isValidMinor(posting.amountMinor)) {
        throw new LedgerError('invalid-amount', `stored amount is not a safe integer: ${String(posting.amountMinor)}`);
      }
    }
    const clearedBalanceMinor = sumMinorOrThrow(matched.map(({posting}) => posting.amountMinor), 'cleared balance');
    // Through the money core, never a bare `-x`: `negateAmount` is what keeps
    // the sign out of the arithmetic and `-0` out of the stored difference.
    const differenceMinor = sumMinorOrThrow(
      [reconciliation.statementBalanceMinor, negateAmount(clearedBalanceMinor)],
      'reconciliation difference',
    );
    // A FINISHED reconciliation is HISTORY, not a live sum. Its difference was
    // exactly zero at the moment it was finished — that is the only condition
    // under which it could have been finished at all — and it is frozen there.
    //
    // An ABANDONED one (LGR-22) is deliberately NOT in this branch. The freeze
    // above is justified by a fact abandonment does not supply: a finished
    // statement was provably at zero, an abandoned one was provably never
    // balanced, and pinning a figure it never held would be inventing history
    // rather than preserving it. It owns no postings either (only `finish`
    // stamps ownership), so it falls through to the live sum, which is the
    // honest answer to "how does this account stand against that target".
    //
    // Recomputing it live let a posting cleared AFTER the fact (through the
    // generic surface, on an entry this statement never matched) drag the
    // figure off zero, so a historical statement reported ITSELF out of balance
    // and claimed postings it had never touched. What a finished reconciliation
    // owns is written on the postings: `reconciliationId === its own id`.
    if (reconciliation.status === 'finished') {
      return {
        summary: {
          reconciliation,
          clearedBalanceMinor: reconciliation.statementBalanceMinor,
          differenceMinor: 0,
          matchedPostingIds: postings
            .filter(({posting}) => posting.reconciliationId === reconciliation.id)
            .map(({posting}) => posting.id)
            .sort(),
        },
        matched,
      };
    }
    return {
      summary: {
        reconciliation,
        clearedBalanceMinor,
        differenceMinor,
        matchedPostingIds: matched.map(({posting}) => posting.id).sort(),
      },
      matched,
    };
  }

  private async postingsForTx(q: Db, ids: LedgerIds, txId: string): Promise<LedgerPosting[]> {
    const rows = await q.query<Row>(
      `SELECT ${ROW_COLS} FROM pages WHERE database_id = $1 AND deleted_at IS NULL AND properties->>'${LEDGER_PROP.posting.transaction}' = $2
       ORDER BY position ASC, created_at ASC, id ASC`,
      [ids.postings, txId],
    );
    return rows.map(postingFromRow);
  }

  /**
   * Resolve validated evidence inputs into the stored manifest (LGR-14), inside
   * the caller's transaction: every named asset must EXIST in the
   * content-addressed store, and `size` comes from the store's own row — the
   * manifest never records a byte count the store does not hold. Order is the
   * caller's attach order (user-meaningful, and stable because updates are
   * wholesale replacements).
   */
  private async resolveEvidenceTx(tx: Db, items: readonly LedgerEvidenceInput[]): Promise<LedgerEvidence[]> {
    if (items.length === 0) return [];
    // `octet_length(bytes)`, NOT the cached `size` column (F4): the manifest is
    // about to be frozen into an immutable posted entry, and a pre-planted
    // wrong `size` cell would freeze a lie the verifier then flags forever on
    // an untampered book, with no repair path. Measuring the bytes themselves
    // removes the only way a manifest could be BORN lying.
    const rows = await tx.query<{id: string; size: number | string}>(
      'SELECT id, octet_length(bytes) AS size FROM assets WHERE id = ANY($1)',
      [items.map((i) => i.sha256)],
    );
    const sizeById = new Map(rows.map((r) => [r.id, Number(r.size)]));
    return items.map((i) => {
      const size = sizeById.get(i.sha256);
      if (size === undefined) {
        throw new LedgerError(
          'not-found',
          `evidence asset ${i.sha256} ("${i.filename}") is not in the asset store — upload the file first, then attach it by its content hash`,
        );
      }
      return {filename: i.filename, sha256: i.sha256, size};
    });
  }

  /**
   * Keep `asset_refs` in step with a draft's evidence manifest (LGR-14), inside
   * the caller's transaction. The ref of each evidence asset to the TRANSACTION
   * ROW page is load-bearing twice over:
   *
   *  - READ GATE: an asset inherits the read-gate of its referencing pages, so
   *    this ref is what makes a receipt readable to exactly the people who can
   *    read the ledger — not (only) to the readers of whatever page the file
   *    happened to be uploaded from.
   *  - DELETION: the asset GC (`gcUnreferencedAssets`) keeps any asset with a
   *    live ref, and — independently — any asset whose 64-hex id appears in ANY
   *    page's `properties` text, which the manifest in `lp_evidence` does from
   *    this same transaction on. Belt and braces: evidence attached to a ledger
   *    row is structurally un-reapable while the row lives, and a POSTED row
   *    lives forever (posted transactions cannot be deleted). There is no other
   *    asset-deletion path (no route or store method deletes asset rows), so
   *    removing posted evidence takes direct SQL — which is exactly what the
   *    verifier's evidence check exists to catch.
   *
   * Removal only drops the TX-ROW ref; a ref from the upload page (or anywhere
   * else) is not this module's to manage. A draft's hard-delete needs no code
   * here at all: `asset_refs.page_id` cascades when the row page goes.
   */
  private async syncEvidenceRefsTx(
    tx: Db,
    txRowId: string,
    next: readonly LedgerEvidence[],
    previous: readonly LedgerEvidence[],
  ): Promise<void> {
    const nextShas = new Set(next.map((e) => e.sha256));
    const prevShas = new Set(previous.map((e) => e.sha256));
    for (const sha of nextShas) {
      if (prevShas.has(sha)) continue;
      await tx.query(
        'INSERT INTO asset_refs (asset_id, page_id) VALUES ($1, $2) ON CONFLICT (asset_id, page_id) DO NOTHING',
        [sha, txRowId],
      );
    }
    for (const sha of prevShas) {
      if (nextShas.has(sha)) continue;
      await tx.query('DELETE FROM asset_refs WHERE asset_id = $1 AND page_id = $2', [sha, txRowId]);
    }
  }

  private async insertPostingsTx(
    tx: Db,
    ids: LedgerIds,
    txId: string,
    postings: readonly ValidatedPosting[],
  ): Promise<LedgerPosting[]> {
    const out: LedgerPosting[] = [];
    for (const p of postings) {
      const id = randomUUID();
      const row = await this.insertRowTx(tx, ids.postings, null, {
        [LEDGER_PROP.posting.transaction]: txId,
        [LEDGER_PROP.posting.account]: p.accountId,
        [LEDGER_PROP.posting.amount]: p.amountMinor,
        [LEDGER_PROP.posting.cleared]: p.cleared ?? 'pending',
        [LEDGER_PROP.posting.reconciliation]: null,
        // The row `name` stays null: a memo is content, and naming the row by it
        // would put free text on the generic page-title path the ledger's write
        // guards do not model.
        [LEDGER_PROP.posting.memo]: p.memo,
      }, id);
      out.push(postingFromRow(row));
    }
    return out;
  }

  /** Insert one ledger row page inside the caller's transaction. */
  private async insertRowTx(
    tx: Db,
    databaseId: string,
    name: string | null,
    properties: Record<string, unknown>,
    id: string,
  ): Promise<Row> {
    const rows = await tx.query<Row>(
      `INSERT INTO pages (id, name, data, database_id, properties, position, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5::jsonb,
         (SELECT COALESCE(MAX(position), -1) + 1 FROM pages WHERE database_id = $4), now())
       RETURNING ${ROW_COLS}`,
      [id, name, JSON.stringify(emptyPageSnapshot()), databaseId, JSON.stringify(properties)],
    );
    return rows[0];
  }

  /**
   * Invariant 5 — append ONE audit event, inside the mutation's transaction.
   *
   * The event is also CHAINED (tamper-evidence): `prev_hash` carries the
   * {@link ledgerAuditEventHash} of the current tail. A rolled-back mutation
   * writes no event, so it leaves a BIGSERIAL gap but an unbroken chain — which
   * is exactly how a legitimate gap is told apart from a deleted event.
   *
   * SERIALIZATION. The chain is only well-formed if appends are totally ordered,
   * and `SELECT … FOR UPDATE` CANNOT provide that: it locks the row it found and
   * cannot prevent a concurrent INSERT of a NEW tail. On real Postgres under
   * READ COMMITTED that is a live corruption path — T1 and T2 both find tail N,
   * T2 blocks on T1's row lock, T1 inserts N+1 and commits, T2 re-checks the
   * still-only-locked (never updated) row N, gets N back, and writes N+2 also
   * claiming `prev_hash = H(N)`. Two events share a predecessor, the chain is
   * permanently broken, and `verifyAuditChain` then reports a FALSE tampering
   * accusation with no repair path. (`post`/`reverse` were incidentally immune —
   * `nextEntryNumberTx` serializes them first — but `createAccount`,
   * `updateAccount`, the draft mutations, `setPostingCleared` and
   * `recordAclChange` all reach here with no prior global lock, so two
   * concurrent account creates sufficed. PGlite's FIFO mutex hides it entirely.)
   *
   * So the append takes a transaction-scoped ADVISORY lock first, which does
   * serialize inserts. Migration 0022's unique index on `prev_hash` is the
   * backstop: any residual race becomes a rolled-back transaction rather than a
   * silently forged chain.
   *
   * LOCK ORDER: `appendAuditTx` must stay the LAST lock taken in every path
   * (after the transaction/account row locks and `nextEntryNumberTx`). It is a
   * leaf in the lock graph, so no cycle — and therefore no deadlock — is
   * possible. Do not introduce a caller that locks something else after it.
   */
  private async appendAuditTx(
    tx: Db,
    actor: Principal | undefined,
    action: LedgerAuditAction,
    entityIds: string[],
    payload: Record<string, unknown>,
    beforeHash: string | null,
    afterHash: string | null,
  ): Promise<void> {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [LEDGER_AUDIT_CHAIN_LOCK]);
    const tail = await tx.query<AuditRow>('SELECT * FROM ledger_audit ORDER BY seq DESC LIMIT 1');
    // Hash the tail from its RAW row, NOT through `auditFromRow`: that validates
    // `action` against this build's allowlist and throws on an unknown one. On
    // the read path that is right (fail closed on an uninterpretable log), but
    // here it would BRICK the ledger on a routine downgrade — a build that
    // predates an action added later (e.g. `ledger.acl`) would throw on every
    // subsequent write, forever. The hash is taken over raw column values, so it
    // stays byte-identical across versions regardless of interpretability.
    const prevHash = tail.length > 0 ? await rawAuditRowHash(tail[0]) : null;
    await tx.query(
      `INSERT INTO ledger_audit (id, actor_subject, actor_name, action, entity_ids, payload, before_hash, after_hash, prev_hash)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)`,
      [
        randomUUID(),
        actor?.subject ?? '',
        actor?.name ?? '',
        action,
        JSON.stringify(entityIds),
        JSON.stringify(payload),
        beforeHash,
        afterHash,
        prevHash,
      ],
    );
  }

  /**
   * Verify the audit log's hash chain from the genesis event (LGR-3
   * tamper-evidence). Reads the whole log in ascending `seq`, so it is an
   * operator/verifier call, not a hot path.
   *
   * What this DOES prove, and what it does not, is spelled out on
   * {@link verifyLedgerAuditChain} — read it before relying on a green result.
   *
   * Verification hashes RAW rows, so a row whose `action` this build cannot
   * interpret still verifies structurally; the uninterpretable row is reported
   * as a NOT-OK result carrying its `seq` (an operator needs the location), never
   * as a thrown exception with no position information.
   */
  async verifyAuditChain(): Promise<LedgerAuditChainResult> {
    const rows = await this.db.query<AuditRow>('SELECT * FROM ledger_audit ORDER BY seq ASC');
    const unknown = rows.find((row) => !(LEDGER_AUDIT_ACTIONS as readonly string[]).includes(row.action));
    const chain = await verifyLedgerAuditChain(rows.map(rawAuditEvent));
    if (!chain.ok) return chain; // a broken link outranks an unreadable action
    if (unknown) {
      return {
        ok: false,
        checked: rows.length,
        brokenAtSeq: Number(unknown.seq),
        reason: `unknown ledger audit action ${JSON.stringify(unknown.action)} — the log holds an event this build cannot interpret`,
      };
    }
    return chain;
  }
}

// ── Row → entity projections ─────────────────────────────────────────────────

function accountFromRow(row: Row): LedgerAccount {
  const props = parseJson<Record<string, unknown>>(row.properties, {});
  return {
    id: row.id,
    name: row.name ?? '',
    type: (str(props[LEDGER_PROP.account.type]) || 'asset') as LedgerAccount['type'],
    status: (str(props[LEDGER_PROP.account.status]) || 'open') as LedgerAccount['status'],
    currency: str(props[LEDGER_PROP.account.currency]) || 'USD',
    // LGR-14: stored ONLY as `true` (the writer deletes the key on false), and
    // absent on every account written before LGR-14 — both read back `false`.
    evidenceRequired: props[LEDGER_PROP.account.evidenceRequired] === true,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function postingFromRow(row: Row): LedgerPosting {
  const props = parseJson<Record<string, unknown>>(row.properties, {});
  const amount = props[LEDGER_PROP.posting.amount];
  return {
    id: row.id,
    transactionId: str(props[LEDGER_PROP.posting.transaction]),
    accountId: str(props[LEDGER_PROP.posting.account]),
    amountMinor: typeof amount === 'number' ? amount : Number(amount ?? 0),
    cleared: (str(props[LEDGER_PROP.posting.cleared]) || 'pending') as LedgerPosting['cleared'],
    reconciliationId: strOrNull(props[LEDGER_PROP.posting.reconciliation]),
    // Absent on every posting written before LGR-16 — those read back as
    // `null`, which is exactly "no memo". No migration, no backfill.
    memo: strOrNull(props[LEDGER_PROP.posting.memo]),
  };
}

function reconciliationFromRow(row: Row): LedgerReconciliation {
  const props = parseJson<Record<string, unknown>>(row.properties, {});
  const balance = props[LEDGER_PROP.reconciliation.statementBalance];
  return {
    id: row.id,
    accountId: str(props[LEDGER_PROP.reconciliation.account]),
    statementDate: str(props[LEDGER_PROP.reconciliation.statementDate]),
    statementBalanceMinor: typeof balance === 'number' ? balance : Number(balance ?? 0),
    status: (str(props[LEDGER_PROP.reconciliation.status]) || 'open') as LedgerReconciliationStatus,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Why a reconciliation writer refused, phrased from the status the row IS IN and
 * naming the way forward from THERE.
 *
 * One function rather than a message per call site, because the three writers
 * that need it (amend, abandon, tick — all `required: 'open'`) would otherwise
 * each carry their own copy of the same three-way case and drift apart the first
 * time a status is added.
 */
function reconciliationStateRefusal(
  id: string,
  actual: LedgerReconciliationStatus,
  required: LedgerReconciliationStatus,
): string {
  if (required === 'finished') {
    return actual === 'abandoned'
      ? `reconciliation ${id} was abandoned — an abandoned statement froze nothing, so there is nothing to reopen; start a new reconciliation on this account instead`
      : `reconciliation ${id} is still open — only a finished reconciliation can be reopened`;
  }
  // required === 'open': the amend / abandon / tick surface.
  return actual === 'finished'
    ? `reconciliation ${id} is finished — reopen it before changing what it matched`
    : `reconciliation ${id} was abandoned and cannot be changed — start a new reconciliation on this account instead`;
}

function transactionFromRow(row: Row, postings: LedgerPosting[]): LedgerTransaction {
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
    // LGR-12: absent on every entry written before periods existed and on every
    // ordinary entry since — those read back as `null`. No migration.
    kind: props[LEDGER_PROP.transaction.kind] === 'closing' ? 'closing' : null,
    evidence: Array.isArray(evidence) ? (evidence as LedgerTransaction['evidence']) : [],
    postings,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Project a stored row into the event shape WITHOUT interpreting `action`. Used
 * for chain hashing, which must work on rows this build cannot interpret (see
 * {@link rawAuditRowHash}).
 */
function rawAuditEvent(row: AuditRow): LedgerAuditEvent {
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
    prevHash: row.prev_hash ?? null,
    createdAt: toIso(row.created_at),
  };
}

/**
 * The chain hash of a stored row, computed WITHOUT the action allowlist — so a
 * build that predates an action still links onto it correctly instead of
 * bricking every ledger write after a downgrade. Byte-identical to
 * `ledgerAuditEventHash(auditFromRow(row))` for any interpretable row.
 */
function rawAuditRowHash(row: AuditRow): Promise<string> {
  return ledgerAuditEventHash(rawAuditEvent(row));
}

function auditFromRow(row: AuditRow): LedgerAuditEvent {
  // Validate rather than cast (LGR-3): an unrecognised stored `action` means the
  // log holds something this build cannot interpret — a downgrade reading a
  // newer library, or a tampered row. Blind-casting it produced an event the
  // replay would then silently mis-handle; failing loudly keeps "the audit log
  // is a complete, interpretable record" an enforced property.
  //
  // This strictness is confined to the READ/replay path on purpose: the chain
  // WRITE path hashes raw rows (see {@link rawAuditRowHash}), so an unknown
  // action can never block appends.
  if (!(LEDGER_AUDIT_ACTIONS as readonly string[]).includes(row.action)) {
    throw new LedgerError('invalid-state', `unknown ledger audit action in the log: ${JSON.stringify(row.action)}`);
  }
  return rawAuditEvent(row);
}

/**
 * The hashable CONTENT of an account (timestamps excluded — not ledger content).
 *
 * `evidenceRequired` is OMITTED while false — the LGR-16/LGR-12 additive-field
 * discipline: this projection is applied to the live row, to the verifier's
 * independent re-read, AND to FROZEN audit payloads written before LGR-14
 * (which have no such key and are inside the hash chain, so they can never be
 * migrated). Emitting `evidenceRequired: false` would make every pre-LGR-14
 * account report as diverged. Mirror in `ledgerVerify.ts`'s `accountContent`,
 * symmetrically.
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
 * The hashable CONTENT of a reconciliation (LGR-11; timestamps excluded).
 *
 * Mirror this in `ledgerVerify.ts` for any new field, symmetrically — it is the
 * shape the verifier independently re-derives from the frozen audit payload, so
 * a field on one side only makes every reconciliation report as tampered with.
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

/**
 * The hashable CONTENT of a transaction + postings (timestamps excluded).
 *
 * ADDITIVE-FIELD DISCIPLINE (LGR-16, and owed to every field added after it):
 * a posting field that is ABSENT must hash exactly like a posting field that is
 * NULL, because this projection is applied to THREE things — the live row, the
 * verifier's independent re-read (`ledgerVerify.ts`), and the FROZEN audit
 * payload an older build wrote before the field existed. That third one cannot
 * be migrated: it is inside the hash chain. So the memo key is OMITTED when it
 * has no value rather than emitted as `null` (`canonicalLedgerJson` keeps
 * nulls), which makes a pre-LGR-16 payload and a post-LGR-16 row hash
 * identically. Emitting `memo: null` instead makes every entry written by an
 * older build report as mutated-outside-the-ledger. Mirror this in
 * `ledgerVerify.ts`'s `transactionContent`, symmetrically, for any new field.
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
      // LGR-16: the memo is ledger CONTENT, so it is inside the before/after
      // hash — editing a memo on a draft is a real change to the entry and must
      // not be invisible to the audit trail.
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
  // LGR-12, same additive-field discipline as the posting memo above: the key
  // is OMITTED when there is no kind, so a payload frozen before LGR-12 and a
  // post-LGR-12 row hash identically. Mirror in `ledgerVerify.ts`.
  if (t.kind != null) content.kind = t.kind;
  return content;
}

/** Project one stored periods-array element defensively into a LedgerPeriod. */
function periodFromStored(raw: unknown): LedgerPeriod {
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

/**
 * Do two income-balance computations agree exactly? Key set AND every amount —
 * the `period-close-conflict` comparison. Order-free (Maps compared by lookup).
 */
function balancesEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

/**
 * A transaction's FINANCIAL content, for the period hash chain: everything
 * `transactionContent` carries except each posting's `cleared` /
 * `reconciliationId`. Those are WORKFLOW metadata that stays mutable on a
 * posted entry (`setPostingCleared`, reconciliation freeze/thaw) — hashing them
 * into the period chain would make a legitimate tick on a closing-entry leg
 * break the close→reopen link and read as tampering.
 *
 * What covers the excluded fields instead (Quinn R2 — the replay comparison
 * ALONE does not: consistent surgery doctoring the raw row AND the frozen
 * payload to the same forged cleared state keeps replay in agreement on both
 * sides): the writer always emits closing/reversal legs `cleared: 'pending'`,
 * `reconciliationId: null`, and the VERIFIER asserts that invariant on the
 * frozen `period.close`/`period.reopen` payload postings
 * (`closing-posting-forged`), so the payload half of any such surgery is
 * flagged. A raw-row-only forgery is the ordinary out-of-band mutation the
 * replay comparison already catches.
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

/**
 * The combined content a `period.close` event's afterHash covers — the period
 * record AND the closing entry's financial content (or an explicit `null`), so
 * consistent surgery on either half breaks the recorded digest. This is also,
 * by construction, the preimage of a later `period.reopen` event's beforeHash:
 * a posted entry's financial content never changes, so re-deriving this at
 * reopen time reproduces the close-time bytes exactly and the period's hash
 * chain links.
 *
 * Mirror in `ledgerVerify.ts`, symmetrically (the LGR-22 discipline).
 */
export function periodCloseContent(period: LedgerPeriod, closingEntry: LedgerTransaction | null): Record<string, unknown> {
  return {period: periodContent(period), closingEntry: closingEntry ? closingEntryContent(closingEntry) : null};
}

/**
 * The combined content a `period.reopen` event's afterHash covers: the reopened
 * record and the voiding reversal's financial content. Nothing later extends
 * this chain — the verifier's re-derivation from the payload is the ONLY
 * detector for surgery on a reopened period, which is why the tamper test
 * exists (the LGR-22 lesson).
 */
export function periodReopenContent(period: LedgerPeriod, reversal: LedgerTransaction | null): Record<string, unknown> {
  return {period: periodContent(period), reversal: reversal ? closingEntryContent(reversal) : null};
}

/**
 * The hashable CONTENT of a period (LGR-12; audit timestamps and actor fields
 * excluded — who/when lives on the event itself). `reopenEntryId` is OMITTED
 * while null (additive-field discipline: the close-time hash has no key for it,
 * and the reopen-time hash gains one) so both sides of the period's hash chain
 * derive from exactly what each event's payload froze.
 *
 * Mirror this in `ledgerVerify.ts`, symmetrically, for any new field — it is
 * the shape the verifier independently re-derives from the frozen payload.
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

function validatePostingInput(p: LedgerPostingInput): ValidatedPosting {
  if (!p || typeof p.accountId !== 'string' || p.accountId.trim() === '') {
    throw new LedgerError('invalid-input', 'every posting needs an accountId');
  }
  if (!isValidMinor(p.amountMinor)) {
    throw new LedgerError(
      'invalid-amount',
      `posting amount must be a safe signed integer of minor units, got ${String(p.amountMinor)}`,
    );
  }
  if (p.cleared !== undefined && p.cleared !== 'pending' && p.cleared !== 'cleared') {
    throw new LedgerError('invalid-input', `invalid initial cleared state: ${JSON.stringify(p.cleared)} (reconciled is not settable here)`);
  }
  assertFreeText(p.memo, 'memo', {nullable: true});
  return {accountId: p.accountId, amountMinor: p.amountMinor, cleared: p.cleared, memo: normalizeMemo(p.memo)};
}

/** A posting input after validation — memo already collapsed to `string | null`. */
interface ValidatedPosting {
  accountId: string;
  amountMinor: number;
  cleared?: 'pending' | 'cleared';
  memo: string | null;
}

/**
 * Collapse an optional memo to its stored form. Omitted, `undefined`, `null`
 * and the EMPTY string are all one state — "no memo" — so a cleared memo box
 * and an untouched one round-trip identically instead of producing two
 * different audit payloads for the same entry.
 */
function normalizeMemo(memo: string | null | undefined): string | null {
  return typeof memo === 'string' && memo !== '' ? memo : null;
}

// ── Seeded database schemas ───────────────────────────────────────────────────

const selectOptions = (values: readonly string[]): DatabaseProperty['options'] =>
  values.map((v) => ({id: v, label: v.charAt(0).toUpperCase() + v.slice(1)}));

function managedSchema(properties: DatabaseProperty[], viewId: string, viewName: string): DatabaseSchema {
  return {
    properties,
    views: [
      {
        id: viewId,
        name: viewName,
        type: 'table',
        filters: [],
        sorts: [],
        visiblePropertyIds: properties.map((p) => p.id),
      },
    ],
    // Read-only marker for the UI; the authoritative write-gate keys off the
    // recorded ledger ids in the STORE layer (a user can't lock their own DB
    // by setting this flag — see database.ts `managed`).
    managed: true,
  };
}

function buildAccountsSchema(): DatabaseSchema {
  return managedSchema(
    [
      {id: LEDGER_PROP.account.type, name: 'Type', type: 'select', options: selectOptions(['asset', 'liability', 'equity', 'revenue', 'expense'])},
      {id: LEDGER_PROP.account.status, name: 'Status', type: 'select', options: selectOptions(['open', 'closed'])},
      {id: LEDGER_PROP.account.currency, name: 'Currency', type: 'text'},
      // LGR-14. `checkbox` (a plain property — no seed-frozen option list to go
      // stale, the LGR-22 lesson), and written only at SEED: a book seeded
      // before LGR-14 simply lacks this column in its managed view. The value
      // is still stored (properties are raw jsonb) and every ledger read goes
      // through `accountFromRow`, so enforcement is unaffected — the stale-seed
      // cost is an invisible column on a restricted page nobody works in (the
      // `lp_kind` precedent in buildTransactionsSchema).
      {id: LEDGER_PROP.account.evidenceRequired, name: 'Evidence required', type: 'checkbox'},
    ],
    'v_accounts',
    'Accounts',
  );
}

function buildTransactionsSchema(): DatabaseSchema {
  return managedSchema(
    [
      {id: LEDGER_PROP.transaction.date, name: 'Date', type: 'date'},
      {id: LEDGER_PROP.transaction.description, name: 'Description', type: 'text'},
      {id: LEDGER_PROP.transaction.state, name: 'State', type: 'select', options: selectOptions(['draft', 'posted', 'void'])},
      {id: LEDGER_PROP.transaction.postedAt, name: 'Posted at', type: 'date', includeTime: true},
      {id: LEDGER_PROP.transaction.postedBy, name: 'Posted by', type: 'text'},
      {id: LEDGER_PROP.transaction.reverses, name: 'Reverses', type: 'text'},
      {id: LEDGER_PROP.transaction.entryNo, name: 'Entry #', type: 'number'},
      {id: LEDGER_PROP.transaction.evidence, name: 'Evidence', type: 'text'},
      // LGR-12. `text`, not `select`, and written only at SEED: a book seeded
      // before LGR-12 simply lacks this column in its managed view — the value
      // is still stored (properties are raw jsonb) and every ledger read goes
      // through `transactionFromRow`, so correctness is unaffected. The
      // stale-seed cost is an invisible column on a restricted page nobody
      // works in (see the `buildReconciliationsSchema` status comment for the
      // select-options version of this lesson).
      {id: LEDGER_PROP.transaction.kind, name: 'Kind', type: 'text'},
    ],
    'v_transactions',
    'Transactions',
  );
}

function buildPostingsSchema(): DatabaseSchema {
  return managedSchema(
    [
      {id: LEDGER_PROP.posting.transaction, name: 'Transaction', type: 'text'},
      {id: LEDGER_PROP.posting.account, name: 'Account', type: 'text'},
      {id: LEDGER_PROP.posting.amount, name: 'Amount (minor)', type: 'number'},
      {id: LEDGER_PROP.posting.cleared, name: 'Cleared', type: 'select', options: selectOptions(['pending', 'cleared', 'reconciled'])},
      {id: LEDGER_PROP.posting.reconciliation, name: 'Reconciliation', type: 'text'},
      {id: LEDGER_PROP.posting.memo, name: 'Memo', type: 'text'},
    ],
    'v_postings',
    'Postings',
  );
}

function buildReconciliationsSchema(): DatabaseSchema {
  return managedSchema(
    [
      {id: LEDGER_PROP.reconciliation.account, name: 'Account', type: 'text'},
      {id: LEDGER_PROP.reconciliation.statementDate, name: 'Statement date', type: 'date'},
      {id: LEDGER_PROP.reconciliation.statementBalance, name: 'Statement balance (minor)', type: 'number'},
      // From the exported constant, not a second hand-written list: LGR-22 added
      // `abandoned` and a literal here would have silently kept the old two.
      //
      // These options are written only at SEED, so a book seeded before LGR-22
      // keeps the two-option list — and on such a book the managed database
      // view renders an abandoned row's Status cell as BLANK, not as unstyled
      // text: the view resolves a select by option id, and an id with no
      // option resolves to nothing. Correctness is unaffected (the store
      // writes the property as raw jsonb and never validates it against the
      // schema; every ledger read goes through `reconciliationFromRow`, not
      // the view), and that view is on a restricted page nobody works in, so
      // this ships without a schema backfill — but anyone adding a FOURTH
      // status should know the stale-seed cost is a blank cell, not a cosmetic
      // one, and weigh an ensure-options write then.
      {id: LEDGER_PROP.reconciliation.status, name: 'Status', type: 'select', options: selectOptions(LEDGER_RECONCILIATION_STATUSES)},
    ],
    'v_reconciliations',
    'Reconciliations',
  );
}
