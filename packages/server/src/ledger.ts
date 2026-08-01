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
 *  4. `reconciled` postings can't change cleared state except via reconciliation
 *     reopen (the `via: 'reconciliation'` hook; flows arrive in LGR-11).
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
  LEDGER_PROP,
  LedgerError,
  MoneyError,
  assertUniformCurrency,
  canonicalLedgerJson,
  emptyPageSnapshot,
  isValidCurrencyCode,
  isValidLedgerAccountName,
  isValidLedgerDate,
  isValidMinor,
  ledgerAuditEventHash,
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
  type LedgerInfo,
  type LedgerPosting,
  type LedgerPostingInput,
  type LedgerReverseOptions,
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

/** Maximum length of a transaction description (LGR-3 F5). Long values are
 *  copied into EVERY audit payload, so this bounds the log's growth too. */
const MAX_DESCRIPTION_LENGTH = 1000;

/**
 * Advisory-lock key serializing audit-chain appends (see
 * {@link LedgerStore.appendAuditTx}). Transaction-scoped, so it is released on
 * commit or rollback with no cleanup path to get wrong. An arbitrary but fixed
 * 64-bit constant — it only has to be distinct from any other advisory lock the
 * application takes (today: none).
 */
const LEDGER_AUDIT_CHAIN_LOCK = 0x1e_d6_e5_a0;

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

/** Validate an optional free-text description (LGR-3 F5): a string within
 *  {@link MAX_DESCRIPTION_LENGTH}. A non-string 500'd; a multi-megabyte value
 *  blew the btree index limit and bloated every audit payload. */
function assertDescription(description: unknown): void {
  if (description === undefined) return;
  if (typeof description !== 'string') {
    throw new LedgerError('invalid-input', `description must be a string, got ${typeof description}`);
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new LedgerError(
      'invalid-input',
      `description must be at most ${MAX_DESCRIPTION_LENGTH} characters, got ${description.length}`,
    );
  }
}

/**
 * The server-enforced double-entry ledger over the page store. Construct via
 * `store.ledger` (one instance per store); every method is safe to call from
 * both the HTTP routes and `LocalDataClient`.
 */
export class LedgerStore {
  /** In-flight seed, shared so concurrent first inits create ONE set of databases. */
  private seeding: Promise<LedgerInfo> | null = null;

  constructor(
    private readonly store: PageStore,
    private readonly db: Db,
  ) {}

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
    await this.db.begin(async (tx) => {
      await tx.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [LEDGER_DB_SETTING_KEY, JSON.stringify(ids)],
      );
      await this.appendAuditTx(tx, actor, 'ledger.init', [host.id], {hostPageId: host.id, databases: ids}, null, null);
    });
    // The settings row was written on the transaction, bypassing `setSetting`'s
    // cache invalidation — drop the store's cached ids so every guard arms now.
    this.store.invalidateLedgerIds();
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
    const id = randomUUID();
    const properties = {
      [LEDGER_PROP.account.type]: input.type,
      [LEDGER_PROP.account.status]: 'open',
      [LEDGER_PROP.account.currency]: currency,
    };
    return this.db.begin(async (tx) => {
      const rows = await this.insertRowTx(tx, ids.accounts, input.name, properties, id);
      const account = accountFromRow(rows);
      await this.appendAuditTx(tx, actor, 'account.create', [id], {account}, null, await sha256Hex(canonicalLedgerJson(accountContent(account))));
      return account;
    });
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
    return this.db.begin(async (tx) => {
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
      const updated = await tx.query<Row>(
        `UPDATE pages SET name = $3, properties = $4::jsonb, updated_at = now() WHERE id = $1 AND database_id = $2
         RETURNING ${ROW_COLS}`,
        [id, ids.accounts, patch.name ?? before.name, JSON.stringify(props)],
      );
      const account = accountFromRow(updated[0]);
      await this.appendAuditTx(
        tx,
        actor,
        'account.update',
        [id],
        {account},
        await sha256Hex(canonicalLedgerJson(accountContent(before))),
        await sha256Hex(canonicalLedgerJson(accountContent(account))),
      );
      return account;
    });
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

  async listTransactions(opts: {state?: LedgerTransactionState; limit?: number} = {}): Promise<LedgerTransaction[]> {
    const ids = await this.requireIds();
    const txRows = await this.db.query<Row>(
      `SELECT ${ROW_COLS} FROM pages WHERE database_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC, id DESC`,
      [ids.transactions],
    );
    const postingRows = await this.db.query<Row>(
      `SELECT ${ROW_COLS} FROM pages WHERE database_id = $1 AND deleted_at IS NULL ORDER BY position ASC, created_at ASC`,
      [ids.postings],
    );
    const postingsByTx = new Map<string, LedgerPosting[]>();
    for (const row of postingRows) {
      const posting = postingFromRow(row);
      const list = postingsByTx.get(posting.transactionId) ?? [];
      list.push(posting);
      postingsByTx.set(posting.transactionId, list);
    }
    let out = txRows.map((row) => transactionFromRow(row, postingsByTx.get(row.id) ?? []));
    if (opts.state) out = out.filter((t) => t.state === opts.state);
    const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 500)));
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
    const txId = randomUUID();
    return this.db.begin(async (tx) => {
      const row = await this.insertRowTx(tx, ids.transactions, input.description ?? null, {
        [LEDGER_PROP.transaction.date]: input.date,
        [LEDGER_PROP.transaction.description]: input.description ?? '',
        [LEDGER_PROP.transaction.state]: 'draft',
      }, txId);
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
    return this.db.begin(async (tx) => {
      const {row, props, before} = await this.lockDraftTx(tx, ids, id);
      if (patch.date !== undefined) props[LEDGER_PROP.transaction.date] = patch.date;
      if (patch.description !== undefined) props[LEDGER_PROP.transaction.description] = patch.description;
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
  }

  /**
   * Delete a DRAFT and its postings. Permanent (never via the trash — a restore
   * could resurrect rows behind the ledger's back) and audited. Posted/void
   * transactions reject with `immutable`.
   */
  async deleteDraft(id: string, actor?: Principal): Promise<boolean> {
    const ids = await this.requireIds();
    return this.db.begin(async (tx) => {
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
  }

  /**
   * POST a draft — the enforcement heart. ONE transaction validates every
   * invariant, assigns the monotonic entry number, stamps posted_at/posted_by
   * (set once, never mutated), records the (empty, v1) evidence list, and
   * appends the audit event. Any failure rolls the whole thing back.
   */
  async post(id: string, actor?: Principal): Promise<LedgerTransaction> {
    const ids = await this.requireIds();
    return this.db.begin(async (tx) => {
      const {props, before} = await this.lockDraftTx(tx, ids, id, 'post');
      const postings = await this.postingsForTx(tx, ids, id);
      await this.validatePostable(tx, ids, postings);
      const entryNo = await this.nextEntryNumberTx(tx);
      props[LEDGER_PROP.transaction.state] = 'posted';
      props[LEDGER_PROP.transaction.postedAt] = new Date().toISOString();
      props[LEDGER_PROP.transaction.postedBy] = actor?.subject ?? '';
      props[LEDGER_PROP.transaction.entryNo] = entryNo;
      props[LEDGER_PROP.transaction.evidence] = []; // recorded at post; LGR-14 fills it
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
  }

  /**
   * REVERSE a posted transaction: atomically create AND post the reversing
   * entry (postings negated, `reverses` linked, its own entry number) and flip
   * the original to `void` — the only sanctioned mutation of a posted entry,
   * and the only way to void one. Exactly ONE audit event covers the pair.
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
    return this.db.begin(async (tx) => {
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
      const beforeHash = await sha256Hex(canonicalLedgerJson(transactionContent(original)));

      const negated = originalPostings.map((p) => ({
        accountId: p.accountId,
        amountMinor: p.amountMinor === 0 ? 0 : -p.amountMinor,
        cleared: 'pending' as const,
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
      })));

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
        [LEDGER_PROP.transaction.evidence]: [],
      }, reversingId);
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
   * Change a posting's cleared state. `pending ↔ cleared` is the open workflow;
   * ANY transition touching `reconciled` (to it or from it) is locked behind the
   * `via: 'reconciliation'` hook — the enforcement seam the LGR-11 reconciliation
   * flows (finish / reopen) will call. Cleared state is workflow metadata, so it
   * remains mutable on posted transactions (the financial content does not).
   */
  async setPostingCleared(
    id: string,
    cleared: LedgerClearedState,
    opts: {via?: 'reconciliation'} = {},
    actor?: Principal,
  ): Promise<LedgerPosting> {
    const ids = await this.requireIds();
    if (!['pending', 'cleared', 'reconciled'].includes(cleared)) {
      throw new LedgerError('invalid-input', `invalid cleared state: ${JSON.stringify(cleared)}`);
    }
    return this.db.begin(async (tx) => {
      const rows = await tx.query<Row>(
        `SELECT ${ROW_COLS} FROM pages WHERE id = $1 AND database_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [id, ids.postings],
      );
      if (rows.length === 0) throw new LedgerError('not-found', 'posting not found');
      const props = parseJson<Record<string, unknown>>(rows[0].properties, {});
      const current = (str(props[LEDGER_PROP.posting.cleared]) || 'pending') as LedgerClearedState;
      if ((current === 'reconciled' || cleared === 'reconciled') && opts.via !== 'reconciliation') {
        throw new LedgerError(
          'reconciled-locked',
          'a reconciled posting can only change cleared state through a reconciliation reopen (LGR-11)',
        );
      }
      props[LEDGER_PROP.posting.cleared] = cleared;
      const updated = await tx.query<Row>(
        `UPDATE pages SET properties = $3::jsonb, updated_at = now() WHERE id = $1 AND database_id = $2 RETURNING ${ROW_COLS}`,
        [id, ids.postings, JSON.stringify(props)],
      );
      const posting = postingFromRow(updated[0]);
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
   */
  private async validatePostable(tx: Db, ids: LedgerIds, postings: LedgerPosting[]): Promise<void> {
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

  private async postingsForTx(q: Db, ids: LedgerIds, txId: string): Promise<LedgerPosting[]> {
    const rows = await q.query<Row>(
      `SELECT ${ROW_COLS} FROM pages WHERE database_id = $1 AND deleted_at IS NULL AND properties->>'${LEDGER_PROP.posting.transaction}' = $2
       ORDER BY position ASC, created_at ASC`,
      [ids.postings, txId],
    );
    return rows.map(postingFromRow);
  }

  private async insertPostingsTx(
    tx: Db,
    ids: LedgerIds,
    txId: string,
    postings: Array<{accountId: string; amountMinor: number; cleared?: 'pending' | 'cleared'}>,
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
  };
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

/** The hashable CONTENT of an account (timestamps excluded — not ledger content). */
function accountContent(a: LedgerAccount): Record<string, unknown> {
  return {id: a.id, name: a.name, type: a.type, status: a.status, currency: a.currency};
}

/** The hashable CONTENT of a transaction + postings (timestamps excluded). */
function transactionContent(t: LedgerTransaction): Record<string, unknown> {
  return {
    id: t.id,
    date: t.date,
    description: t.description,
    state: t.state,
    postedAt: t.postedAt,
    postedBy: t.postedBy,
    reverses: t.reverses,
    entryNo: t.entryNo,
    evidence: t.evidence,
    postings: t.postings.map((p) => ({
      id: p.id,
      accountId: p.accountId,
      amountMinor: p.amountMinor,
      cleared: p.cleared,
      reconciliationId: p.reconciliationId,
    })),
  };
}

function validatePostingInput(p: LedgerPostingInput): {accountId: string; amountMinor: number; cleared?: 'pending' | 'cleared'} {
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
  return {accountId: p.accountId, amountMinor: p.amountMinor, cleared: p.cleared};
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
      {id: LEDGER_PROP.reconciliation.status, name: 'Status', type: 'select', options: selectOptions(['open', 'finished'])},
    ],
    'v_reconciliations',
    'Reconciliations',
  );
}
