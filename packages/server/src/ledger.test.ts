/**
 * Server ledger core (LGR-3) — store-level enforcement tests.
 *
 * Pins the acceptance surface at the STORE layer (the browser-local path):
 *  - post-time invariant rejections with typed LedgerErrors: unbalanced /
 *    single-posting / orphan account ref / non-integer amount / closed account /
 *    currency mismatch; n-ary compound entries post fine;
 *  - kill-mid-post transactionality: a failure injected inside the posting
 *    transaction leaves NO partial state (no state flip, no entry number, no
 *    audit event, no sequence advance) — likewise for draft creation;
 *  - posted transactions + postings are immutable, corrections go through the
 *    reversal pair; drafts stay mutable/deletable;
 *  - direct store writes to ledger rows are rejected (managed) — createRow /
 *    updateRow / upsertPage / renamePage / setPageProperties / deletePage /
 *    movePage / updateDatabase / deleteDatabase / reorderRows — and the trash
 *    purge sweeps never touch ledger rows;
 *  - every mutation appends EXACTLY ONE append-only audit event; replaying the
 *    stream reconstructs current state; no update/delete path on the audit
 *    table exists anywhere in the server source;
 *  - entry numbers are server-assigned, monotonic, and gapless across failed
 *    attempts; migration 0020 is idempotent (statements re-run cleanly);
 *  - a restore bundle (overwrite mode) cannot tamper with ledger rows.
 */

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {beforeEach, describe, expect, it} from 'vitest';
import {
  LEDGER_DEFAULT_TRANSACTION_LIMIT,
  LEDGER_ERROR_CODES,
  LEDGER_MAX_TRANSACTION_LIMIT,
  LedgerError,
  ledgerErrorStatus,
  emptyPageSnapshot,
  ledgerAuditEventHash,
  replayLedgerAudit,
  type LedgerAuditEvent,
  type Principal,
  type StoredDatabase,
  type StoredPage,
} from '@book.dev/sdk';
import {PgliteDb, type Db} from './db';
import {runMigrations} from './migrations';
import {PageStore} from './store';
import {LEDGER_ENTRY_SEQ_SETTING_KEY} from './ledger';

const ACTOR: Principal = {kind: 'user', subject: 'https://iss#tester', issuer: 'https://iss', name: 'Tester', verifiedVia: 'jws'};

/**
 * A Db wrapper that can be ARMED to fail the first query whose SQL contains a
 * marker substring — the kill-mid-post injection for the transactionality tests.
 * Wraps transactions too, so a failure INSIDE `begin` aborts (rolls back) it.
 */
class SabotageDb implements Db {
  armed: string | null = null;

  constructor(private readonly inner: Db) {}

  private check(text: string): void {
    if (this.armed && text.includes(this.armed)) {
      this.armed = null;
      throw new Error(`sabotage: ${text.slice(0, 40)}`);
    }
  }

  async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
    this.check(text);
    return this.inner.query<T>(text, params);
  }

  begin<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.inner.begin((tx) => fn(new SabotageTx(tx, this)));
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

class SabotageTx implements Db {
  constructor(
    private readonly tx: Db,
    private readonly parent: SabotageDb,
  ) {}

  async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
    if (this.parent.armed && text.includes(this.parent.armed)) {
      this.parent.armed = null;
      throw new Error(`sabotage: ${text.slice(0, 40)}`);
    }
    return this.tx.query<T>(text, params);
  }

  begin<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.tx.begin((inner) => fn(new SabotageTx(inner, this.parent)));
  }

  close(): Promise<void> {
    return this.tx.close();
  }
}

let raw: PgliteDb;
let db: SabotageDb;
let store: PageStore;

beforeEach(async () => {
  raw = await PgliteDb.create('memory://');
  db = new SabotageDb(raw);
  store = new PageStore(db);
  await store.migrate();
});

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'NO-ERROR';
  } catch (err) {
    if (err instanceof LedgerError) return err.code;
    throw err;
  }
};

const auditCount = async (): Promise<number> => {
  const rows = await db.query<{n: string | number}>('SELECT COUNT(*) AS n FROM ledger_audit');
  return Number(rows[0].n);
};

/** Seed + two USD accounts; returns their ids. */
const seedWithAccounts = async (): Promise<{cash: string; income: string}> => {
  await store.ledger.ensureSetup(ACTOR);
  const cash = await store.ledger.createAccount({name: 'Assets:Bank:Checking', type: 'asset'}, ACTOR);
  const income = await store.ledger.createAccount({name: 'Revenue:Sales', type: 'revenue'}, ACTOR);
  return {cash: cash.id, income: income.id};
};

/** Corrupt one stored posting property via raw SQL (bypasses the store guards). */
const corruptPosting = async (postingId: string, key: string, value: unknown): Promise<void> => {
  const rows = await db.query<{properties: Record<string, unknown> | string}>('SELECT properties FROM pages WHERE id = $1', [postingId]);
  const props = typeof rows[0].properties === 'string' ? (JSON.parse(rows[0].properties) as Record<string, unknown>) : rows[0].properties;
  props[key] = value;
  await db.query('UPDATE pages SET properties = $2::jsonb WHERE id = $1', [postingId, JSON.stringify(props)]);
};

describe('LGR-3 — setup', () => {
  it('seeds four managed databases on a restricted host page, idempotently', async () => {
    const first = await store.ledger.ensureSetup(ACTOR);
    const second = await store.ledger.ensureSetup(ACTOR);
    expect(first.exists).toBe(true);
    expect(second).toEqual(first);
    // One host page only.
    const hosts = await db.query<{id: string}>('SELECT id FROM pages WHERE name = \'Ledger\' AND deleted_at IS NULL');
    expect(hosts).toHaveLength(1);
    expect(await store.getPageVisibility(first.hostPageId as string)).toBe('restricted');
    for (const dbId of Object.values(first.databases ?? {})) {
      const database = await store.getDatabase(dbId);
      expect(database?.schema.managed).toBe(true);
      // Each database sits on its own restricted child page under the root.
      const hostPage = await store.getPage(database!.pageId);
      expect(hostPage?.parentId).toBe(first.hostPageId);
      expect(await store.getPageVisibility(database!.pageId)).toBe('restricted');
    }
    // Exactly one ledger.init audit event across both calls.
    const events = await store.ledger.listAudit();
    expect(events.filter((e) => e.action === 'ledger.init')).toHaveLength(1);
  });

  it('reports not-initialized before setup', async () => {
    expect(await code(store.ledger.listAccounts())).toBe('not-initialized');
    expect((await store.ledger.info()).exists).toBe(false);
  });
});

describe('LGR-8 — listTransactions paging bounds', () => {
  /**
   * The ledger plugin's reports request exactly {@link LEDGER_MAX_TRANSACTION_LIMIT}
   * and treat a FULL page as "there may be more" — so a cap that silently drops
   * below the requested number would make a truncated read look complete, and a
   * partial trial balance would render as a whole one. Both sides now read the
   * one SDK constant; this pins that the store's clamp actually honours it.
   *
   * Detection bound: a lowered cap is caught here for any cap below the seeded
   * book size (asserted explicitly), which is what a regression would look like.
   */
  it('honours the requested page size and never clamps a request below the exported cap', async () => {
    const {cash, income} = await seedWithAccounts();
    for (let i = 0; i < 6; i += 1) {
      const draft = await store.ledger.createDraft(
        {date: '2026-08-01', description: `Entry ${i}`, postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -100}]},
        ACTOR,
      );
      await store.ledger.post(draft.id, ACTOR);
    }

    // A page size below the book is honoured exactly (the slice works)…
    expect(await store.ledger.listTransactions({limit: 3})).toHaveLength(3);
    // …and asking for the cap (what the reports do) returns the WHOLE book, not
    // a smaller clamp. If the cap were lowered under 6, this returns fewer.
    expect(LEDGER_MAX_TRANSACTION_LIMIT).toBeGreaterThan(6);
    expect(await store.ledger.listTransactions({limit: LEDGER_MAX_TRANSACTION_LIMIT})).toHaveLength(6);
    // A request ABOVE the cap is clamped to it — never an error, and never more
    // than the cap's worth of rows.
    const over = await store.ledger.listTransactions({limit: LEDGER_MAX_TRANSACTION_LIMIT * 10});
    expect(over.length).toBeLessThanOrEqual(LEDGER_MAX_TRANSACTION_LIMIT);
    expect(over).toHaveLength(6);
    // Degenerate sizes floor at one row rather than returning an empty page.
    expect(await store.ledger.listTransactions({limit: 0})).toHaveLength(1);
    expect(await store.ledger.listTransactions({limit: -5})).toHaveLength(1);
    // The default page size is the exported default, not a literal.
    expect(LEDGER_DEFAULT_TRANSACTION_LIMIT).toBeLessThanOrEqual(LEDGER_MAX_TRANSACTION_LIMIT);
  });
});

describe('LGR-3 — migration 0020', () => {
  it('is idempotent: statements re-run cleanly after the record is dropped', async () => {
    await db.query('DELETE FROM _migrations WHERE name = \'0020_ledger_audit\'');
    await runMigrations(db); // second full application of the same SQL
    const applied = await db.query<{name: string}>('SELECT name FROM _migrations WHERE name = \'0020_ledger_audit\'');
    expect(applied).toHaveLength(1);
    const tables = await db.query<{table_name: string}>(
      'SELECT table_name FROM information_schema.tables WHERE table_name = \'ledger_audit\'',
    );
    expect(tables).toHaveLength(1);
  });
});

describe('LGR-3 — post-time invariants (typed rejections)', () => {
  it('rejects an unbalanced entry', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -50}]},
      ACTOR,
    );
    expect(await code(store.ledger.post(draft.id, ACTOR))).toBe('unbalanced');
    expect((await store.ledger.getTransaction(draft.id))?.state).toBe('draft');
  });

  it('rejects a single-posting entry', async () => {
    const {cash} = await seedWithAccounts();
    const draft = await store.ledger.createDraft({date: '2026-08-01', postings: [{accountId: cash, amountMinor: 0}]}, ACTOR);
    expect(await code(store.ledger.post(draft.id, ACTOR))).toBe('too-few-postings');
  });

  it('rejects an orphan account reference', async () => {
    const {cash} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: randomUUID(), amountMinor: -100}]},
      ACTOR,
    );
    expect(await code(store.ledger.post(draft.id, ACTOR))).toBe('account-not-found');
  });

  it('rejects a closed account', async () => {
    const {cash, income} = await seedWithAccounts();
    await store.ledger.updateAccount(income, {status: 'closed'}, ACTOR); // zero balance → closes fine
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -100}]},
      ACTOR,
    );
    expect(await code(store.ledger.post(draft.id, ACTOR))).toBe('account-closed');
  });

  it('rejects a non-integer stored amount at post, and already at draft input', async () => {
    const {cash, income} = await seedWithAccounts();
    // Draft input path — typed rejection before anything is written.
    expect(
      await code(store.ledger.createDraft({date: '2026-08-01', postings: [{accountId: cash, amountMinor: 10.5}, {accountId: income, amountMinor: -10.5}]}, ACTOR)),
    ).toBe('invalid-amount');
    // Post path — corrupt a stored amount underneath the API (raw SQL).
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -100}]},
      ACTOR,
    );
    await corruptPosting(draft.postings[0].id, 'lp_amount_minor', 10.5);
    expect(await code(store.ledger.post(draft.id, ACTOR))).toBe('invalid-amount');
  });

  it('rejects mixed currencies across the postings', async () => {
    const {cash} = await seedWithAccounts();
    const eur = await store.ledger.createAccount({name: 'Assets:Bank:EUR', type: 'asset', currency: 'EUR'}, ACTOR);
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: eur.id, amountMinor: -100}]},
      ACTOR,
    );
    expect(await code(store.ledger.post(draft.id, ACTOR))).toBe('currency-mismatch');
  });

  it('posts an n-ary compound entry and stamps posted_at/posted_by/entry number', async () => {
    const {cash, income} = await seedWithAccounts();
    const fees = await store.ledger.createAccount({name: 'Expenses:Fees', type: 'expense'}, ACTOR);
    const draft = await store.ledger.createDraft(
      {
        date: '2026-08-01',
        description: 'Sale with fee',
        postings: [
          {accountId: cash, amountMinor: 9_700},
          {accountId: fees.id, amountMinor: 300},
          {accountId: income, amountMinor: -10_000},
        ],
      },
      ACTOR,
    );
    const posted = await store.ledger.post(draft.id, ACTOR);
    expect(posted.state).toBe('posted');
    expect(posted.entryNo).toBe(1);
    expect(posted.postedBy).toBe(ACTOR.subject);
    expect(posted.postedAt).toBeTruthy();
    expect(posted.evidence).toEqual([]);
    expect(posted.postings).toHaveLength(3);
  });
});

describe('LGR-3 — transactionality (kill-mid-post leaves no partial state)', () => {
  it('a failure inside the posting transaction rolls back everything', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -100}]},
      ACTOR,
    );
    const auditBefore = await auditCount();
    db.armed = 'INSERT INTO ledger_audit'; // fail the LAST step inside the begin
    await expect(store.ledger.post(draft.id, ACTOR)).rejects.toThrow(/sabotage/);
    // No state flip, no entry number, no posted_at.
    const after = await store.ledger.getTransaction(draft.id);
    expect(after?.state).toBe('draft');
    expect(after?.entryNo).toBeNull();
    expect(after?.postedAt).toBeNull();
    // No audit event.
    expect(await auditCount()).toBe(auditBefore);
    // No sequence advance — the next successful post is still entry #1.
    expect(await store.getSetting(LEDGER_ENTRY_SEQ_SETTING_KEY)).toBeNull();
    const posted = await store.ledger.post(draft.id, ACTOR);
    expect(posted.entryNo).toBe(1);
  });

  it('a failure inside draft creation leaves no transaction row, postings, or audit event', async () => {
    const {cash, income} = await seedWithAccounts();
    const info = await store.ledger.info();
    const auditBefore = await auditCount();
    const pageCount = async (): Promise<number> => {
      const rows = await db.query<{n: string | number}>(
        'SELECT COUNT(*) AS n FROM pages WHERE database_id IN ($1, $2)',
        [info.databases?.transactions, info.databases?.postings],
      );
      return Number(rows[0].n);
    };
    const pagesBefore = await pageCount();
    db.armed = 'INSERT INTO ledger_audit';
    await expect(
      store.ledger.createDraft(
        {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -100}]},
        ACTOR,
      ),
    ).rejects.toThrow(/sabotage/);
    expect(await pageCount()).toBe(pagesBefore);
    expect(await auditCount()).toBe(auditBefore);
  });
});

describe('LGR-3 — immutability of posted entries; drafts stay mutable', () => {
  it('drafts can be updated and deleted; posted/void reject with typed errors', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -100}]},
      ACTOR,
    );
    // Invariant 3 — draft mutation + deletion allowed.
    const updated = await store.ledger.updateDraft(
      draft.id,
      {description: 'renamed', postings: [{accountId: cash, amountMinor: 250}, {accountId: income, amountMinor: -250}]},
      ACTOR,
    );
    expect(updated.description).toBe('renamed');
    expect(updated.postings.map((p) => p.amountMinor)).toEqual([250, -250]);
    const doomed = await store.ledger.createDraft({date: '2026-08-02'}, ACTOR);
    expect(await store.ledger.deleteDraft(doomed.id, ACTOR)).toBe(true);
    expect(await store.ledger.getTransaction(doomed.id)).toBeNull();

    // Invariant 2 — posted is immutable via every ledger mutation path.
    const posted = await store.ledger.post(draft.id, ACTOR);
    expect(await code(store.ledger.updateDraft(posted.id, {description: 'nope'}, ACTOR))).toBe('immutable');
    expect(await code(store.ledger.deleteDraft(posted.id, ACTOR))).toBe('immutable');
    expect(await code(store.ledger.post(posted.id, ACTOR))).toBe('invalid-state');
  });

  it('reversal is the only void path: links reverses, voids the original, restores balance', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 5_000}, {accountId: income, amountMinor: -5_000}]},
      ACTOR,
    );
    const posted = await store.ledger.post(draft.id, ACTOR);
    expect(await store.ledger.accountPostedBalance(cash)).toBe(5_000);

    const reversal = await store.ledger.reverse(posted.id, {}, ACTOR);
    expect(reversal.state).toBe('posted');
    expect(reversal.reverses).toBe(posted.id);
    expect(reversal.entryNo).toBe(2);
    expect(reversal.postings.map((p) => p.amountMinor).sort((a, b) => a - b)).toEqual([-5_000, 5_000]);
    const original = await store.ledger.getTransaction(posted.id);
    expect(original?.state).toBe('void');
    // Financial content of the original untouched.
    expect(original?.entryNo).toBe(1);
    expect(original?.postings.map((p) => p.amountMinor)).toEqual([5_000, -5_000]);
    expect(await store.ledger.accountPostedBalance(cash)).toBe(0);
    // A void entry can't be reversed again; drafts can't be reversed.
    expect(await code(store.ledger.reverse(posted.id, {}, ACTOR))).toBe('invalid-state');
    const draft2 = await store.ledger.createDraft({date: '2026-08-02'}, ACTOR);
    expect(await code(store.ledger.reverse(draft2.id, {}, ACTOR))).toBe('invalid-state');
  });

  it('entry numbers stay monotonic and gapless across failed attempts', async () => {
    const {cash, income} = await seedWithAccounts();
    const mk = async (amount: number) =>
      store.ledger.createDraft(
        {date: '2026-08-01', postings: [{accountId: cash, amountMinor: amount}, {accountId: income, amountMinor: -amount}]},
        ACTOR,
      );
    const a = await mk(100);
    expect((await store.ledger.post(a.id, ACTOR)).entryNo).toBe(1);
    // A failed (unbalanced) attempt must not burn a number.
    const bad = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 7}, {accountId: income, amountMinor: -8}]},
      ACTOR,
    );
    expect(await code(store.ledger.post(bad.id, ACTOR))).toBe('unbalanced');
    const b = await mk(200);
    expect((await store.ledger.post(b.id, ACTOR)).entryNo).toBe(2);
  });
});

describe('LGR-3 — store-level managed guards (local-mode parity)', () => {
  it('rejects every direct store write/delete path into ledger rows', async () => {
    const {cash, income} = await seedWithAccounts();
    const info = await store.ledger.info();
    const dbs = info.databases!;
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -100}]},
      ACTOR,
    );
    const posted = await store.ledger.post(draft.id, ACTOR);

    // Row-level surface.
    expect(await code(store.createRow(dbs.transactions, {name: 'forged'}))).toBe('managed');
    expect(await code(store.updateRow(dbs.postings, posted.postings[0].id, {properties: {lp_amount_minor: 999}}))).toBe('managed');
    expect(await code(store.reorderRows(dbs.postings, [posted.postings[0].id]))).toBe('managed');
    // Page-level surface (rows are pages).
    expect(await code(store.upsertPage({id: posted.id, name: 'clobbered', data: emptyPageSnapshot()}))).toBe('managed');
    expect(await code(store.renamePage(posted.id, 'clobbered'))).toBe('managed');
    expect(await code(store.setPageProperties(posted.id, {lp_state: 'draft'}))).toBe('managed');
    expect(await code(store.deletePage(posted.id))).toBe('managed');
    expect(await code(store.movePage(info.hostPageId as string, null, []))).toBe('managed');
    // Host + database-level surface.
    expect(await code(store.upsertPage({id: info.hostPageId as string, name: 'renamed host', data: emptyPageSnapshot()}))).toBe('managed');
    expect(await code(store.deletePage(info.hostPageId as string))).toBe('managed');
    expect(await code(store.updateDatabase(dbs.postings, {name: 'tampered'}))).toBe('managed');
    expect(await code(store.deleteDatabase(dbs.transactions))).toBe('managed');
    // DRAFTS are protected from the generic surface too — mutation goes through
    // the ledger API only (which allows it — invariant 3).
    const draft2 = await store.ledger.createDraft({date: '2026-08-02'}, ACTOR);
    expect(await code(store.deletePage(draft2.id))).toBe('managed');
  });

  it('trash purge sweeps never touch ledger rows (even force-trashed ones)', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -100}]},
      ACTOR,
    );
    const posted = await store.ledger.post(draft.id, ACTOR);
    // Force a posted row + host into the trash underneath the API (raw SQL) to
    // simulate the worst case, then run both purge paths.
    await db.query('UPDATE pages SET deleted_at = now() - interval \'10 years\' WHERE id = $1', [posted.id]);
    await store.purgeExpired(0);
    await store.emptyTrash();
    const still = await db.query<{id: string}>('SELECT id FROM pages WHERE id = $1', [posted.id]);
    expect(still).toHaveLength(1);
    expect(await code(store.purgePage(posted.id))).toBe('managed');
    // Un-trash for hygiene; the row is intact.
    await db.query('UPDATE pages SET deleted_at = NULL WHERE id = $1', [posted.id]);
    expect((await store.ledger.getTransaction(posted.id))?.state).toBe('posted');
  });

  it('the disk-mirror re-import path is DB-wins for ledger pages (never writes)', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -100}]},
      ACTOR,
    );
    const posted = await store.ledger.post(draft.id, ACTOR);
    // A divergent mirror file for a ledger row id, claiming a future base — the
    // branch that would otherwise UPDATE the row's data in place.
    const result = await store.importBookPage(
      {id: posted.id, name: 'tampered', data: {editorjs: {blocks: [{type: 'paragraph', data: {text: 'tampered'}}]}, values: [], names: []}},
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(result.action).toBe('unchanged');
    expect((await store.ledger.getTransaction(posted.id))?.state).toBe('posted');
    const page = await store.getPage(posted.id);
    expect(page?.name).not.toBe('tampered');
  });

  it('an overwrite import bundle cannot tamper with ledger rows or schemas', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 4_200}, {accountId: income, amountMinor: -4_200}]},
      ACTOR,
    );
    const posted = await store.ledger.post(draft.id, ACTOR);
    const exported = await store.exportAll();
    // Tamper: rewrite the posted amount + the postings schema in the bundle.
    const pages: StoredPage[] = exported.pages.map((p) =>
      p.id === posted.postings[0].id ? {...p, properties: {...p.properties, lp_amount_minor: 1}} : p,
    );
    const databases: StoredDatabase[] = exported.databases.map((d) =>
      d.name === 'Ledger postings' ? {...d, schema: {...d.schema, managed: false}} : d,
    );
    await store.importBundle({pages, databases, mode: 'overwrite'});
    const after = await store.ledger.getTransaction(posted.id);
    expect(after?.postings[0].amountMinor).toBe(4_200);
    const info = await store.ledger.info();
    const postingsDb = await store.getDatabase(info.databases!.postings);
    expect(postingsDb?.schema.managed).toBe(true);
  });

  // F1 (critical): an overwrite bundle could re-home a per-database HOST page —
  // those carry `database_id IS NULL`, so the old skip-set missed them — and the
  // `parent_id`/`database_id` FK cascades then hard-deleted the whole ledger
  // through a perfectly ordinary delete-purge or delete-database call, silently
  // and unaudited.
  it('an import bundle cannot re-home a ledger host page into a foreign cascade', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 4_200}, {accountId: income, amountMinor: -4_200}]},
      ACTOR,
    );
    const posted = await store.ledger.post(draft.id, ACTOR);
    const ids = (await store.ledgerIds())!;

    // An attacker page + database to hang the ledger host off.
    const attackerPage = await store.upsertPage({name: 'attacker', data: emptyPageSnapshot()});
    const attackerDb = await store.createDatabase({pageId: attackerPage.id, name: 'attacker db'});

    const exported = await store.exportAll();
    const pages: StoredPage[] = exported.pages.map((p) =>
      p.id === ids.hostPages.postings ? {...p, parentId: attackerPage.id, databaseId: attackerDb.id} : p,
    );
    await store.importBundle({pages, databases: exported.databases, mode: 'overwrite'});

    // The re-home must not have happened…
    const hostAfter = await store.getPage(ids.hostPages.postings);
    expect(hostAfter?.parentId).toBe(ids.hostPageId);
    expect(hostAfter?.databaseId).toBeNull();

    // …so neither cascade can reach the books.
    await store.deleteDatabase(attackerDb.id);
    await store.deletePage(attackerPage.id);
    await store.purgePage(attackerPage.id);
    await store.emptyTrash();

    const survived = await store.ledger.getTransaction(posted.id);
    expect(survived?.state).toBe('posted');
    expect(survived?.postings).toHaveLength(2);
    expect(survived?.postings.map((p) => p.amountMinor).sort((a, b) => a - b)).toEqual([-4_200, 4_200]);
  });

  // F1/F2: `movePage`'s `orderedIds` renumbered ANY page id, including database
  // rows — a second, unaudited write channel that could reorder a posted
  // transaction's postings (changing the canonical serialization the audit
  // hashes cover).
  it('movePage orderedIds cannot renumber ledger posting rows', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -100}]},
      ACTOR,
    );
    const posted = await store.ledger.post(draft.id, ACTOR);
    const before = posted.postings.map((p) => p.id);

    const decoy = await store.upsertPage({name: 'decoy', data: emptyPageSnapshot()});
    // Reversed posting ids smuggled into a legitimate move of an unrelated page.
    await store.movePage(decoy.id, null, [...before].reverse());

    const after = await store.ledger.getTransaction(posted.id);
    expect(after?.postings.map((p) => p.id)).toEqual(before);
  });

  // F3: any principal with page-write could flip a ledger host to `public`,
  // exposing every posting (rows are `inherit` and resolve through their host).
  it('refuses a non-restricted visibility on every ledger host page', async () => {
    await seedWithAccounts();
    const ids = (await store.ledgerIds())!;
    for (const hostId of [ids.hostPageId, ...Object.values(ids.hostPages)]) {
      expect(await code(store.setPageVisibility(hostId, 'public'))).toBe('managed');
      expect(await code(store.setPageVisibility(hostId, 'members'))).toBe('managed');
      expect(await store.getPageVisibility(hostId)).toBe('restricted');
      // Re-asserting `restricted` stays allowed (idempotent, no-op).
      expect(await store.setPageVisibility(hostId, 'restricted')).toBe(true);
    }
  });

  // F3: sharing via ACL stays allowed — but is never silent.
  it('audits ACL grants and revokes on ledger pages', async () => {
    await seedWithAccounts();
    const ids = (await store.ledgerIds())!;
    const before = await auditCount();
    await store.setPageAcl(ids.hostPageId, {subject: 'https://iss#auditor', email: null, level: 'read'});
    expect(await auditCount()).toBe(before + 1);
    await store.removePageAcl(ids.hostPageId, {subject: 'https://iss#auditor'});
    expect(await auditCount()).toBe(before + 2);
    const events = await store.ledger.listAudit({limit: 5});
    expect(events[0].action).toBe('ledger.acl');
    expect(events[0].payload.kind).toBe('revoke');
    expect(events[1].payload).toMatchObject({kind: 'grant', subject: 'https://iss#auditor', level: 'read'});
  });

  // Sasha nit 2: defence in depth — a TTL rule must never reach posted history.
  it('never TTL-sweeps ledger rows even if a retention rule is forced on', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -100}]},
      ACTOR,
    );
    const posted = await store.ledger.post(draft.id, ACTOR);
    const ids = (await store.ledgerIds())!;
    // Force a 1-day retention rule straight onto the row (bypassing updateDatabase).
    await db.query(
      `UPDATE databases SET schema = jsonb_set(schema, '{autoExpiry}', '{"enabled":true,"days":1,"basis":"created"}'::jsonb)
       WHERE id = $1`,
      [ids.postings],
    );
    await db.query('UPDATE pages SET created_at = now() - interval \'10 years\' WHERE database_id = $1', [ids.postings]);
    expect(await store.sweepExpiredRows()).toBe(0);
    expect((await store.ledger.getTransaction(posted.id))?.postings).toHaveLength(2);
  });
});

describe('LGR-3 — cleared-state workflow + invariant 4', () => {
  it('pending↔cleared is open; `reconciled` is unreachable from this surface, both ways', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -100}]},
      ACTOR,
    );
    // A DRAFT leg has no cleared-state workflow: the entry is not on the books,
    // so "has it cleared the bank" is not a question about it. (It may still be
    // BORN cleared through LedgerPostingInput — that is the bank import
    // carrying a statement line's settled state in.)
    expect(await code(store.ledger.setPostingCleared(draft.postings[0].id, 'cleared', ACTOR))).toBe('posting-not-reconcilable');

    const posted = await store.ledger.post(draft.id, ACTOR);
    const pid = posted.postings[0].id;
    expect((await store.ledger.setPostingCleared(pid, 'cleared', ACTOR)).cleared).toBe('cleared');
    expect((await store.ledger.setPostingCleared(pid, 'pending', ACTOR)).cleared).toBe('pending');
    // LGR-11 removed the `via: 'reconciliation'` opt-out this guard shipped
    // with: no product code ever passed it, and any caller who did could
    // unfreeze a reconciled posting with no audited reopen. `reconciled` is now
    // reachable ONLY by finishing a reconciliation and leavable ONLY by
    // reopening one, so BOTH directions reject here unconditionally.
    expect(await code(store.ledger.setPostingCleared(pid, 'reconciled', ACTOR))).toBe('reconciled-locked');
    const rec = await store.ledger.startReconciliation(
      {accountId: cash, statementDate: '2026-08-31', statementBalanceMinor: 100},
      ACTOR,
    );
    await store.ledger.setReconciliationPostingCleared(rec.id, pid, 'cleared', ACTOR);
    await store.ledger.finishReconciliation(rec.id, ACTOR);
    expect((await store.ledger.getPosting(pid))?.cleared).toBe('reconciled');
    expect(await code(store.ledger.setPostingCleared(pid, 'cleared', ACTOR))).toBe('reconciled-locked');
    expect(await code(store.ledger.setPostingCleared(pid, 'pending', ACTOR))).toBe('reconciled-locked');
    // Only the reopen releases it.
    await store.ledger.reopenReconciliation(rec.id, ACTOR);
    expect((await store.ledger.setPostingCleared(pid, 'pending', ACTOR)).cleared).toBe('pending');
  });
});

describe('LGR-3 — account lifecycle', () => {
  it('closing rejects at nonzero posted balance; allowed at zero', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -100}]},
      ACTOR,
    );
    const posted = await store.ledger.post(draft.id, ACTOR);
    expect(await code(store.ledger.updateAccount(cash, {status: 'closed'}, ACTOR))).toBe('nonzero-balance');
    await store.ledger.reverse(posted.id, {}, ACTOR); // brings the balance back to zero
    expect((await store.ledger.updateAccount(cash, {status: 'closed'}, ACTOR)).status).toBe('closed');
  });

  it('validates hierarchical names, types, currencies, and dates (typed)', async () => {
    await store.ledger.ensureSetup(ACTOR);
    expect(await code(store.ledger.createAccount({name: 'Assets::Bank', type: 'asset'}, ACTOR))).toBe('invalid-input');
    expect(await code(store.ledger.createAccount({name: '  ', type: 'asset'}, ACTOR))).toBe('invalid-input');
    expect(await code(store.ledger.createAccount({name: 'A', type: 'weird' as never}, ACTOR))).toBe('invalid-input');
    expect(await code(store.ledger.createAccount({name: 'A', type: 'asset', currency: 'usd'}, ACTOR))).toBe('invalid-input');
    expect(await code(store.ledger.createDraft({date: '2026-13-40'}, ACTOR))).toBe('invalid-input');
    const account = await store.ledger.createAccount({name: 'Assets:Bank:Checking', type: 'asset'}, ACTOR);
    expect(account.currency).toBe('USD');
    expect(account.status).toBe('open');
  });
});

describe('LGR-3 — audit log (append-only, exactly one event per mutation, replayable)', () => {
  it('appends exactly one event per mutation and replays to current state', async () => {
    const {cash, income} = await seedWithAccounts();
    expect(await auditCount()).toBe(3); // init + 2 account creates

    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', description: 'Invoice 1', postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -100}]},
      ACTOR,
    );
    expect(await auditCount()).toBe(4);
    await store.ledger.updateDraft(draft.id, {description: 'Invoice 1 (edited)'}, ACTOR);
    expect(await auditCount()).toBe(5);
    const posted = await store.ledger.post(draft.id, ACTOR);
    expect(await auditCount()).toBe(6);
    const reversal = await store.ledger.reverse(posted.id, {}, ACTOR); // ONE event for the pair
    expect(await auditCount()).toBe(7);
    await store.ledger.setPostingCleared(posted.postings[0].id, 'cleared', ACTOR);
    expect(await auditCount()).toBe(8);
    const gone = await store.ledger.createDraft({date: '2026-08-02'}, ACTOR);
    await store.ledger.deleteDraft(gone.id, ACTOR);
    expect(await auditCount()).toBe(10);

    // Events carry actor + hashes; the reverse names BOTH entities.
    const eventsDesc = await store.ledger.listAudit({limit: 500});
    const reverseEvent = eventsDesc.find((e) => e.action === 'transaction.reverse') as LedgerAuditEvent;
    expect(reverseEvent.entityIds.sort()).toEqual([reversal.id, posted.id].sort());
    expect(reverseEvent.actorSubject).toBe(ACTOR.subject);
    expect(reverseEvent.beforeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(reverseEvent.afterHash).toMatch(/^[0-9a-f]{64}$/);

    // Replay (ascending) reconstructs the live state — content fields compared.
    const ascending = [...eventsDesc].sort((a, b) => a.seq - b.seq);
    const replayed = replayLedgerAudit(ascending);
    expect(replayed.initialized).toBe(true);
    const liveAccounts = await store.ledger.listAccounts();
    for (const account of liveAccounts) {
      const r = replayed.accounts[account.id];
      expect({name: r.name, type: r.type, status: r.status, currency: r.currency}).toEqual({
        name: account.name,
        type: account.type,
        status: account.status,
        currency: account.currency,
      });
    }
    const liveTxs = await store.ledger.listTransactions({limit: 100});
    expect(Object.keys(replayed.transactions).sort()).toEqual(liveTxs.map((t) => t.id).sort());
    for (const tx of liveTxs) {
      const r = replayed.transactions[tx.id];
      expect({
        date: r.date,
        description: r.description,
        state: r.state,
        entryNo: r.entryNo,
        reverses: r.reverses,
        postings: r.postings.map((p) => ({accountId: p.accountId, amountMinor: p.amountMinor, cleared: p.cleared})),
      }).toEqual({
        date: tx.date,
        description: tx.description,
        state: tx.state,
        entryNo: tx.entryNo,
        reverses: tx.reverses,
        postings: tx.postings.map((p) => ({accountId: p.accountId, amountMinor: p.amountMinor, cleared: p.cleared})),
      });
    }
  });

  it('paginates newest-first by seq cursor', async () => {
    await seedWithAccounts();
    const all = await store.ledger.listAudit({limit: 500});
    expect(all.length).toBe(3);
    const page1 = await store.ledger.listAudit({limit: 2});
    expect(page1.map((e) => e.seq)).toEqual([all[0].seq, all[1].seq]);
    const page2 = await store.ledger.listAudit({limit: 2, before: page1[1].seq});
    expect(page2.map((e) => e.seq)).toEqual([all[2].seq]);
  });

  it('no update/delete path on ledger_audit exists in the server source', () => {
    for (const file of ['./ledger.ts', './store.ts', './app.ts', './migrations.ts', './localClient.ts']) {
      const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(src).not.toMatch(/UPDATE\s+ledger_audit/i);
      expect(src).not.toMatch(/DELETE\s+FROM\s+ledger_audit/i);
    }
  });

  it('replay REFUSES an unknown action rather than silently skipping it', async () => {
    await seedWithAccounts();
    const events = await store.ledger.listAudit({limit: 10});
    expect(() =>
      replayLedgerAudit([{...events[0], action: 'transaction.teleport' as LedgerAuditEvent['action']}]),
    ).toThrow(LedgerError);
    // …and reading a tampered action out of the DB fails loudly too.
    await db.query('UPDATE ledger_audit SET action = \'transaction.teleport\' WHERE seq = 1');
    expect(await code(store.ledger.listAudit({limit: 10}))).toBe('invalid-state');
  });
});

describe('LGR-3 — audit chain (tamper-evidence against a direct-DB actor)', () => {
  it('chains every event and verifies from genesis', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -100}]},
      ACTOR,
    );
    await store.ledger.post(draft.id, ACTOR);

    const ascending = (await store.ledger.listAudit({limit: 500})).slice().sort((a, b) => a.seq - b.seq);
    expect(ascending[0].prevHash).toBeNull(); // genesis
    for (let i = 1; i < ascending.length; i += 1) {
      expect(ascending[i].prevHash).toBe(await ledgerAuditEventHash(ascending[i - 1]));
    }
    const verdict = await store.ledger.verifyAuditChain();
    expect(verdict).toMatchObject({ok: true, brokenAtSeq: null});
    expect(verdict.checked).toBe(ascending.length);
  });

  it('detects a REWRITTEN middle event', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -100}]},
      ACTOR,
    );
    await store.ledger.post(draft.id, ACTOR);
    expect((await store.ledger.verifyAuditChain()).ok).toBe(true);

    // Direct-DB tamper: rewrite an event's payload in place (no API can do this).
    const target = (await db.query<{seq: number | string}>('SELECT seq FROM ledger_audit ORDER BY seq ASC OFFSET 1 LIMIT 1'))[0];
    await db.query('UPDATE ledger_audit SET payload = \'{"account":{"id":"forged"}}\'::jsonb WHERE seq = $1', [target.seq]);

    const verdict = await store.ledger.verifyAuditChain();
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenAtSeq).toBe(Number(target.seq) + 1); // the link AFTER the edit breaks
    expect(verdict.reason).toMatch(/prevHash mismatch/);
  });

  it('detects a DELETED middle event (not confusable with a rollback gap)', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -100}]},
      ACTOR,
    );
    await store.ledger.post(draft.id, ACTOR);

    const victim = (await db.query<{seq: number | string}>('SELECT seq FROM ledger_audit ORDER BY seq ASC OFFSET 1 LIMIT 1'))[0];
    await db.query('DELETE FROM ledger_audit WHERE seq = $1', [victim.seq]);
    const deleted = await store.ledger.verifyAuditChain();
    expect(deleted.ok).toBe(false);
    expect(deleted.reason).toMatch(/prevHash mismatch/);

  });

  it('a rolled-back append leaves a REAL seq gap but an intact chain', async () => {
    // The distinguishing property: a BIGSERIAL gap is innocuous (a rolled-back
    // transaction) iff the chain still links across it. The gap must be created
    // by an INSERT that then rolls back — a validation failure that rejects
    // BEFORE any `ledger_audit` insert consumes no sequence value at all and
    // would make this assertion vacuous.
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -100}]},
      ACTOR,
    );
    const seqsBefore = (await db.query<{seq: number | string}>('SELECT seq FROM ledger_audit ORDER BY seq ASC')).map((r) => Number(r.seq));

    // Insert an audit row inside a transaction, then abort it: the sequence
    // value is consumed and never returned (BIGSERIAL is non-transactional).
    await expect(
      db.begin(async (tx) => {
        // A distinct `prev_hash` so the row satisfies the 0022 linearity indexes
        // (this test is about the SEQUENCE gap, not about those constraints).
        await tx.query(
          `INSERT INTO ledger_audit (id, actor_subject, actor_name, action, entity_ids, payload, prev_hash)
           VALUES ($1, '', '', 'account.create', '[]'::jsonb, '{}'::jsonb, $2)`,
          [randomUUID(), `rolled-back-${randomUUID()}`],
        );
        throw new Error('rollback');
      }),
    ).rejects.toThrow(/rollback/);

    // A further real mutation lands AFTER the burned value → a genuine gap.
    await store.ledger.post(draft.id, ACTOR);
    const seqsAfter = (await db.query<{seq: number | string}>('SELECT seq FROM ledger_audit ORDER BY seq ASC')).map((r) => Number(r.seq));
    expect(seqsAfter.length).toBe(seqsBefore.length + 1);
    const contiguous = seqsAfter.every((s, i) => i === 0 || s === seqsAfter[i - 1] + 1);
    expect(contiguous).toBe(false); // the gap is real, not an artefact of the fixture

    // …and the chain verifies clean straight across it.
    const verdict = await store.ledger.verifyAuditChain();
    expect(verdict).toMatchObject({ok: true, brokenAtSeq: null});
    expect(verdict.checked).toBe(seqsAfter.length);
  });
});

describe('LGR-3 — review hardening', () => {
  it('rejects a reversal that would post into a CLOSED account', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -100}]},
      ACTOR,
    );
    const posted = await store.ledger.post(draft.id, ACTOR);
    // `income` nets to -100 → reverse first to zero it, then close it, then try
    // to reverse the (already reversed) entry's twin: build a second entry so a
    // closed account is genuinely in the way.
    const draft2 = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 50}, {accountId: income, amountMinor: -50}]},
      ACTOR,
    );
    const posted2 = await store.ledger.post(draft2.id, ACTOR);
    await store.ledger.reverse(posted2.id, {}, ACTOR); // income back to -100 net of entry 1
    // Close a THIRD, zero-balance account and route a reversal through it.
    const parked = await store.ledger.createAccount({name: 'Equity:Parked', type: 'equity'}, ACTOR);
    const draft3 = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 10}, {accountId: parked.id, amountMinor: -10}]},
      ACTOR,
    );
    const posted3 = await store.ledger.post(draft3.id, ACTOR);
    await store.ledger.reverse(posted3.id, {}, ACTOR); // parked back to zero
    expect((await store.ledger.updateAccount(parked.id, {status: 'closed'}, ACTOR)).status).toBe('closed');
    // Now a reversal of the ORIGINAL entry-3 twin would need the closed account.
    const draft4 = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 10}, {accountId: income, amountMinor: -10}]},
      ACTOR,
    );
    const posted4 = await store.ledger.post(draft4.id, ACTOR);
    await store.ledger.updateAccount(parked.id, {status: 'open'}, ACTOR);
    const draft5 = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: parked.id, amountMinor: 7}, {accountId: income, amountMinor: -7}]},
      ACTOR,
    );
    const posted5 = await store.ledger.post(draft5.id, ACTOR);
    // parked now holds +7, so it cannot be closed; zero it via a manual entry…
    const draft6 = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: parked.id, amountMinor: -7}, {accountId: income, amountMinor: 7}]},
      ACTOR,
    );
    await store.ledger.post(draft6.id, ACTOR);
    await store.ledger.updateAccount(parked.id, {status: 'closed'}, ACTOR);
    // …and NOW reversing entry 5 (which touches parked) must be refused.
    expect(await code(store.ledger.reverse(posted5.id, {}, ACTOR))).toBe('account-closed');
    // Reopening unblocks it.
    await store.ledger.updateAccount(parked.id, {status: 'open'}, ACTOR);
    expect((await store.ledger.reverse(posted5.id, {}, ACTOR)).reverses).toBe(posted5.id);
    expect(posted.state).toBe('posted');
    expect(posted4.state).toBe('posted');
  });

  it('rejects an all-zero (balanced no-op) entry', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 0}, {accountId: income, amountMinor: 0}]},
      ACTOR,
    );
    expect(await code(store.ledger.post(draft.id, ACTOR))).toBe('invalid-amount');
  });

  it('validates description type + length on create, update, and reverse', async () => {
    const {cash, income} = await seedWithAccounts();
    expect(await code(store.ledger.createDraft({date: '2026-08-01', description: {a: 1} as never}, ACTOR))).toBe('invalid-input');
    expect(await code(store.ledger.createDraft({date: '2026-08-01', description: 'x'.repeat(1001)}, ACTOR))).toBe('invalid-input');
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 1}, {accountId: income, amountMinor: -1}]},
      ACTOR,
    );
    expect(await code(store.ledger.updateDraft(draft.id, {description: 'x'.repeat(1001)}, ACTOR))).toBe('invalid-input');
    const posted = await store.ledger.post(draft.id, ACTOR);
    expect(await code(store.ledger.reverse(posted.id, {description: 'x'.repeat(1001)}, ACTOR))).toBe('invalid-input');
    // The boundary value is accepted.
    expect((await store.ledger.createDraft({date: '2026-08-01', description: 'x'.repeat(1000)}, ACTOR)).description).toHaveLength(1000);
  });

  it('caps postings per entry', async () => {
    const {cash, income} = await seedWithAccounts();
    const many = Array.from({length: 1001}, (_, i) => ({accountId: i % 2 === 0 ? cash : income, amountMinor: i % 2 === 0 ? 1 : -1}));
    expect(await code(store.ledger.createDraft({date: '2026-08-01', postings: many}, ACTOR))).toBe('invalid-input');
  });

  it('keeps a stored-amount overflow inside the typed contract (no 500)', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -100}]},
      ACTOR,
    );
    const posted = await store.ledger.post(draft.id, ACTOR);
    // Force two stored amounts whose SUM overflows the safe range.
    await corruptPosting(posted.postings[0].id, 'lp_amount_minor', Number.MAX_SAFE_INTEGER);
    const draft2 = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 1}, {accountId: income, amountMinor: -1}]},
      ACTOR,
    );
    const posted2 = await store.ledger.post(draft2.id, ACTOR);
    await corruptPosting(posted2.postings[0].id, 'lp_amount_minor', Number.MAX_SAFE_INTEGER);
    expect(await code(store.ledger.accountPostedBalance(cash))).toBe('invalid-amount');
    // …and the close path reports the same typed error rather than a 500.
    expect(await code(store.ledger.updateAccount(cash, {status: 'closed'}, ACTOR))).toBe('invalid-amount');
  });

  it('does not cache the "not seeded" answer (multi-process guard arming)', async () => {
    // A store that asked BEFORE the ledger existed must still see it afterwards —
    // simulate the second process by seeding through a different PageStore on the
    // same database.
    expect(await store.ledgerIds()).toBeNull();
    const other = new PageStore(db);
    await other.ledger.ensureSetup(ACTOR);
    expect(await store.ledgerIds()).not.toBeNull();
    // …and the guards are armed in the first store without a restart.
    const ids = (await store.ledgerIds())!;
    expect(await code(store.createRow(ids.transactions, {name: 'forged'}))).toBe('managed');
  });

  it('assigns unique consecutive entry numbers to concurrent posts', async () => {
    const {cash, income} = await seedWithAccounts();
    const drafts = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        store.ledger.createDraft(
          {date: '2026-08-01', postings: [{accountId: cash, amountMinor: n}, {accountId: income, amountMinor: -n}]},
          ACTOR,
        ),
      ),
    );
    const posted = await Promise.all(drafts.map((d) => store.ledger.post(d.id, ACTOR)));
    const numbers = posted.map((t) => t.entryNo).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(numbers).toEqual([1, 2, 3, 4]); // unique, consecutive, no duplicates
    // The audit chain survives the concurrency intact.
    expect((await store.ledger.verifyAuditChain()).ok).toBe(true);
  });
});

describe('LGR-3 — re-review fixes', () => {
  // NF-1 (availability): `stripManagedLedger` queried the OUTER db handle from
  // inside the import transaction. On PGlite that queues behind the transaction
  // awaiting it, so `importBundle` never resolved AND the shared mutex stayed
  // chained to a pending promise — every later DB call in the process hung.
  // Triggered by any bundle containing a parented page, i.e. most real restores.
  it('imports a bundle containing parented pages without wedging the database', async () => {
    await seedWithAccounts();

    const parent = await store.upsertPage({name: 'parent', data: emptyPageSnapshot()});
    const child = await store.upsertPage({name: 'child', data: emptyPageSnapshot(), parentId: parent.id});
    expect(child.parentId).toBe(parent.id);
    const exported = await store.exportAll();
    expect(exported.pages.some((p) => p.parentId !== null)).toBe(true); // the fixture really exercises it

    // Both the import AND a following query must settle. A regression hangs here
    // forever, so bound it explicitly rather than relying on the suite timeout.
    const withTimeout = <T>(p: Promise<T>, label: string): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} did not settle — database wedged`)), 15_000)),
      ]);

    await withTimeout(store.importBundle({pages: exported.pages, databases: exported.databases, mode: 'copy'}), 'importBundle');
    // The mutex is still healthy: an ordinary read completes.
    await withTimeout(store.listPages(), 'listPages after import');
    // …and the ledger is untouched by the restore.
    expect((await store.ledger.listAccounts()).length).toBe(2);
  });

  // NF-2 (chain linearity): concurrent appends that take no prior global lock —
  // `createAccount` is the simplest — must never both chain onto the same
  // predecessor. On PGlite the FIFO mutex hides the race, so this also asserts
  // the database-level backstop index exists to catch it on real Postgres.
  it('keeps the chain linear under concurrent appends that take no other lock', async () => {
    await store.ledger.ensureSetup(ACTOR);
    await Promise.all(
      Array.from({length: 8}, (_, i) => store.ledger.createAccount({name: `Assets:A${i}`, type: 'asset'}, ACTOR)),
    );
    const verdict = await store.ledger.verifyAuditChain();
    expect(verdict).toMatchObject({ok: true, brokenAtSeq: null});
    // No two events may claim the same predecessor, and only one may be genesis.
    const rows = await db.query<{prev_hash: string | null}>('SELECT prev_hash FROM ledger_audit');
    const links = rows.map((r) => r.prev_hash).filter((h): h is string => h !== null);
    expect(new Set(links).size).toBe(links.length);
    expect(rows.filter((r) => r.prev_hash === null)).toHaveLength(1);
  });

  it('enforces chain linearity in the database itself (migration 0022)', async () => {
    await store.ledger.ensureSetup(ACTOR);
    const tail = (await db.query<{prev_hash: string | null}>('SELECT prev_hash FROM ledger_audit ORDER BY seq DESC LIMIT 1'))[0];
    const dup = tail.prev_hash;
    if (dup !== null) {
      // A second event claiming an already-claimed predecessor is refused.
      await expect(
        db.query(
          `INSERT INTO ledger_audit (id, actor_subject, actor_name, action, entity_ids, payload, prev_hash)
           VALUES ($1, '', '', 'account.create', '[]'::jsonb, '{}'::jsonb, $2)`,
          [randomUUID(), dup],
        ),
      ).rejects.toThrow(/duplicate key|unique/i);
    }
    // A second GENESIS event (no predecessor) is refused too, so a truncated log
    // cannot be silently re-anchored.
    await expect(
      db.query(
        `INSERT INTO ledger_audit (id, actor_subject, actor_name, action, entity_ids, payload, prev_hash)
         VALUES ($1, '', '', 'account.create', '[]'::jsonb, '{}'::jsonb, NULL)`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  // NF-3 (downgrade brick): the chain WRITE path must not run the action
  // allowlist. A build that predates an action (simulated by a stored action this
  // build doesn't know) previously threw on every subsequent ledger write.
  it('keeps writing (and chaining) across an audit action this build cannot interpret', async () => {
    const {cash, income} = await seedWithAccounts();
    // Simulate a newer build's event sitting in the log.
    await db.query('UPDATE ledger_audit SET action = \'ledger.futureThing\' WHERE seq = (SELECT MAX(seq) FROM ledger_audit)');

    // Writes still work — this is the brick that NF-3 reported.
    const account = await store.ledger.createAccount({name: 'Assets:Later', type: 'asset'}, ACTOR);
    expect(account.name).toBe('Assets:Later');
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 5}, {accountId: income, amountMinor: -5}]},
      ACTOR,
    );
    expect((await store.ledger.post(draft.id, ACTOR)).state).toBe('posted');

    // Verification REPORTS the uninterpretable row (with its seq) instead of
    // throwing, and the structural chain across it is still sound.
    const verdict = await store.ledger.verifyAuditChain();
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenAtSeq).toBeGreaterThan(0);
    expect(verdict.reason).toMatch(/unknown ledger audit action/);
    // The read path still fails closed on the unreadable row.
    expect(await code(store.ledger.listAudit({limit: 100}))).toBe('invalid-state');
  });

  // Quinn item 1 residual: the move DESTINATION is now guarded too, so the
  // move door and the import door agree about splicing into the ledger subtree.
  it('refuses a move that would parent a foreign page under a ledger page', async () => {
    await seedWithAccounts();
    const ids = (await store.ledgerIds())!;
    const foreign = await store.upsertPage({name: 'foreign', data: emptyPageSnapshot()});
    const hostIds = [ids.hostPageId, ...Object.values(ids.hostPages)];
    for (const hostId of hostIds) {
      expect(await code(store.movePage(foreign.id, hostId, []))).toBe('managed');
    }
    // …and the host pages' positions are untouched by the refused attempt.
    const positions = await db.query<{id: string; position: number}>(
      'SELECT id, position FROM pages WHERE id = ANY($1) ORDER BY position ASC',
      [hostIds],
    );
    expect(positions).toHaveLength(5);
  });
});

/**
 * LGR-16 — the per-posting memo.
 *
 * Before this, per-line memos lived only in the journal block's CRDT props:
 * they never reached storage, so they never reached the export, the audit
 * trail, reports, or an importer. The memo is now ordinary posting CONTENT and
 * is held to the same bar as `description`.
 */
describe('LGR-16 — per-posting memo', () => {
  it('round-trips through create, update, post and read', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {
        date: '2026-08-01',
        description: 'Payroll',
        postings: [
          {accountId: cash, amountMinor: -2500, memo: 'net to bank'},
          {accountId: income, amountMinor: 2500, memo: 'gross wages'},
        ],
      },
      ACTOR,
    );
    expect(draft.postings.map((p) => p.memo)).toEqual(['net to bank', 'gross wages']);

    // A wholesale posting replacement carries the new memos.
    const updated = await store.ledger.updateDraft(
      draft.id,
      {postings: [{accountId: cash, amountMinor: -2500, memo: 'corrected'}, {accountId: income, amountMinor: 2500}]},
      ACTOR,
    );
    expect(updated.postings.map((p) => p.memo)).toEqual(['corrected', null]);

    // Posting is a state change, not a content rewrite: memos survive it, and
    // survive a re-read from storage.
    const posted = await store.ledger.post(draft.id, ACTOR);
    expect(posted.postings.map((p) => p.memo)).toEqual(['corrected', null]);
    const reread = await store.ledger.getTransaction(draft.id);
    expect(reread?.postings.map((p) => p.memo)).toEqual(['corrected', null]);
    expect(await store.ledger.getPosting(posted.postings[0].id)).toMatchObject({memo: 'corrected'});
  });

  it('validates type + length exactly like description, and collapses blank to null', async () => {
    const {cash, income} = await seedWithAccounts();
    const withMemo = (memo: unknown) =>
      store.ledger.createDraft(
        {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 1, memo: memo as string}, {accountId: income, amountMinor: -1}]},
        ACTOR,
      );
    expect(await code(withMemo({a: 1}))).toBe('invalid-input');
    expect(await code(withMemo(42))).toBe('invalid-input');
    expect(await code(withMemo('x'.repeat(1001)))).toBe('invalid-input');
    // The boundary value is accepted — same cap as description.
    expect((await withMemo('x'.repeat(1000))).postings[0].memo).toHaveLength(1000);
    // Absent / null / '' are ONE state, so a cleared box and an untouched one
    // cannot produce two different audit payloads for the same entry.
    for (const blank of [undefined, null, '']) {
      expect((await withMemo(blank)).postings[0].memo).toBeNull();
    }
  });

  it('is inside the audit payload and the content hash — a memo edit is never invisible', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 1, memo: 'first'}, {accountId: income, amountMinor: -1}]},
      ACTOR,
    );
    const created = (await store.ledger.listAudit({limit: 1}))[0];
    const payloadMemos = (created.payload as {transaction: {postings: Array<{memo: string | null}>}}).transaction.postings.map((p) => p.memo);
    expect(payloadMemos).toEqual(['first', null]);

    // Changing ONLY the memo still moves the before/after content hash: the
    // memo is ledger content, not presentation.
    await store.ledger.updateDraft(
      draft.id,
      {postings: [{accountId: cash, amountMinor: 1, memo: 'second'}, {accountId: income, amountMinor: -1}]},
      ACTOR,
    );
    const update = (await store.ledger.listAudit({limit: 1}))[0];
    expect(update.action).toBe('transaction.update');
    expect(update.beforeHash).not.toBe(update.afterHash);
    expect(update.beforeHash).toBe(created.afterHash);

    // …and the audit stream still replays to exactly the stored state.
    const events = [...(await store.ledger.listAudit({limit: 500}))].reverse();
    const replayed = replayLedgerAudit(events).transactions[draft.id];
    expect(replayed.postings.map((p) => p.memo)).toEqual(['second', null]);
    expect(await store.ledger.verifyAuditChain()).toMatchObject({ok: true});
  });

  it('a reversal carries the original leg memos onto the reversing legs', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 700, memo: 'invoice 42'}, {accountId: income, amountMinor: -700}]},
      ACTOR,
    );
    const posted = await store.ledger.post(draft.id, ACTOR);
    const reversal = await store.ledger.reverse(posted.id, {}, ACTOR);
    expect(reversal.postings.map((p) => ({amountMinor: p.amountMinor, memo: p.memo}))).toEqual([
      {amountMinor: -700, memo: 'invoice 42'},
      {amountMinor: 700, memo: null},
    ]);
  });

  it('a posting written before LGR-16 (no memo key at all) reads back as null', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 5, memo: 'will be removed'}, {accountId: income, amountMinor: -5}]},
      ACTOR,
    );
    // Simulate a row from before the field existed: delete the key outright
    // (not set it to null) via raw SQL, bypassing the store guards.
    const postingId = draft.postings[0].id;
    const rows = await db.query<{properties: Record<string, unknown> | string}>('SELECT properties FROM pages WHERE id = $1', [postingId]);
    const props = typeof rows[0].properties === 'string' ? (JSON.parse(rows[0].properties) as Record<string, unknown>) : rows[0].properties;
    delete props.lp_memo;
    await db.query('UPDATE pages SET properties = $2::jsonb WHERE id = $1', [postingId, JSON.stringify(props)]);

    expect((await store.ledger.getPosting(postingId))?.memo).toBeNull();
    // …and the entry still posts and exports (no migration required).
    const posted = await store.ledger.post(draft.id, ACTOR);
    expect(posted.postings[0].memo).toBeNull();
    expect(await store.ledger.exportPostingsCsv()).toContain('memo');
  });

  it('exports the memo in the canonical CSV', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', description: 'Coffee', postings: [{accountId: cash, amountMinor: -450, memo: 'BLUE BOTTLE #12'}, {accountId: income, amountMinor: 450}]},
      ACTOR,
    );
    await store.ledger.post(draft.id, ACTOR);
    const csv = await store.ledger.exportPostingsCsv();
    const [header, ...lines] = csv.trim().split('\n');
    expect(header.split(',')).toContain('memo');
    expect(lines.some((l) => l.endsWith(',BLUE BOTTLE #12'))).toBe(true);
  });
});

/**
 * LGR-11 — statement reconciliation, at the STORE layer.
 *
 * The workflow's whole reason to exist is that books drift silently when nobody
 * matches them against a statement, so these tests pin the rules that make a
 * FINISHED reconciliation mean something:
 *  - finishing is impossible at a nonzero difference, and the refusal lives in
 *    the store — bypassing the UI changes nothing (this IS the acceptance);
 *  - a finished reconciliation FREEZES its postings; only its own reopen thaws
 *    them, and that reopen is explicit and audited;
 *  - one account never has two open reconciliations;
 *  - drafts and other accounts' postings are not reconcilable;
 *  - concurrency cannot corrupt any of it, and the chain still verifies.
 */
describe('LGR-11 — statement reconciliation lifecycle', () => {
  /** Post `amountMinor` into `cash` (contra `income`) and hand back the cash leg. */
  const postLeg = async (cash: string, income: string, amountMinor: number, date = '2026-08-01') => {
    const draft = await store.ledger.createDraft(
      {date, description: `entry ${amountMinor}`, postings: [{accountId: cash, amountMinor}, {accountId: income, amountMinor: -amountMinor}]},
      ACTOR,
    );
    const posted = await store.ledger.post(draft.id, ACTOR);
    return posted.postings.find((p) => p.accountId === cash)!;
  };

  /** The postings a `reconciliation.finish` event says it froze. */
  const frozenByFinish = async (): Promise<string[]> => {
    const event = (await store.ledger.listAudit({limit: 200})).find((e) => e.action === 'reconciliation.finish');
    const changes = (event?.payload as {postings?: Array<{postingId: string}>} | undefined)?.postings ?? [];
    return changes.map((c) => c.postingId).sort();
  };

  it('start → match → finish at exactly zero freezes the matched postings', async () => {
    const {cash, income} = await seedWithAccounts();
    const a = await postLeg(cash, income, 10_000);
    const b = await postLeg(cash, income, 2_500);
    const uncleared = await postLeg(cash, income, 999); // on the books, NOT on the statement

    // The bank says 125.00 cleared on this account.
    const rec = await store.ledger.startReconciliation(
      {accountId: cash, statementDate: '2026-08-31', statementBalanceMinor: 12_500},
      ACTOR,
    );
    expect(rec.status).toBe('open');
    expect((await store.ledger.getReconciliation(rec.id))?.differenceMinor).toBe(12_500); // nothing matched yet

    const afterA = await store.ledger.setReconciliationPostingCleared(rec.id, a.id, 'cleared', ACTOR);
    expect(afterA.clearedBalanceMinor).toBe(10_000);
    expect(afterA.differenceMinor).toBe(2_500);

    const afterB = await store.ledger.setReconciliationPostingCleared(rec.id, b.id, 'cleared', ACTOR);
    expect(afterB.differenceMinor).toBe(0);
    expect(afterB.matchedPostingIds).toEqual([a.id, b.id].sort());

    const finished = await store.ledger.finishReconciliation(rec.id, ACTOR);
    expect(finished.reconciliation.status).toBe('finished');
    expect(finished.differenceMinor).toBe(0);
    // The matched legs froze and carry the statement they belong to…
    for (const id of [a.id, b.id]) {
      const posting = await store.ledger.getPosting(id);
      expect(posting?.cleared).toBe('reconciled');
      expect(posting?.reconciliationId).toBe(rec.id);
    }
    // …and the one that was never on the statement is untouched and still free.
    expect((await store.ledger.getPosting(uncleared.id))?.cleared).toBe('pending');
    expect((await store.ledger.getPosting(uncleared.id))?.reconciliationId).toBeNull();
    // The list read finds it, filtered both ways.
    expect((await store.ledger.listReconciliations({accountId: cash})).map((r) => r.id)).toEqual([rec.id]);
    expect(await store.ledger.listReconciliations({status: 'open'})).toEqual([]);
    // THE SET IT FROZE IS THE SET IT COUNTED — never a superset.
    expect(await frozenByFinish()).toEqual([a.id, b.id].sort());
    expect(finished.matchedPostingIds).toEqual(expect.arrayContaining(await frozenByFinish()));
  });

  it('never freezes a posting it did not count — a DRAFT leg born `cleared` is neither', async () => {
    // The exact hole: `LedgerPostingInput` permits `cleared: 'cleared'` on a
    // draft leg (the bank import relies on it), the difference correctly
    // EXCLUDES it because its entry is not on the books — and a freeze filtered
    // on `cleared === 'cleared'` alone would stamp it anyway. Reachable with no
    // concurrency at all, through the documented createDraft contract.
    const {cash, income} = await seedWithAccounts();
    const onBooks = await postLeg(cash, income, 10_000);
    const draft = await store.ledger.createDraft(
      {
        date: '2026-08-02',
        description: 'not on the books',
        postings: [{accountId: cash, amountMinor: 50_000, cleared: 'cleared'}, {accountId: income, amountMinor: -50_000}],
      },
      ACTOR,
    );
    const draftLeg = draft.postings.find((p) => p.accountId === cash)!;
    expect(draftLeg.cleared).toBe('cleared'); // …and it really is stored that way

    const rec = await store.ledger.startReconciliation(
      {accountId: cash, statementDate: '2026-08-31', statementBalanceMinor: 10_000},
      ACTOR,
    );
    await store.ledger.setReconciliationPostingCleared(rec.id, onBooks.id, 'cleared', ACTOR);
    const summary = await store.ledger.getReconciliation(rec.id);
    expect(summary!.differenceMinor).toBe(0); // the draft leg is NOT counted
    expect(summary!.matchedPostingIds).toEqual([onBooks.id]);

    const finished = await store.ledger.finishReconciliation(rec.id, ACTOR);
    // Frozen set ⊆ counted set. The draft leg is untouched and unstamped.
    expect(await frozenByFinish()).toEqual([onBooks.id]);
    expect(finished.matchedPostingIds).toEqual([onBooks.id]);
    const afterDraftLeg = await store.ledger.getPosting(draftLeg.id);
    expect(afterDraftLeg?.cleared).toBe('cleared');
    expect(afterDraftLeg?.reconciliationId).toBeNull();

    // The three consequences that made this a corruption rather than a cosmetic
    // slip, each now impossible:
    //  1. posting the draft later must not move a FINISHED statement…
    await store.ledger.post(draft.id, ACTOR);
    const afterPost = await store.ledger.getReconciliation(rec.id);
    expect(afterPost!.reconciliation.status).toBe('finished');
    expect(afterPost!.differenceMinor).toBe(0);
    //  2. …the draft's leg is still freely mutable (it was never frozen)…
    expect((await store.ledger.setPostingCleared(draftLeg.id, 'pending', ACTOR)).cleared).toBe('pending');
    //  3. …and the book still verifies.
    expect((await store.verifyLedger()).findings).toEqual([]);
    expect((await store.ledger.verifyAuditChain()).ok).toBe(true);
  });

  it('a FINISHED reconciliation reports the history it committed, not a live recomputation', async () => {
    // A finished statement was, by definition, at exactly zero when it was
    // finished. Recomputing it live let a posting cleared afterwards — on an
    // entry this statement never matched — drag the figure off zero, so a
    // historical statement reported ITSELF out of balance.
    const {cash, income} = await seedWithAccounts();
    const matched = await postLeg(cash, income, 10_000);
    const later = await postLeg(cash, income, 5_000);
    const rec = await store.ledger.startReconciliation(
      {accountId: cash, statementDate: '2026-08-31', statementBalanceMinor: 10_000},
      ACTOR,
    );
    await store.ledger.setReconciliationPostingCleared(rec.id, matched.id, 'cleared', ACTOR);
    await store.ledger.finishReconciliation(rec.id, ACTOR);

    // Clear a LATER posting through the generic surface — legitimate, and
    // nothing to do with the August statement.
    await store.ledger.setPostingCleared(later.id, 'cleared', ACTOR);

    const summary = await store.ledger.getReconciliation(rec.id);
    expect(summary!.reconciliation.status).toBe('finished');
    expect(summary!.differenceMinor).toBe(0);
    expect(summary!.clearedBalanceMinor).toBe(10_000);
    // …and it claims ONLY the postings it actually froze, read off their own
    // `reconciliationId` rather than off "whatever is cleared right now".
    expect(summary!.matchedPostingIds).toEqual([matched.id]);
  });

  it('REFUSES to finish at a nonzero difference — the gate is in the store, not the UI', async () => {
    const {cash, income} = await seedWithAccounts();
    const a = await postLeg(cash, income, 10_000);
    const rec = await store.ledger.startReconciliation(
      {accountId: cash, statementDate: '2026-08-31', statementBalanceMinor: 12_500},
      ACTOR,
    );
    // Out by 125.00 with nothing matched, and by 25.00 with the one entry matched.
    expect(await code(store.ledger.finishReconciliation(rec.id, ACTOR))).toBe('reconciliation-unbalanced');
    await store.ledger.setReconciliationPostingCleared(rec.id, a.id, 'cleared', ACTOR);
    expect(await code(store.ledger.finishReconciliation(rec.id, ACTOR))).toBe('reconciliation-unbalanced');
    // A rejected finish leaves NOTHING behind: still open, nothing frozen, and
    // the failed attempts wrote no audit event at all.
    expect((await store.ledger.getReconciliation(rec.id))?.reconciliation.status).toBe('open');
    expect((await store.ledger.getPosting(a.id))?.cleared).toBe('cleared');
    expect((await store.ledger.listAudit({limit: 100})).filter((e) => e.action === 'reconciliation.finish')).toHaveLength(0);
    // …and once the books actually agree, the very same call succeeds.
    const b = await postLeg(cash, income, 2_500);
    await store.ledger.setReconciliationPostingCleared(rec.id, b.id, 'cleared', ACTOR);
    expect((await store.ledger.finishReconciliation(rec.id, ACTOR)).reconciliation.status).toBe('finished');
  });

  it('a reconciled posting is immutable except through ITS OWN reopen', async () => {
    const {cash, income} = await seedWithAccounts();
    const a = await postLeg(cash, income, 10_000);
    const rec = await store.ledger.startReconciliation(
      {accountId: cash, statementDate: '2026-08-31', statementBalanceMinor: 10_000},
      ACTOR,
    );
    await store.ledger.setReconciliationPostingCleared(rec.id, a.id, 'cleared', ACTOR);
    await store.ledger.finishReconciliation(rec.id, ACTOR);

    // The generic workflow surface — what the HTTP route and LocalDataClient
    // both expose — cannot touch it in either direction.
    expect(await code(store.ledger.setPostingCleared(a.id, 'pending', ACTOR))).toBe('reconciled-locked');
    expect(await code(store.ledger.setPostingCleared(a.id, 'cleared', ACTOR))).toBe('reconciled-locked');
    // Nor can a NEW reconciliation on the same account claim it.
    const next = await store.ledger.startReconciliation(
      {accountId: cash, statementDate: '2026-09-30', statementBalanceMinor: 10_000},
      ACTOR,
    );
    expect(await code(store.ledger.setReconciliationPostingCleared(next.id, a.id, 'pending', ACTOR))).toBe('reconciled-locked');
    // A frozen posting still counts as cleared money, so September opens at zero
    // difference against the same balance — that is what makes the freeze safe.
    expect((await store.ledger.getReconciliation(next.id))?.differenceMinor).toBe(0);

    // Reopening August is blocked while September is open (two open matches on
    // one account cannot both be the truth) …
    expect(await code(store.ledger.reopenReconciliation(rec.id, ACTOR))).toBe('reconciliation-exists');
    // … and works once September is finished.
    await store.ledger.finishReconciliation(next.id, ACTOR);
    const reopened = await store.ledger.reopenReconciliation(rec.id, ACTOR);
    expect(reopened.reconciliation.status).toBe('open');
    const thawed = await store.ledger.getPosting(a.id);
    expect(thawed?.cleared).toBe('cleared'); // it DID match — the freeze lifts, not the match
    expect(thawed?.reconciliationId).toBeNull();
    // …and it is mutable again through the ordinary surface.
    expect((await store.ledger.setPostingCleared(a.id, 'pending', ACTOR)).cleared).toBe('pending');
  });

  it('rejects a second open reconciliation, a draft posting, and another account’s posting', async () => {
    const {cash, income} = await seedWithAccounts();
    const other = await store.ledger.createAccount({name: 'Assets:Bank:Savings', type: 'asset'}, ACTOR);
    const rec = await store.ledger.startReconciliation(
      {accountId: cash, statementDate: '2026-08-31', statementBalanceMinor: 0},
      ACTOR,
    );
    expect(
      await code(store.ledger.startReconciliation({accountId: cash, statementDate: '2026-09-30', statementBalanceMinor: 0}, ACTOR)),
    ).toBe('reconciliation-exists');

    // A DRAFT is not on the books, so it cannot be on a statement.
    const draft = await store.ledger.createDraft(
      {date: '2026-08-02', postings: [{accountId: cash, amountMinor: 50}, {accountId: income, amountMinor: -50}]},
      ACTOR,
    );
    const draftLeg = draft.postings.find((p) => p.accountId === cash)!;
    expect(await code(store.ledger.setReconciliationPostingCleared(rec.id, draftLeg.id, 'cleared', ACTOR))).toBe('posting-not-reconcilable');

    // Another account's leg belongs to another statement.
    const elsewhere = await postLeg(other.id, income, 700);
    expect(await code(store.ledger.setReconciliationPostingCleared(rec.id, elsewhere.id, 'cleared', ACTOR))).toBe('posting-not-reconcilable');

    // Input validation, typed rather than 500'd.
    expect(await code(store.ledger.startReconciliation({accountId: other.id, statementDate: '2026-02-30', statementBalanceMinor: 0}, ACTOR))).toBe('invalid-input');
    expect(await code(store.ledger.startReconciliation({accountId: other.id, statementDate: '2026-08-31', statementBalanceMinor: 1.5}, ACTOR))).toBe('invalid-amount');
    expect(
      await code(
        store.ledger.startReconciliation({accountId: '00000000-0000-4000-8000-000000000000', statementDate: '2026-08-31', statementBalanceMinor: 0}, ACTOR),
      ),
    ).toBe('account-not-found');
    expect(await code(store.ledger.setReconciliationPostingCleared(rec.id, draftLeg.id, 'reconciled' as never, ACTOR))).toBe('invalid-input');
    expect(await code(store.ledger.finishReconciliation('00000000-0000-4000-8000-000000000000', ACTOR))).toBe('not-found');
    // Status guards, both ways round.
    expect(await code(store.ledger.reopenReconciliation(rec.id, ACTOR))).toBe('invalid-state'); // still open
    await store.ledger.finishReconciliation(rec.id, ACTOR); // its difference is already 0
    expect(await code(store.ledger.setReconciliationPostingCleared(rec.id, draftLeg.id, 'cleared', ACTOR))).toBe('invalid-state');
    expect(await code(store.ledger.finishReconciliation(rec.id, ACTOR))).toBe('invalid-state');
  });

  it('a full start → finish → reopen cycle stays audited, replayable and chain-verified', async () => {
    const {cash, income} = await seedWithAccounts();
    const a = await postLeg(cash, income, 10_000);
    const before = await auditCount();

    const rec = await store.ledger.startReconciliation(
      {accountId: cash, statementDate: '2026-08-31', statementBalanceMinor: 10_000},
      ACTOR,
    );
    await store.ledger.setReconciliationPostingCleared(rec.id, a.id, 'cleared', ACTOR);
    await store.ledger.finishReconciliation(rec.id, ACTOR);
    await store.ledger.reopenReconciliation(rec.id, ACTOR);
    // FOUR mutations, four events — the finish and the reopen each cover their
    // whole posting set in ONE event (the `transaction.reverse` precedent).
    expect(await auditCount()).toBe(before + 4);
    const actions = (await store.ledger.listAudit({limit: 10})).map((e) => e.action).reverse().slice(-4);
    expect(actions).toEqual(['reconciliation.start', 'posting.cleared', 'reconciliation.finish', 'reconciliation.reopen']);

    // The chain still verifies…
    expect((await store.ledger.verifyAuditChain()).ok).toBe(true);
    // …the independent verifier finds nothing…
    expect((await store.verifyLedger()).findings).toEqual([]);
    // …and a replay reconstructs both the reconciliation AND the posting states
    // it froze and thawed, which is exactly what the verifier's content check
    // rests on: a replay that modelled only the status would report this clean
    // book as mutated outside the ledger.
    const ascending = [...(await store.ledger.listAudit({limit: 200}))].reverse();
    const replayed = replayLedgerAudit(ascending);
    expect(replayed.reconciliations[rec.id].status).toBe('open');
    const replayedPosting = Object.values(replayed.transactions)
      .flatMap((t) => t.postings)
      .find((p) => p.id === a.id);
    expect(replayedPosting?.cleared).toBe('cleared');
    expect(replayedPosting?.reconciliationId).toBeNull();
  });

  /**
   * CONCURRENCY — and what this test can and cannot prove.
   *
   * READ THIS BEFORE TRUSTING A GREEN RESULT. It runs on PGlite, which
   * serializes every `Db.begin` through a process-wide FIFO mutex. That means
   * the interleavings the row locks exist to prevent CANNOT BE PRODUCED HERE:
   * hoisting the difference recomputation entirely outside the transaction was
   * measured to leave this file 6/6 green, five runs in a row, including this
   * test. `FOR UPDATE`/`FOR SHARE` are no-ops for correctness on this backend.
   *
   * So what is pinned here is the OUTCOME CONTRACT — after two racing calls the
   * store is in one of the admissible states, the audit chain is well formed,
   * and the verifier is clean — not the locking that delivers it on real
   * Postgres, where READ COMMITTED lets these transactions genuinely interleave.
   * The locking itself is code-review-verified only, exactly as the audit
   * advisory lock's docstring records for the same reason. A Postgres-backed
   * concurrency harness is what would close the gap; there is none in this
   * repo today.
   *
   * Do not weaken a lock on the strength of this test staying green.
   */
  it('CONCURRENCY (see the note above — PGlite cannot produce the interleavings): racing calls leave an admissible state', async () => {
    const {cash, income} = await seedWithAccounts();
    const a = await postLeg(cash, income, 10_000);
    const b = await postLeg(cash, income, 2_500);
    const rec = await store.ledger.startReconciliation(
      {accountId: cash, statementDate: '2026-08-31', statementBalanceMinor: 10_000},
      ACTOR,
    );

    // (1) Two clients ticking the SAME posting in opposite directions. Both are
    // legal, so both must succeed; the ledger serializes them, so the posting
    // lands on exactly one of the two states and the summary agrees with it.
    const auditBefore = await auditCount();
    const results = await Promise.allSettled([
      store.ledger.setReconciliationPostingCleared(rec.id, a.id, 'cleared', ACTOR),
      store.ledger.setReconciliationPostingCleared(rec.id, a.id, 'pending', ACTOR),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const settled = await store.ledger.getPosting(a.id);
    expect(['pending', 'cleared']).toContain(settled!.cleared);
    // At most one event per write, and never a torn state: what the posting says
    // now is exactly what the summary counts.
    expect(await auditCount()).toBeLessThanOrEqual(auditBefore + 2);
    const summary = await store.ledger.getReconciliation(rec.id);
    expect(summary!.clearedBalanceMinor).toBe(settled!.cleared === 'cleared' ? 10_000 : 0);
    expect(summary!.matchedPostingIds).toEqual(settled!.cleared === 'cleared' ? [a.id] : []);

    // (2) FINISH racing a TOGGLE that would break the zero. Reach the balanced
    // state, then fire a finish and a tick of `b` (which is NOT on the
    // statement) together. Exactly two outcomes are admissible, and a `finished`
    // reconciliation whose books do not add up is neither of them.
    await store.ledger.setReconciliationPostingCleared(rec.id, a.id, 'cleared', ACTOR);
    expect((await store.ledger.getReconciliation(rec.id))?.differenceMinor).toBe(0);
    const race = await Promise.allSettled([
      store.ledger.finishReconciliation(rec.id, ACTOR),
      store.ledger.setReconciliationPostingCleared(rec.id, b.id, 'cleared', ACTOR),
    ]);
    const final = await store.ledger.getReconciliation(rec.id);
    if (final!.reconciliation.status === 'finished') {
      // It finished, so it finished BALANCED — and `b` either never landed, or
      // was refused because the reconciliation had already closed.
      expect(final!.clearedBalanceMinor).toBe(10_000);
      expect(final!.differenceMinor).toBe(0);
      expect((await store.ledger.getPosting(a.id))?.reconciliationId).toBe(rec.id);
      expect((await store.ledger.getPosting(b.id))?.cleared).toBe('pending');
      if (race[1].status === 'rejected') expect((race[1].reason as LedgerError).code).toBe('invalid-state');
    } else {
      // The tick won: the finish saw the new, nonzero difference and refused.
      expect(race[0].status).toBe('rejected');
      expect(((race[0] as PromiseRejectedResult).reason as LedgerError).code).toBe('reconciliation-unbalanced');
      expect(final!.differenceMinor).not.toBe(0);
      expect((await store.ledger.getPosting(a.id))?.cleared).toBe('cleared'); // nothing froze
    }
    // Whichever way it went, the log is still a well-formed chain and the book
    // still passes the independent verifier.
    expect((await store.ledger.verifyAuditChain()).ok).toBe(true);
    expect((await store.verifyLedger()).findings).toEqual([]);
  });

  it('one account never ends up with two open reconciliations, by either door', async () => {
    // `reopen` CREATES an open reconciliation, so it owes the same
    // one-per-account serialization `start` does — it used to run that check
    // holding only its own reconciliation row, which on real Postgres does not
    // block a concurrent `start` or a reopen of a different finished statement.
    // Both doors now run that check holding the ACCOUNT row.
    //
    // READ THE CONCURRENCY NOTE ABOVE BEFORE TRUSTING THIS: PGlite serializes
    // every transaction, so this pins the OUTCOME (one open at the end, every
    // other door shut) and CANNOT exercise the row lock that delivers it on real
    // Postgres. Deleting that lock leaves this test green.
    const {cash, income} = await seedWithAccounts();
    const a = await postLeg(cash, income, 10_000);
    const b = await postLeg(cash, income, 2_500);

    const august = await store.ledger.startReconciliation({accountId: cash, statementDate: '2026-08-31', statementBalanceMinor: 10_000}, ACTOR);
    await store.ledger.setReconciliationPostingCleared(august.id, a.id, 'cleared', ACTOR);
    await store.ledger.finishReconciliation(august.id, ACTOR);
    const september = await store.ledger.startReconciliation({accountId: cash, statementDate: '2026-09-30', statementBalanceMinor: 12_500}, ACTOR);
    await store.ledger.setReconciliationPostingCleared(september.id, b.id, 'cleared', ACTOR);
    await store.ledger.finishReconciliation(september.id, ACTOR);

    // Two finished statements and nothing open. Fire all THREE doors that can
    // produce an open reconciliation at once — two reopens of different
    // statements and a fresh start. Exactly one may win.
    expect(await store.ledger.listReconciliations({accountId: cash, status: 'open'})).toHaveLength(0);
    await Promise.allSettled([
      store.ledger.reopenReconciliation(august.id, ACTOR),
      store.ledger.reopenReconciliation(september.id, ACTOR),
      store.ledger.startReconciliation({accountId: cash, statementDate: '2026-10-31', statementBalanceMinor: 0}, ACTOR),
    ]);
    expect(await store.ledger.listReconciliations({accountId: cash, status: 'open'})).toHaveLength(1);

    // …and with one open, every other door is shut, whichever one won.
    expect(await code(store.ledger.startReconciliation({accountId: cash, statementDate: '2026-11-30', statementBalanceMinor: 0}, ACTOR))).toBe(
      'reconciliation-exists',
    );
    for (const finished of await store.ledger.listReconciliations({accountId: cash, status: 'finished'})) {
      expect(await code(store.ledger.reopenReconciliation(finished.id, ACTOR))).toBe('reconciliation-exists');
    }
    expect(await store.ledger.listReconciliations({accountId: cash, status: 'open'})).toHaveLength(1);
    expect((await store.verifyLedger()).findings).toEqual([]);
    expect((await store.ledger.verifyAuditChain()).ok).toBe(true);
  });

  it('caps the set a FINISH writes, at the real boundary — and the cap always has a way out', async () => {
    // THE REAL 1001 BOUNDARY, not a lowered stand-in. Built as compound entries
    // (500 legs on the bank account each) rather than 1001 separate posts, which
    // keeps it seconds rather than minutes.
    //
    // What this pins is the difference between a BOUND and a BRICK. Capping the
    // account's CARDINALITY produced a permanent dead end: start on a small
    // account, post ordinarily until it passes the cap, and finish then refused
    // forever — reopen needs `finished`, start answers `reconciliation-exists`,
    // and there is no cancel. Capping what the write actually TOUCHES always
    // leaves the user a remedy: untick a row.
    const {cash, income} = await seedWithAccounts();
    /** One compound entry with `legs` cleared +1 legs on cash, offset on income. */
    const bulk = async (legs: number): Promise<void> => {
      const draft = await store.ledger.createDraft(
        {
          date: '2026-08-01',
          description: `bulk ${legs}`,
          postings: [
            ...Array.from({length: legs}, () => ({accountId: cash, amountMinor: 1, cleared: 'cleared' as const})),
            ...Array.from({length: legs}, () => ({accountId: income, amountMinor: -1})),
          ],
        },
        ACTOR,
      );
      await store.ledger.post(draft.id, ACTOR);
    };
    await bulk(500);
    await bulk(499); // 999 cleared legs on cash, worth 999 in total
    // The 1000th and 1001st cleared legs. One is worth ZERO, so unticking it
    // later changes the COUNT without touching the balance — which is what makes
    // the capacity refusal and the imbalance refusal provably independent.
    const tail = await store.ledger.createDraft(
      {
        date: '2026-08-02',
        description: 'the 1000th and 1001st',
        postings: [
          {accountId: cash, amountMinor: 0, cleared: 'cleared'},
          {accountId: cash, amountMinor: 1, cleared: 'cleared'},
          {accountId: income, amountMinor: -1},
        ],
      },
      ACTOR,
    );
    const posted = await store.ledger.post(tail.id, ACTOR);
    const zeroLeg = posted.postings.find((p) => p.accountId === cash && p.amountMinor === 0)!;

    // START succeeds on an account past the cap — cardinality never bars it.
    const rec = await store.ledger.startReconciliation(
      {accountId: cash, statementDate: '2026-08-31', statementBalanceMinor: 1_000},
      ACTOR,
    );
    const summary = await store.ledger.getReconciliation(rec.id);
    expect(summary!.matchedPostingIds).toHaveLength(1_001);
    expect(summary!.differenceMinor).toBe(0); // balanced — and still unfinishable

    // FINISH refuses on CAPACITY while the difference is already zero, so the
    // refusal is unambiguously about the write set, and it names the remedy.
    expect(await code(store.ledger.finishReconciliation(rec.id, ACTOR))).toBe('reconciliation-too-large');
    expect((await store.ledger.getReconciliation(rec.id))?.reconciliation.status).toBe('open');

    // THE WAY OUT — one untick, and it is a remedy the user can actually reach.
    await store.ledger.setReconciliationPostingCleared(rec.id, zeroLeg.id, 'pending', ACTOR);
    const trimmed = (await store.ledger.getReconciliation(rec.id))!;
    expect(trimmed.matchedPostingIds).toHaveLength(1_000); // exactly AT the cap
    expect(trimmed.differenceMinor).toBe(0); // …and the balance never moved
    const finished = await store.ledger.finishReconciliation(rec.id, ACTOR);
    expect(finished.reconciliation.status).toBe('finished');

    // The freeze wrote exactly the cap, in ONE bounded audit event, and the
    // reopen releases the same set without tripping its own guard.
    const event = (await store.ledger.listAudit({limit: 5})).find((e) => e.action === 'reconciliation.finish')!;
    expect((event.payload as {postings: unknown[]}).postings).toHaveLength(1_000);
    expect(event.entityIds).toHaveLength(2); // the reconciliation and its account
    expect((await store.ledger.reopenReconciliation(rec.id, ACTOR)).reconciliation.status).toBe('open');

    // The cap is a typed 409 the client can branch on, never a 500.
    expect(LEDGER_ERROR_CODES).toContain('reconciliation-too-large');
    expect(ledgerErrorStatus('reconciliation-too-large')).toBe(409);
  }, 180_000);
});
