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
import {LEDGER_MAX_TRANSACTION_LIMIT, ledgerAuditEventHash, type LedgerDatabases} from './ledger';

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
    // The typed transaction read is capped; the check is only sound when the
    // result is known-complete. Beyond the cap the accounts tripwire above
    // still catches the (uniform) filtered-principal case.
    if (transactions.length < LEDGER_MAX_TRANSACTION_LIMIT) {
      if (rowCount.transactions !== transactions.length) return null;
      const postings = transactions.reduce((n, t) => n + t.postings.length, 0);
      if (rowCount.postings !== postings) return null;
    }

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
