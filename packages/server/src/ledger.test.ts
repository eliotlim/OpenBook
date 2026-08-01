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
  LedgerError,
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

describe('LGR-3 — cleared-state workflow + the reconciliation hook (invariant 4)', () => {
  it('pending↔cleared is open; anything touching reconciled is hook-gated', async () => {
    const {cash, income} = await seedWithAccounts();
    const draft = await store.ledger.createDraft(
      {date: '2026-08-01', postings: [{accountId: cash, amountMinor: 100}, {accountId: income, amountMinor: -100}]},
      ACTOR,
    );
    const posted = await store.ledger.post(draft.id, ACTOR);
    const pid = posted.postings[0].id;
    expect((await store.ledger.setPostingCleared(pid, 'cleared', {}, ACTOR)).cleared).toBe('cleared');
    expect((await store.ledger.setPostingCleared(pid, 'pending', {}, ACTOR)).cleared).toBe('pending');
    // Locking rung: reaching `reconciled` needs the reconciliation hook…
    expect(await code(store.ledger.setPostingCleared(pid, 'reconciled', {}, ACTOR))).toBe('reconciled-locked');
    expect((await store.ledger.setPostingCleared(pid, 'reconciled', {via: 'reconciliation'}, ACTOR)).cleared).toBe('reconciled');
    // …and LEAVING it does too (the LGR-11 reopen seam).
    expect(await code(store.ledger.setPostingCleared(pid, 'cleared', {}, ACTOR))).toBe('reconciled-locked');
    expect((await store.ledger.setPostingCleared(pid, 'cleared', {via: 'reconciliation'}, ACTOR)).cleared).toBe('cleared');
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
    await store.ledger.setPostingCleared(posted.postings[0].id, 'cleared', {}, ACTOR);
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
