/**
 * LGR-15 test/bench plumbing: replay a deterministic fixture book into a REAL
 * library through the ledger's own API, and provision databases on either
 * storage backend.
 *
 * WHY REPLAY, NOT INSERT: the durability suites (restore round-trip, the
 * benchmarks) need a library whose audit chain, entry numbers, and evidence
 * refs are the ones the WRITER produces — a fixture book pasted into the tables
 * raw would have no audit history at all, and the LGR-7 verifier would
 * (correctly) reject it. So the fixture generators stay the committed artifact
 * (LGR-13's discipline) and this module turns a book into store calls:
 * `createAccount` / `createDraft` / `post` / `reverse` / `closePeriod` /
 * `reopenPeriod`, with evidence uploaded as REAL bytes first (the fixture's
 * placeholder hashes cannot pass the post-time asset resolution).
 *
 * The replayed library is NOT byte-identical to the fixture (server-minted ids,
 * server-authored reversal descriptions, real clock timestamps) — deliberately.
 * The round-trip suites compare a library against ITS OWN restore, never
 * against the fixture; the fixture only decides the book's size and shape.
 *
 * BACKEND PROVISIONING: PGlite always (a temp dir per call). External Postgres
 * only when `OPENBOOK_TEST_DATABASE_URL` points at a server we may create and
 * drop scratch databases on — the same optional-but-gating pattern as LGR-13's
 * beancount toolchain: absent locally → the Postgres half SKIPS with a loud
 * notice; `OPENBOOK_REQUIRE_LEDGER_PG=1` (the CI durability job) → absence is
 * a FAILURE, so CI can never silently lose the real-Postgres coverage.
 */

import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {
  LedgerBeancountFixtureBook,
  LedgerEvidence,
  LedgerEvidenceInput,
  LedgerTransaction,
  Principal,
} from '@book.dev/sdk';
import {PgliteDb, PostgresDb, type Db} from './db';
import {runMigrations} from './migrations';
import {PageStore} from './store';

export const SEED_ACTOR: Principal = {
  kind: 'user',
  subject: 'https://fixture.book.pub#keeper',
  issuer: 'https://fixture.book.pub',
  name: 'Fixture Keeper',
  verifiedVia: 'jws',
};

/** Deterministic fake receipt bytes for one fixture evidence item. */
function evidenceBytes(item: LedgerEvidence): Uint8Array {
  const text = `openbook fixture evidence ${item.filename} ${item.sha256} `;
  return new TextEncoder().encode(text.repeat(Math.max(1, Math.ceil(item.size / text.length))));
}

export interface SeededLedger {
  /** fixture account id → real account id. */
  accountIds: Map<string, string>;
  /** fixture transaction id → real transaction id (drafts included). */
  transactionIds: Map<string, string>;
  /** fixture period id → real period id. */
  periodIds: Map<string, string>;
}

/**
 * Replay `book` into `store` through the ledger API. Handles the fixture
 * builders' full vocabulary in creation order: posted entries, drafts,
 * reversal pairs, evidence, period closes, and period reopens (whose closing
 * entries / reversals the STORE mints — the fixture's copies are skipped).
 */
export async function seedLedgerFromFixture(store: PageStore, book: LedgerBeancountFixtureBook): Promise<SeededLedger> {
  await store.ledger.ensureSetup(SEED_ACTOR);
  const accountIds = new Map<string, string>();
  const transactionIds = new Map<string, string>();
  const periodIds = new Map<string, string>();

  for (const account of book.accounts) {
    const created = await store.ledger.createAccount(
      {name: account.name, type: account.type, currency: account.currency, evidenceRequired: account.evidenceRequired},
      SEED_ACTOR,
    );
    accountIds.set(account.id, created.id);
  }

  const closingIds = new Set(book.transactions.filter((t) => t.kind === 'closing').map((t) => t.id));
  const periodByClosing = new Map(book.periods.filter((p) => p.closingEntryId).map((p) => [p.closingEntryId as string, p]));

  const evidenceInputs = async (tx: LedgerTransaction): Promise<LedgerEvidenceInput[] | undefined> => {
    if (tx.evidence.length === 0) return undefined;
    const inputs: LedgerEvidenceInput[] = [];
    for (const item of tx.evidence) {
      const {id} = await store.putAsset(evidenceBytes(item), 'application/pdf');
      inputs.push({sha256: id, filename: item.filename});
    }
    return inputs;
  };

  for (const tx of book.transactions) {
    // The store mints closing entries and reopen reversals itself.
    if (tx.kind === 'closing') {
      const period = periodByClosing.get(tx.id);
      if (!period) throw new Error(`fixture bug: closing entry ${tx.id} belongs to no period`);
      const closed = await store.ledger.closePeriod({start: period.start, end: period.end}, SEED_ACTOR);
      periodIds.set(period.id, closed.period.id);
      if (closed.closingEntry) transactionIds.set(tx.id, closed.closingEntry.id);
      continue;
    }
    if (tx.reverses != null && closingIds.has(tx.reverses)) {
      // Reversal of a closing entry = the period reopen.
      const period = periodByClosing.get(tx.reverses);
      const realPeriodId = period ? periodIds.get(period.id) : undefined;
      if (!period || !realPeriodId) throw new Error(`fixture bug: reversal ${tx.id} reopens an unknown period`);
      const reopened = await store.ledger.reopenPeriod(realPeriodId, SEED_ACTOR);
      if (reopened.reversal) transactionIds.set(tx.id, reopened.reversal.id);
      continue;
    }
    if (tx.reverses != null) {
      const original = transactionIds.get(tx.reverses);
      if (!original) throw new Error(`fixture bug: reversal ${tx.id} precedes its original ${tx.reverses}`);
      const reversal = await store.ledger.reverse(original, {date: tx.date}, SEED_ACTOR);
      transactionIds.set(tx.id, reversal.id);
      continue;
    }
    const draft = await store.ledger.createDraft(
      {
        date: tx.date,
        description: tx.description,
        postings: tx.postings.map((p) => ({
          accountId: accountIds.get(p.accountId) ?? p.accountId,
          amountMinor: p.amountMinor,
          ...(p.memo != null ? {memo: p.memo} : {}),
        })),
        evidence: await evidenceInputs(tx),
      },
      SEED_ACTOR,
    );
    transactionIds.set(tx.id, draft.id);
    // A fixture original that was later reversed carries state 'void'; it still
    // POSTS here — the reversal replay above flips it, exactly as the writer did.
    if (tx.state !== 'draft') await store.ledger.post(draft.id, SEED_ACTOR);
  }

  // Periods with no closing entry (nothing swept) still need closing.
  for (const period of book.periods) {
    if (period.closingEntryId !== null || periodIds.has(period.id)) continue;
    const closed = await store.ledger.closePeriod({start: period.start, end: period.end}, SEED_ACTOR);
    periodIds.set(period.id, closed.period.id);
  }

  return {accountIds, transactionIds, periodIds};
}

// ── Backend provisioning ──────────────────────────────────────────────────────

export interface ProvisionedDb {
  db: Db;
  /** Human label for reports ("pglite" / "postgres"). */
  backend: 'pglite' | 'postgres';
  /** Tear down: close the db and delete the temp dir / drop the scratch database. */
  destroy(): Promise<void>;
}

export interface ProvisionedPostgresDb extends ProvisionedDb {
  /**
   * Open `count` independent, already-connected sessions on this scratch DB.
   * The provisioner owns them and closes them before dropping the database.
   */
  participants(count: number): Promise<Db[]>;
}

/** A fresh migrated PGlite library in its own temp dir. */
export async function provisionPglite(prefix = 'ob-lgr15-'): Promise<ProvisionedDb> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const db = await PgliteDb.create(dir);
  await runMigrations(db);
  return {
    db,
    backend: 'pglite',
    destroy: async () => {
      await db.close();
      rmSync(dir, {recursive: true, force: true});
    },
  };
}

/** The external-Postgres server URL, or null when none is configured. */
export function externalPgUrl(): string | null {
  const url = process.env.OPENBOOK_TEST_DATABASE_URL;
  return typeof url === 'string' && url.length > 0 ? url : null;
}

/** True when the CI durability job demands the external-Postgres half run. */
export function externalPgRequired(): boolean {
  return process.env.OPENBOOK_REQUIRE_LEDGER_PG === '1';
}

/**
 * A fresh migrated scratch database on the external Postgres server —
 * `CREATE DATABASE` under a unique name, dropped again on destroy, so parallel
 * tests and reruns never collide. The URL's own database is only used as the
 * admin connection.
 */
export async function provisionPostgres(url: string): Promise<ProvisionedPostgresDb> {
  const name = `ob_lgr15_${randomUUID().replaceAll('-', '')}`;
  let destroying = false;
  const reportUnexpectedClose = (role: string) => (connectionId: number): void => {
    if (!destroying) {
      console.error(`[postgres scratch ${name}] unexpected ${role} connection close (id ${connectionId})`);
    }
  };
  const admin = new PostgresDb(url, {max: 1, onclose: reportUnexpectedClose('admin')});
  await admin.query(`CREATE DATABASE ${name}`);
  const scratch = new URL(url);
  scratch.pathname = `/${name}`;
  const scratchUrl = scratch.toString();
  const db = new PostgresDb(scratchUrl, {max: 4, onclose: reportUnexpectedClose('pool')});
  const participantDbs = new Set<PostgresDb>();
  await runMigrations(db);
  return {
    db,
    backend: 'postgres',
    participants: async (count: number) => {
      if (!Number.isInteger(count) || count < 1) {
        throw new Error(`Postgres participant count must be a positive integer, received ${count}`);
      }
      const opened: Db[] = [];
      // Connect one-by-one so connection establishment is fixture setup, not an
      // uncontrolled fourth participant in the write race under test.
      for (let i = 0; i < count; i += 1) {
        const participant = new PostgresDb(scratchUrl, {
          max: 1,
          onclose: reportUnexpectedClose(`participant ${i + 1}`),
        });
        participantDbs.add(participant);
        await participant.query('SELECT 1');
        opened.push(participant);
      }
      return opened;
    },
    destroy: async () => {
      destroying = true;
      await Promise.all([...participantDbs].map((participant) => participant.close()));
      await db.close();
      // WITH (FORCE) needs PG 13+; the pinned CI image and any modern server have it.
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.close();
    },
  };
}
