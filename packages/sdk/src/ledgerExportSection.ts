/**
 * LX-2: the machine-readable **ledger section** an owner-initiated site export
 * embeds alongside its pages/databases, and the read-authorized capture that
 * builds it.
 *
 * ## Payload shape (the island's `ledger` key)
 * Ledger records live OUTSIDE the document (four managed databases behind a
 * restricted host page), so the export crawl never discovers them. When the
 * export set shows ledger blocks and the exporter opted in, the site island
 * carries a {@link LedgerExportSection}:
 *
 *  - `settings` — raw settings rows by key, the SAME keys the whole-space
 *    backup's {@link LedgerBackupSection} uses: `ledgerDb` (the seeded ids,
 *    reconstructed in the stored `LedgerIds` shape) and `ledgerPeriods` (the
 *    `LedgerPeriod[]` array, verbatim). `ledgerEntrySeq` is NOT carried — it
 *    has no client read surface; an importer can re-derive it from the highest
 *    entry number (LX-4's concern).
 *  - `library` — the ledger's own records in {@link LibrarySnapshot} shape
 *    (exactly how they travel in a backup bundle): the restricted root host
 *    page, the four child host pages, the four managed {@link StoredDatabase}s
 *    (full schema), and every row page.
 *  - `auditHead` — the newest audit event's `seq` + its chain hash
 *    ({@link ledgerAuditEventHash}): a cheap tamper-evidence ANCHOR. The full
 *    audit stream is deliberately NOT exported (a document export is not a
 *    backup; the stream can dwarf the books). Holding the anchor, a verifier
 *    with live access can prove the exported head is (or was) the real chain
 *    head; offline chain verification needs a real backup (LGR-15).
 *
 * ## Authorization (no escalation through export)
 * Every read below goes through the exporting principal's OWN {@link DataClient}
 * read paths — the same routes/guards that gate the ledger UI. A principal who
 * cannot read the ledger sees `ledgerInfo() → {exists:false}` (the server's
 * existence-hiding body) or 404s on the restricted pages; either way the
 * capture returns `null` and the export simply carries no ledger section (the
 * blocks render as placeholders, LX-1). Fail-closed: ANY partial read failure
 * drops the whole section rather than embedding an incomplete book.
 */
import type {DataClient} from './client';
import type {LibrarySnapshot} from './bookFolder';
import type {StoredDatabase} from './database';
import type {StoredPage} from './types';
import {
  LEDGER_ACCOUNT_STATUSES,
  LEDGER_ACCOUNT_TYPES,
  LEDGER_CLEARED_STATES,
  LEDGER_MAX_TRANSACTION_LIMIT,
  LEDGER_PERIOD_STATUSES,
  LEDGER_PROP,
  LEDGER_RECONCILIATION_STATUSES,
  LEDGER_TRANSACTION_STATES,
  isIncomeStatementAccountType,
  isValidLedgerAccountName,
  isValidLedgerDate,
  ledgerAuditEventHash,
  type LedgerAccountStatus,
  type LedgerAccountType,
  type LedgerClearedState,
  type LedgerDatabases,
  type LedgerPeriod,
  type LedgerReconciliationStatus,
  type LedgerTransactionState,
} from './ledger';
import {isValidCurrencyCode, isValidMinor} from './money';

/** Mirrors the server writer's free-text cap (`MAX_DESCRIPTION_LENGTH`) so a
 *  section that would be refused mid-replay is refused BEFORE the first write. */
const SECTION_MAX_TEXT = 1000;
/** Mirrors the server writer's per-entry posting cap (`MAX_POSTINGS_PER_TRANSACTION`). */
const SECTION_MAX_POSTINGS = 1000;

/** The ledger records embedded in a site export's source island (LX-2). */
export interface LedgerExportSection {
  /** Raw settings rows by key: `ledgerDb` (seeded ids) and `ledgerPeriods`
   *  (`LedgerPeriod[]`, present only when periods exist). Same keys as the
   *  backup bundle's `LedgerBackupSection.settings` (LGR-15). */
  settings: Record<string, unknown>;
  /** The ledger's own pages + databases, {@link LibrarySnapshot} shape: root
   *  host page, four child host pages, four managed databases, every row page. */
  library: LibrarySnapshot;
  /** Tamper-evidence anchor: the newest audit event's `seq` and chain hash.
   *  `null` when the audit stream is empty. The full stream is not exported. */
  auditHead: {seq: number; hash: string} | null;
}

const LEDGER_DB_KEYS = ['accounts', 'transactions', 'postings', 'reconciliations'] as const;

/** A page read that treats "missing" as failure — the ledger's own pages are
 *  never legitimately absent, so a `null` here means "not readable/consistent"
 *  and the whole capture must fail closed. */
async function requirePage(client: DataClient, id: string): Promise<StoredPage> {
  const page = await client.getPage(id);
  if (!page) throw new Error(`ledger export: page ${id} unreadable`);
  return page;
}

/**
 * Capture the {@link LedgerExportSection} through the exporting principal's own
 * read paths, or `null` when there is nothing to include: no seeded ledger,
 * a principal who cannot read it, or any partial read failure (fail-closed —
 * never embed half a book).
 */
export async function gatherLedgerExportSection(client: DataClient): Promise<LedgerExportSection | null> {
  try {
    const info = await client.ledgerInfo();
    if (!info.exists || !info.hostPageId || !info.databases) return null;

    const pages: StoredPage[] = [await requirePage(client, info.hostPageId)];
    const databases: StoredDatabase[] = [];
    const hostPages: Record<string, string> = {};
    const rowCount: Record<string, number> = {};
    for (const key of LEDGER_DB_KEYS) {
      const db = await client.getDatabase(info.databases[key]);
      if (!db) return null;
      databases.push(db);
      hostPages[key] = db.pageId;
      pages.push(await requirePage(client, db.pageId));
      const rows = await client.listRows(db.id);
      rowCount[key] = rows.length;
      for (const row of rows) {
        pages.push(await requirePage(client, row.id));
      }
    }

    // COMPLETENESS TRIPWIRE (fail-closed). The generic row reads above are
    // read-FILTERED per principal — a row the caller may not read is silently
    // omitted, never an error — while row pages do NOT inherit an ACL grant
    // placed on the ledger host pages (ancestor inheritance is OB-207). A
    // principal holding host grants but not row reads would otherwise export
    // schemas with zero (or partial) rows and no way to tell. The typed ledger
    // reads are gated on the host pages only, so cross-checking their counts
    // against the captured rows proves the generic surface was unfiltered.
    // Any mismatch ⇒ no section: never embed half a book.
    const accounts = await client.ledgerListAccounts();
    if (rowCount.accounts !== accounts.length) return null;
    const reconciliations = await client.ledgerListReconciliations();
    if (rowCount.reconciliations !== reconciliations.length) return null;
    const transactions = await client.ledgerListTransactions({limit: LEDGER_MAX_TRANSACTION_LIMIT});
    // The typed transaction read is CAPPED (the server clamps `limit` to
    // LEDGER_MAX_TRANSACTION_LIMIT), so the parity check is only sound when
    // the result is known-complete — strictly under the cap. AT the cap there
    // is no requireLedger-gated, uncapped count surface to prove completeness
    // against (`ledgerVerify` is admin-gated, not a read surface), so fail
    // CLOSED: a >=1000-tx book with partially-granted row pages would
    // otherwise ship a complete chart of accounts plus a silently partial
    // journal. Never embed half a book — a book that big belongs in a real
    // backup (LGR-15), not a document export.
    if (transactions.length >= LEDGER_MAX_TRANSACTION_LIMIT) return null;
    if (rowCount.transactions !== transactions.length) return null;
    const postings = transactions.reduce((n, t) => n + t.postings.length, 0);
    if (rowCount.postings !== postings) return null;

    // The stored `ledgerDb` settings-row shape (server `LedgerIds`), rebuilt
    // from reads the principal is authorized for.
    const ledgerDb: {hostPageId: string; hostPages: Record<string, string>} & LedgerDatabases = {
      hostPageId: info.hostPageId,
      ...info.databases,
      hostPages,
    };
    const periods = await client.ledgerListPeriods();
    const settings: Record<string, unknown> = {
      ledgerDb,
      ...(periods.length > 0 ? {ledgerPeriods: periods} : {}),
    };

    const [head] = await client.ledgerListAudit({limit: 1});
    const auditHead = head ? {seq: head.seq, hash: await ledgerAuditEventHash(head)} : null;

    return {settings, library: {pages, databases}, auditHead};
  } catch {
    // Unreadable (guest/viewer without a grant), mid-flight revocation, or any
    // transport failure: no section. The export still succeeds without records.
    return null;
  }
}

// ── LX-4: parse a section back into a typed, replayable book ─────────────────
//
// The import half of the LX-2 round trip. `readLibraryIsland` already
// SHAPE-validated the island's `ledger` key (untrusted input — see
// `readLedgerSection` in bookFolder.ts); this layer goes deeper: it projects
// the raw row pages into typed ledger entities and validates every SEMANTIC
// invariant a replay through the server's ledger writer relies on, so a
// crafted or corrupted section is refused BEFORE the first write. Pure and
// DOM-free, so the UI can preview a section and the server can re-validate the
// same way (one validator, two callers — never two validators).

/** One account as the section records it (source ids kept for mapping). */
export interface LedgerSectionAccount {
  id: string;
  name: string;
  type: LedgerAccountType;
  status: LedgerAccountStatus;
  currency: string;
  evidenceRequired: boolean;
}

/** One posting as the section records it. */
export interface LedgerSectionPosting {
  id: string;
  accountId: string;
  amountMinor: number;
  cleared: LedgerClearedState;
  reconciliationId: string | null;
  memo: string | null;
}

/** One journal entry as the section records it. */
export interface LedgerSectionTransaction {
  id: string;
  date: string;
  description: string;
  state: LedgerTransactionState;
  reverses: string | null;
  entryNo: number | null;
  kind: 'closing' | null;
  /** Evidence manifest items recorded on the entry. An HTML export carries no
   *  evidence BYTES, so a restore drops these (counted, surfaced, never silent). */
  evidenceCount: number;
  postings: LedgerSectionPosting[];
  createdAt: string;
}

/** One statement reconciliation as the section records it. */
export interface LedgerSectionReconciliation {
  id: string;
  accountId: string;
  statementDate: string;
  statementBalanceMinor: number;
  status: LedgerReconciliationStatus;
  createdAt: string;
}

/** The typed book a valid section parses to — the replay plan's input. */
export interface LedgerSectionBook {
  accounts: LedgerSectionAccount[];
  /** Sorted for replay: posted/void entries by entry number, drafts last. */
  transactions: LedgerSectionTransaction[];
  reconciliations: LedgerSectionReconciliation[];
  /** Period records verbatim from `settings.ledgerPeriods` ([] when absent). */
  periods: LedgerPeriod[];
  auditHead: LedgerExportSection['auditHead'];
  /** Total evidence manifest items the section records (not restorable from HTML). */
  evidenceDropped: number;
}

export type LedgerSectionParseResult =
  | {ok: true; book: LedgerSectionBook}
  | {ok: false; reason: string};

/** What a section restore reports back (see the server's `restoreExportSection`). */
export interface LedgerSectionRestoreResult {
  restored: {accounts: number; transactions: number; postings: number; reconciliations: number; periods: number};
  /** Evidence manifest items that could not be restored — an HTML export
   *  carries no evidence bytes; recover them from a backup bundle (LGR-15). */
  evidenceDropped: number;
  /** Finished reconciliations whose exact freeze could not be reproduced
   *  (exotic reopen histories) and were replayed as ABANDONED instead —
   *  workflow metadata only; the postings and report numbers are unaffected. */
  reconciliationsDowngraded: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asStrOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

/** Refusal helper: every `ok: false` reason is prefixed consistently. */
const refuse = (reason: string): LedgerSectionParseResult => ({ok: false, reason});

/** Overflow-refusing minor-unit addition: `null` when the sum leaves the safe
 *  integer range (±2^53) — the caller turns that into a typed refusal, never a
 *  thrown MoneyError mid-parse (the total-refusal contract). */
const addMinor = (a: number, b: number): number | null => {
  const sum = a + b;
  return Number.isSafeInteger(sum) ? sum : null;
};

/**
 * Parse + deep-validate a {@link LedgerExportSection} into a replayable
 * {@link LedgerSectionBook}, or refuse with a reason. Refusals are TOTAL —
 * a section is either a coherent book or it is not restored at all (never a
 * partial parse the writer then trips over halfway).
 *
 * Validated here (beyond the island reader's shape check):
 *  - the `ledgerDb` ids resolve to four DISTINCT databases the section carries;
 *  - every row page belongs to one of the four (host pages are pass-through);
 *  - enums, dates, and amounts are valid; posted/void entries balance to zero
 *    with ≥2 postings; postings reference known accounts/transactions;
 *  - the reversal graph is coherent: every `void` entry has exactly one
 *    reversal, every reversal negates its original leg-for-leg;
 *  - reconciliation invariants: `reconciled` ⇔ frozen by a FINISHED
 *    reconciliation on the same account, at most one OPEN per account;
 *  - period records are well-formed, closing entries are referenced by
 *    exactly one period, and closed ranges do not overlap.
 */
export function parseLedgerExportSection(section: LedgerExportSection): LedgerSectionParseResult {
  // The HTTP door hands this raw request JSON — hold the whole envelope to the
  // same suspicion as its contents (a null/array body must refuse, not throw).
  if (!isRecord(section) || !isRecord(section.settings) || !isRecord(section.library)) {
    return refuse('the section is not a {settings, library, auditHead} object');
  }
  if (!Array.isArray(section.library.pages) || !Array.isArray(section.library.databases)) {
    return refuse('the section library does not carry pages[] and databases[]');
  }
  // STRICT envelope (Sasha F1's root): every key of the section, its settings,
  // and its library must be one this parser reads. An unread key is a place
  // arbitrarily deep/large junk can hide — junk the validated projection (and
  // therefore the provenance hash) would silently exclude — so its presence is
  // a refusal, not a shrug. A future exporter that adds a key must teach this
  // parser to read it (fail closed beats silently dropping new content).
  for (const key of Object.keys(section)) {
    if (key !== 'settings' && key !== 'library' && key !== 'auditHead') {
      return refuse(`unexpected section key ${JSON.stringify(key)} — this export is newer than this importer, or the file was tampered with`);
    }
  }
  for (const key of Object.keys(section.settings)) {
    if (key !== 'ledgerDb' && key !== 'ledgerPeriods') {
      return refuse(`unexpected settings key ${JSON.stringify(key)}`);
    }
  }
  for (const key of Object.keys(section.library)) {
    if (key !== 'pages' && key !== 'databases') {
      return refuse(`unexpected library key ${JSON.stringify(key)}`);
    }
  }
  // Element-level shape guards (Sasha F2): the arrays are untrusted too — a
  // null/primitive element must refuse before anything dereferences it.
  for (const p of section.library.pages) {
    if (!isRecord(p) || typeof p.id !== 'string' || p.id === '') {
      return refuse('a library page entry is not a record with a string id');
    }
  }
  for (const d of section.library.databases) {
    if (!isRecord(d) || typeof d.id !== 'string' || d.id === '' || typeof d.pageId !== 'string') {
      return refuse('a library database entry is not a record with string id and pageId');
    }
  }
  let auditHead: LedgerExportSection['auditHead'] = null;
  if (section.auditHead !== null && section.auditHead !== undefined) {
    const {seq, hash} = section.auditHead as {seq?: unknown; hash?: unknown};
    // The hash is copied verbatim into the provenance payload (an append-only
    // audit row), so it is bounded to exactly what a chain hash IS — 64 hex
    // chars — and the seq to a non-negative safe integer (Quinn 4).
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      return refuse('the section auditHead is not null or {seq: non-negative integer, hash: 64 hex chars}');
    }
    auditHead = {seq, hash};
  }
  const rawIds = section.settings?.[
    'ledgerDb'
  ] as Partial<{hostPageId: string} & LedgerDatabases & {hostPages: Record<string, string>}> | undefined;
  if (!isRecord(rawIds)) return refuse('the section has no ledgerDb settings entry');
  const dbIds: Partial<Record<(typeof LEDGER_DB_KEYS)[number], string>> = {};
  for (const key of LEDGER_DB_KEYS) {
    const id = (rawIds as Record<string, unknown>)[key];
    if (typeof id !== 'string' || id === '') return refuse(`the ledgerDb settings entry has no ${key} database id`);
    dbIds[key] = id;
  }
  if (new Set(Object.values(dbIds)).size !== LEDGER_DB_KEYS.length) {
    return refuse('the four ledger database ids are not distinct');
  }
  const carried = new Set(section.library.databases.map((d) => d.id));
  for (const key of LEDGER_DB_KEYS) {
    if (!carried.has(dbIds[key] as string)) return refuse(`the section does not carry the ${key} database it names`);
  }

  // ── Project row pages into entities (host pages — databaseId null — skipped).
  const accounts: LedgerSectionAccount[] = [];
  const txRows: Array<{page: StoredPage; props: Record<string, unknown>}> = [];
  const postingRows: Array<{page: StoredPage; props: Record<string, unknown>}> = [];
  const reconciliations: LedgerSectionReconciliation[] = [];
  const seenIds = new Set<string>();
  for (const page of section.library.pages) {
    if (!page.databaseId) continue; // a host page carries no entity
    if (seenIds.has(page.id)) return refuse(`duplicate row id ${page.id}`);
    seenIds.add(page.id);
    const props = isRecord(page.properties) ? page.properties : {};
    if (page.databaseId === dbIds.accounts) {
      const type = props[LEDGER_PROP.account.type];
      const status = props[LEDGER_PROP.account.status] ?? 'open';
      const name = asStr(page.name);
      if (!isValidLedgerAccountName(name)) return refuse(`account ${page.id} has an invalid name ${JSON.stringify(page.name)}`);
      if (!oneOf(type, LEDGER_ACCOUNT_TYPES)) return refuse(`account ${name} has an invalid type ${JSON.stringify(type)}`);
      if (!oneOf(status, LEDGER_ACCOUNT_STATUSES)) return refuse(`account ${name} has an invalid status ${JSON.stringify(status)}`);
      const currency = asStr(props[LEDGER_PROP.account.currency]) || 'USD';
      if (!isValidCurrencyCode(currency)) return refuse(`account ${name} has an invalid currency ${JSON.stringify(currency)}`);
      accounts.push({
        id: page.id,
        name,
        type,
        status,
        currency,
        evidenceRequired: props[LEDGER_PROP.account.evidenceRequired] === true,
      });
    } else if (page.databaseId === dbIds.transactions) {
      txRows.push({page, props});
    } else if (page.databaseId === dbIds.postings) {
      postingRows.push({page, props});
    } else if (page.databaseId === dbIds.reconciliations) {
      const status = props[LEDGER_PROP.reconciliation.status] ?? 'open';
      const balance = props[LEDGER_PROP.reconciliation.statementBalance];
      const statementDate = props[LEDGER_PROP.reconciliation.statementDate];
      if (!oneOf(status, LEDGER_RECONCILIATION_STATUSES)) return refuse(`reconciliation ${page.id} has an invalid status`);
      if (!isValidLedgerDate(statementDate)) return refuse(`reconciliation ${page.id} has an invalid statement date`);
      if (!isValidMinor(balance)) return refuse(`reconciliation ${page.id} has an invalid statement balance`);
      reconciliations.push({
        id: page.id,
        accountId: asStr(props[LEDGER_PROP.reconciliation.account]),
        statementDate,
        statementBalanceMinor: balance,
        status,
        createdAt: asStr(page.createdAt),
      });
    } else {
      return refuse(`row ${page.id} belongs to database ${page.databaseId}, which is not one of the four ledger databases`);
    }
  }
  if (txRows.length > LEDGER_MAX_TRANSACTION_LIMIT) {
    return refuse(`the section carries ${txRows.length} journal entries — over the ${LEDGER_MAX_TRANSACTION_LIMIT}-entry ceiling an export section may hold (a book that size travels in a backup bundle, not a document export)`);
  }

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const recById = new Map(reconciliations.map((r) => [r.id, r]));

  // ── Postings, grouped under their transactions (order: `position`, the
  // stored sibling key — posting order feeds the audited content hash).
  const postingsByTx = new Map<string, Array<{posting: LedgerSectionPosting; position: number}>>();
  for (const {page, props} of postingRows) {
    const txId = asStr(props[LEDGER_PROP.posting.transaction]);
    const accountId = asStr(props[LEDGER_PROP.posting.account]);
    const amount = props[LEDGER_PROP.posting.amount];
    const cleared = props[LEDGER_PROP.posting.cleared] ?? 'pending';
    if (!accountById.has(accountId)) return refuse(`posting ${page.id} references unknown account ${accountId || '(none)'}`);
    if (!isValidMinor(amount)) return refuse(`posting ${page.id} has an invalid amount`);
    if (!oneOf(cleared, LEDGER_CLEARED_STATES)) return refuse(`posting ${page.id} has an invalid cleared state`);
    const reconciliationId = asStrOrNull(props[LEDGER_PROP.posting.reconciliation]);
    if (reconciliationId !== null && !recById.has(reconciliationId)) {
      return refuse(`posting ${page.id} references unknown reconciliation ${reconciliationId}`);
    }
    // Invariant 4, both directions: `reconciled` means frozen by a FINISHED
    // reconciliation on the posting's own account, and nothing else does.
    if ((cleared === 'reconciled') !== (reconciliationId !== null)) {
      return refuse(`posting ${page.id} breaks the reconciled↔frozen invariant`);
    }
    if (reconciliationId !== null) {
      const rec = recById.get(reconciliationId) as LedgerSectionReconciliation;
      if (rec.status !== 'finished') return refuse(`posting ${page.id} is frozen by reconciliation ${rec.id}, which is not finished`);
      if (rec.accountId !== accountId) return refuse(`posting ${page.id} is frozen by a reconciliation on another account`);
    }
    const memo = props[LEDGER_PROP.posting.memo];
    if (memo !== undefined && memo !== null && typeof memo !== 'string') return refuse(`posting ${page.id} has a non-string memo`);
    if (typeof memo === 'string' && memo.length > SECTION_MAX_TEXT) return refuse(`posting ${page.id} has a memo over the ${SECTION_MAX_TEXT}-character cap`);
    const list = postingsByTx.get(txId) ?? [];
    list.push({
      posting: {id: page.id, accountId, amountMinor: amount, cleared, reconciliationId, memo: asStrOrNull(memo)},
      position: typeof page.position === 'number' && Number.isFinite(page.position) ? page.position : list.length,
    });
    postingsByTx.set(txId, list);
  }

  // ── Transactions.
  const transactions: LedgerSectionTransaction[] = [];
  for (const {page, props} of txRows) {
    const date = props[LEDGER_PROP.transaction.date];
    const state = props[LEDGER_PROP.transaction.state] ?? 'draft';
    if (!isValidLedgerDate(date)) return refuse(`journal entry ${page.id} has an invalid date`);
    if (!oneOf(state, LEDGER_TRANSACTION_STATES)) return refuse(`journal entry ${page.id} has an invalid state`);
    const entryNoRaw = props[LEDGER_PROP.transaction.entryNo];
    const entryNo = typeof entryNoRaw === 'number' && Number.isFinite(entryNoRaw) ? entryNoRaw : null;
    const kind = props[LEDGER_PROP.transaction.kind] === 'closing' ? 'closing' : null;
    const evidence = props[LEDGER_PROP.transaction.evidence];
    const description = asStr(props[LEDGER_PROP.transaction.description]);
    if (description.length > SECTION_MAX_TEXT) return refuse(`journal entry ${page.id} has a description over the ${SECTION_MAX_TEXT}-character cap`);
    const ordered = (postingsByTx.get(page.id) ?? []).sort((a, b) => a.position - b.position).map((p) => p.posting);
    postingsByTx.delete(page.id);
    if (ordered.length > SECTION_MAX_POSTINGS) return refuse(`journal entry ${page.id} has more than ${SECTION_MAX_POSTINGS} postings`);
    if (state !== 'draft') {
      if (entryNo === null) return refuse(`${state} entry ${page.id} has no entry number`);
      if (ordered.length < 2) return refuse(`${state} entry ${page.id} has fewer than 2 postings`);
      let balance: number | null = 0;
      for (const p of ordered) {
        balance = addMinor(balance, p.amountMinor);
        if (balance === null) return refuse(`${state} entry ${page.id} postings overflow the safe integer range`);
      }
      if (balance !== 0) return refuse(`${state} entry ${page.id} does not balance to zero`);
    } else if (ordered.some((p) => p.cleared === 'reconciled')) {
      return refuse(`draft entry ${page.id} carries a reconciled posting`);
    }
    if (kind === 'closing' && state === 'draft') return refuse(`closing entry ${page.id} is a draft`);
    transactions.push({
      id: page.id,
      date,
      description,
      state,
      reverses: asStrOrNull(props[LEDGER_PROP.transaction.reverses]),
      entryNo,
      kind,
      evidenceCount: Array.isArray(evidence) ? evidence.length : 0,
      postings: ordered,
      createdAt: asStr(page.createdAt),
    });
  }
  if (postingsByTx.size > 0) {
    const [orphanTx] = postingsByTx.keys();
    return refuse(`postings reference journal entry ${orphanTx}, which the section does not carry`);
  }

  const txById = new Map(transactions.map((t) => [t.id, t]));

  // ── Reversal graph: every void entry has exactly one reversal, and every
  // reversal negates its original leg for leg (the writer will regenerate the
  // reversal from the original, so a section claiming otherwise cannot replay
  // faithfully and is refused rather than silently rewritten).
  const reversalsOf = new Map<string, LedgerSectionTransaction[]>();
  for (const tx of transactions) {
    if (tx.reverses === null) continue;
    const original = txById.get(tx.reverses);
    if (!original) return refuse(`reversal ${tx.id} reverses unknown entry ${tx.reverses}`);
    if (tx.state === 'draft') return refuse(`reversal ${tx.id} is a draft`);
    if (original.state !== 'void') return refuse(`reversal ${tx.id} reverses entry ${original.id}, which is ${original.state}, not void`);
    const legs = new Map<string, number>();
    for (const p of [...original.postings, ...tx.postings]) {
      const next = addMinor(legs.get(p.accountId) ?? 0, p.amountMinor);
      if (next === null) return refuse(`reversal ${tx.id} postings overflow the safe integer range`);
      legs.set(p.accountId, next);
    }
    if ([...legs.values()].some((v) => v !== 0)) {
      return refuse(`reversal ${tx.id} does not negate entry ${original.id} leg for leg`);
    }
    reversalsOf.set(original.id, [...(reversalsOf.get(original.id) ?? []), tx]);
  }
  for (const tx of transactions) {
    if (tx.state === 'void' && (reversalsOf.get(tx.id) ?? []).length !== 1) {
      return refuse(`void entry ${tx.id} does not have exactly one reversal`);
    }
  }

  // ── Reconciliations: at most one OPEN per account; accounts resolve.
  const openByAccount = new Set<string>();
  for (const rec of reconciliations) {
    if (!accountById.has(rec.accountId)) return refuse(`reconciliation ${rec.id} references unknown account ${rec.accountId || '(none)'}`);
    if (rec.status === 'open') {
      if (openByAccount.has(rec.accountId)) return refuse(`account ${rec.accountId} has more than one open reconciliation`);
      openByAccount.add(rec.accountId);
    }
  }

  // ── Periods (from settings.ledgerPeriods — the stored row, verbatim).
  const rawPeriods = section.settings?.['ledgerPeriods'];
  const periods: LedgerPeriod[] = [];
  if (rawPeriods !== undefined && rawPeriods !== null) {
    if (!Array.isArray(rawPeriods)) return refuse('ledgerPeriods is not an array');
    for (const raw of rawPeriods) {
      if (!isRecord(raw)) return refuse('a period record is not an object');
      const {id, start, end, status, closingEntryId, reopenEntryId} = raw as Partial<LedgerPeriod>;
      if (typeof id !== 'string' || id === '') return refuse('a period record has no id');
      if (!isValidLedgerDate(start) || !isValidLedgerDate(end) || end < start) return refuse(`period ${id} has an invalid date range`);
      if (!oneOf(status, LEDGER_PERIOD_STATUSES)) return refuse(`period ${id} has an invalid status`);
      const closing = asStrOrNull(closingEntryId ?? null);
      const reopen = asStrOrNull(reopenEntryId ?? null);
      if (closing !== null) {
        const entry = txById.get(closing);
        if (!entry || entry.kind !== 'closing') return refuse(`period ${id} names closing entry ${closing}, which the section does not carry as a closing entry`);
        const expectedState = status === 'closed' ? 'posted' : 'void';
        if (entry.state !== expectedState) return refuse(`period ${id} is ${status} but its closing entry ${closing} is ${entry.state}`);
      }
      if (status === 'reopened') {
        if (closing !== null && (reopen === null || txById.get(reopen)?.reverses !== closing)) {
          return refuse(`period ${id} was reopened but its reversal entry is missing or does not reverse its closing entry`);
        }
      } else if (reopen !== null) {
        return refuse(`period ${id} is closed but records a reopen entry`);
      }
      periods.push({
        id,
        start,
        end,
        status,
        closingEntryId: closing,
        reopenEntryId: reopen,
        closedAt: asStr((raw as Record<string, unknown>).closedAt),
        closedBy: asStr((raw as Record<string, unknown>).closedBy),
        reopenedAt: asStrOrNull((raw as Record<string, unknown>).reopenedAt),
        reopenedBy: asStrOrNull((raw as Record<string, unknown>).reopenedBy),
      });
    }
    // Closed ranges must not overlap (the store enforces this live; a section
    // claiming otherwise could never have come from the writer).
    const closed = periods.filter((p) => p.status === 'closed').sort((a, b) => (a.start < b.start ? -1 : 1));
    for (let i = 1; i < closed.length; i += 1) {
      if (closed[i].start <= closed[i - 1].end) return refuse(`closed periods ${closed[i - 1].id} and ${closed[i].id} overlap`);
    }
  }
  // Every closing entry belongs to exactly one period record.
  const claimedClosings = new Set(periods.map((p) => p.closingEntryId).filter((id): id is string => id !== null));
  for (const tx of transactions) {
    if (tx.kind === 'closing' && !claimedClosings.has(tx.id)) {
      return refuse(`closing entry ${tx.id} is not referenced by any period record`);
    }
  }

  // ── Period entries must be workflow-PRISTINE (Quinn 1). The restore
  // REGENERATES closing entries and reopen reversals through
  // closePeriod/reopenPeriod, whose legs are always born `pending`/unowned —
  // a cleared tick on one would be silently dropped, and a leg frozen by a
  // finished reconciliation could not be re-frozen at all (its posting is
  // minted after the reconciliation pass). Either way the section cannot
  // replay faithfully: refuse totally, and point at the lane that can.
  const closingIds = new Set(transactions.filter((t) => t.kind === 'closing').map((t) => t.id));
  for (const tx of transactions) {
    const isPeriodEntry = tx.kind === 'closing' || (tx.reverses !== null && closingIds.has(tx.reverses));
    if (!isPeriodEntry) continue;
    for (const p of tx.postings) {
      if (p.cleared !== 'pending' || p.reconciliationId !== null) {
        return refuse(
          `period entry ${tx.id} carries workflow state on a posting (a cleared tick or a reconciliation freeze) that a document-export restore cannot replay — restore from a backup bundle instead`,
        );
      }
    }
  }

  // ── The closing sweeps must REPLAY to what the section records (Quinn 2).
  // The restore's closePeriod recomputes each sweep over the FULLY-replayed
  // books, while the source computed it over the books as they stood at close
  // time — and the store legally admits entries dated in or before a period
  // that were posted after its close (the date lock only covers dates INSIDE
  // a closed range). Simulate every close in the replay's own chronology and
  // refuse totally on any divergence, so per-account balances can never
  // silently differ after a "successful" restore.
  if (periods.length > 0) {
    const incomeIds = new Set(accounts.filter((a) => isIncomeStatementAccountType(a.type)).map((a) => a.id));
    const periodEntryIds = new Set<string>();
    for (const p of periods) {
      if (p.closingEntryId) periodEntryIds.add(p.closingEntryId);
      if (p.reopenEntryId) periodEntryIds.add(p.reopenEntryId);
    }
    // What exists when the period replay starts: every ordinary posted/void
    // entry (the replay lands them all first). Period entries join as their
    // close/reopen events are replayed. State (posted vs void) is irrelevant —
    // the store's sweep counts BOTH (a void original is offset by its posted
    // reversal), so existence alone decides.
    const onBooks = new Set(transactions.filter((t) => t.state !== 'draft' && !periodEntryIds.has(t.id)).map((t) => t.id));
    const events: Array<{at: string; kind: 'close' | 'reopen'; period: LedgerPeriod}> = [];
    for (const p of periods) {
      events.push({at: p.closedAt || '', kind: 'close', period: p});
      if (p.status === 'reopened') events.push({at: p.reopenedAt || p.closedAt || '', kind: 'reopen', period: p});
    }
    events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.kind === b.kind ? 0 : a.kind === 'close' ? -1 : 1));
    for (const ev of events) {
      if (ev.kind === 'reopen') {
        if (ev.period.reopenEntryId) onBooks.add(ev.period.reopenEntryId);
        continue;
      }
      // The sweep closePeriod will regenerate: every income account's
      // cumulative balance over on-the-books entries dated ≤ end.
      const balances = new Map<string, number>();
      for (const tx of transactions) {
        if (!onBooks.has(tx.id) || tx.date > ev.period.end) continue;
        for (const p of tx.postings) {
          if (!incomeIds.has(p.accountId)) continue;
          const next = addMinor(balances.get(p.accountId) ?? 0, p.amountMinor);
          if (next === null) return refuse(`the income sweep for period ${ev.period.id} overflows the safe integer range`);
          balances.set(p.accountId, next);
        }
      }
      for (const [accountId, balance] of balances) {
        if (balance === 0) balances.delete(accountId);
      }
      const mismatch = (): LedgerSectionParseResult =>
        refuse(
          `the closing entry recorded for period ${ev.period.start} – ${ev.period.end} does not match the sweep a restore would regenerate — entries dated in or before the period were posted after it was closed. This book cannot round-trip through a document export; restore from a backup bundle instead`,
        );
      const closing = ev.period.closingEntryId === null ? undefined : txById.get(ev.period.closingEntryId);
      if (!closing) {
        if (balances.size > 0) return mismatch();
        continue; // nothing to sweep, nothing recorded — consistent
      }
      // Recorded legs, netted per account; must be exactly: one leg per
      // nonzero income balance (negated) plus ONE non-income (retained-
      // earnings) leg carrying the sweep total.
      const legs = new Map<string, number>();
      for (const p of closing.postings) {
        const next = addMinor(legs.get(p.accountId) ?? 0, p.amountMinor);
        if (next === null) return refuse(`closing entry ${closing.id} postings overflow the safe integer range`);
        legs.set(p.accountId, next);
      }
      let total: number | null = 0;
      for (const [accountId, balance] of balances) {
        if (legs.get(accountId) !== -balance) return mismatch();
        legs.delete(accountId);
        total = addMinor(total, balance);
        if (total === null) return refuse(`the income sweep for period ${ev.period.id} overflows the safe integer range`);
      }
      const rest = [...legs.entries()];
      if (rest.length !== 1 || incomeIds.has(rest[0][0]) || rest[0][1] !== total) return mismatch();
      onBooks.add(closing.id);
    }
  }

  // ── Replay order: posted/void by entry number, then drafts by creation.
  transactions.sort((a, b) => {
    const an = a.entryNo ?? Number.MAX_SAFE_INTEGER;
    const bn = b.entryNo ?? Number.MAX_SAFE_INTEGER;
    if (an !== bn) return an - bn;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;
  });

  const evidenceDropped = transactions.reduce((n, t) => n + t.evidenceCount, 0);
  return {
    ok: true,
    book: {accounts, transactions, reconciliations, periods, auditHead, evidenceDropped},
  };
}
