/**
 * LGR-15 — backup → destroy → restore → diff, the durability acceptance test.
 *
 * One library is seeded through the ledger's own API (real audit chain, real
 * evidence bytes, real entry numbers), exported as a whole-space bundle,
 * DESTROYED (the PGlite data dir deleted / the scratch Postgres database
 * dropped), and restored into a brand-new library. Equality is then asserted
 * on BOTH axes the board names:
 *
 *  - SEMANTIC — the LGR-7 verifier must be CLEAN on the restored library
 *    (`findings: []`, and every `checked*` count equal to the source's), and
 *    the audit hash chain must verify end-to-end (`verifyAuditChain`) — the
 *    tamper-evidence chain survives the round trip, it is not re-minted;
 *  - BYTE — the canonical serializers (LGR-7's postings CSV, LGR-13's
 *    Beancount journal) must produce BYTE-IDENTICAL output before and after,
 *    and the audit stream itself must round-trip verbatim under
 *    `canonicalLedgerJson`. This is the canonicalization decision, stated:
 *    equality is defined over the CANONICAL exports and the audit stream —
 *    not over raw SQL dumps, where storage incidentals (row order, `updated_at`
 *    touch-stamps, JSONB key order) legitimately differ. Anything that feeds a
 *    ledger content hash (properties, posting `position`, `created_at`) IS
 *    preserved by the bundle, and the verifier proves it.
 *
 * Fixture size: the hostile MINI book by default (fast enough for `pnpm test`);
 * the CI durability job sets `OPENBOOK_RESTORE_FIXTURE=parity` for the
 * 500-transaction parity book. Backends: PGlite always; external Postgres when
 * `OPENBOOK_TEST_DATABASE_URL` is set (REQUIRED under
 * `OPENBOOK_REQUIRE_LEDGER_PG=1` — the CI job's setting, LGR-13's
 * optional-but-gating pattern).
 *
 * Plus the doors that must stay shut: a ledger section is NOT applied over an
 * existing ledger (LGR-3), not in copy mode, and not without its own pages.
 */

import {afterAll, describe, expect, it} from 'vitest';
import {canonicalLedgerJson, type LedgerVerifyReport} from '@book.dev/sdk';
import {buildBeancountMiniBook, buildBeancountParityBook} from '@book.dev/sdk';
import {PageStore} from './store';
import {
  SEED_ACTOR,
  externalPgRequired,
  externalPgUrl,
  provisionPglite,
  provisionPostgres,
  seedLedgerFromFixture,
  type ProvisionedDb,
} from './ledgerFixtureSeed';

const FIXTURE = process.env.OPENBOOK_RESTORE_FIXTURE === 'parity' ? 'parity' : 'mini';
const buildBook = FIXTURE === 'parity' ? buildBeancountParityBook : buildBeancountMiniBook;

const PG_URL = externalPgUrl();
if (!PG_URL && !externalPgRequired()) {
  // The LGR-13 loud-skip discipline: never a silent green on lost coverage.
  console.warn(
    '[LGR-15] restore round-trip: external-Postgres half SKIPPED — set OPENBOOK_TEST_DATABASE_URL ' +
      'to a Postgres server that scratch databases may be created on (e.g. postgres://postgres:postgres@127.0.0.1:5432/postgres). ' +
      'The CI durability job runs it against a pinned service container regardless.',
  );
}

it('the external-Postgres backend is present when REQUIRED (CI durability job)', () => {
  if (externalPgRequired()) {
    expect(PG_URL, 'OPENBOOK_REQUIRE_LEDGER_PG=1 but OPENBOOK_TEST_DATABASE_URL is unset').not.toBeNull();
  }
});

/** Everything we compare across the round trip, captured from one library. */
interface Snapshot {
  verify: LedgerVerifyReport;
  chainOk: boolean;
  chainLength: number;
  csv: string;
  beancount: string;
  auditCanonical: string;
}

async function snapshot(store: PageStore): Promise<Snapshot> {
  const verify = await store.verifyLedger();
  const chain = await store.ledger.verifyAuditChain();
  const audit = await store.ledger.exportAuditStream();
  return {
    verify,
    chainOk: chain.ok,
    chainLength: chain.checked,
    csv: await store.ledger.exportPostingsCsv(),
    beancount: await store.ledger.exportBeancount(),
    auditCanonical: canonicalLedgerJson(audit),
  };
}

function backends(): Array<{backend: 'pglite' | 'postgres'; provision: () => Promise<ProvisionedDb>}> {
  const out: Array<{backend: 'pglite' | 'postgres'; provision: () => Promise<ProvisionedDb>}> = [
    {backend: 'pglite', provision: () => provisionPglite('ob-lgr15-restore-')},
  ];
  if (PG_URL) out.push({backend: 'postgres', provision: () => provisionPostgres(PG_URL)});
  return out;
}

describe.each(backends())('LGR-15 — backup → destroy → restore → diff [$backend]', ({provision}) => {
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  it(`round-trips the ${FIXTURE} book with byte + semantic equality (audit chain included)`, async () => {
    // ── Seed a real library from the fixture book.
    const source = await provision();
    const sourceStore = new PageStore(source.db);
    await seedLedgerFromFixture(sourceStore, buildBook());

    // ── Capture the pre-destroy truth. The source must be clean to begin with —
    // a dirty source would make every downstream equality vacuous.
    const before = await snapshot(sourceStore);
    expect(before.verify.initialized).toBe(true);
    expect(before.verify.findings).toEqual([]);
    expect(before.chainOk).toBe(true);
    // Green-on-nothing guards: the fixture genuinely exercises every surface
    // the restore claims to preserve.
    expect(before.verify.checkedTransactions).toBeGreaterThan(0);
    expect(before.verify.checkedEvidence).toBeGreaterThan(0);
    expect(before.verify.checkedPeriods).toBeGreaterThan(0);
    expect(before.verify.checkedAuditEvents).toBeGreaterThan(0);

    // ── Back up.
    const bundle = await sourceStore.exportAll();
    expect(bundle.ledger, 'a seeded ledger must export its durability section').toBeDefined();
    expect(bundle.ledger?.audit.length).toBe(before.verify.checkedAuditEvents);
    expect(bundle.ledger?.assets.length).toBeGreaterThan(0);

    // ── Destroy. Nothing of the source survives past this line.
    await source.destroy();

    // ── Restore into a brand-new library.
    const target = await provision();
    cleanups.push(target.destroy);
    const targetStore = new PageStore(target.db);
    const result = await targetStore.importBundle({
      pages: bundle.pages,
      databases: bundle.databases,
      ledger: bundle.ledger,
      mode: 'overwrite',
    });
    expect(result.ledger).toBe('restored');

    // ── Diff: semantic equality via the LGR-7 verifier + the audit chain.
    const after = await snapshot(targetStore);
    expect(after.verify.initialized).toBe(true);
    expect(after.verify.findings).toEqual([]);
    expect(after.chainOk, 'the tamper-evidence chain must survive the round trip').toBe(true);
    expect(after.chainLength).toBe(before.chainLength);
    expect({
      transactions: after.verify.checkedTransactions,
      postings: after.verify.checkedPostings,
      accounts: after.verify.checkedAccounts,
      auditEvents: after.verify.checkedAuditEvents,
      periods: after.verify.checkedPeriods,
      evidence: after.verify.checkedEvidence,
    }).toEqual({
      transactions: before.verify.checkedTransactions,
      postings: before.verify.checkedPostings,
      accounts: before.verify.checkedAccounts,
      auditEvents: before.verify.checkedAuditEvents,
      periods: before.verify.checkedPeriods,
      evidence: before.verify.checkedEvidence,
    });

    // ── Diff: byte equality over the canonical serializers + the audit stream.
    expect(after.csv).toBe(before.csv);
    expect(after.beancount).toBe(before.beancount);
    expect(after.auditCanonical).toBe(before.auditCanonical);

    // ── The restored ledger is ALIVE, not a diorama: the writer path still
    // works and extends the restored chain (the BIGSERIAL was advanced past
    // the restored tail, entry numbers keep counting).
    const accounts = await targetStore.ledger.listAccounts();
    const a = accounts.find((x) => x.name === 'Assets:Bank:Checking');
    const b = accounts.find((x) => x.name === 'Equity:OpeningBalances');
    expect(a && b).toBeTruthy();
    const draft = await targetStore.ledger.createDraft(
      {
        date: '2026-07-01',
        description: 'post-restore entry',
        postings: [
          {accountId: (a as {id: string}).id, amountMinor: 123},
          {accountId: (b as {id: string}).id, amountMinor: -123},
        ],
      },
      SEED_ACTOR,
    );
    await targetStore.ledger.post(draft.id, SEED_ACTOR);
    const extended = await snapshot(targetStore);
    expect(extended.verify.findings).toEqual([]);
    expect(extended.chainOk).toBe(true);
    expect(extended.chainLength).toBeGreaterThan(after.chainLength);
  }, 300_000);

  it('refuses to apply a ledger section over an existing ledger (LGR-3 stands)', async () => {
    const source = await provision();
    cleanups.push(source.destroy);
    const sourceStore = new PageStore(source.db);
    await seedLedgerFromFixture(sourceStore, buildBeancountMiniBook());
    const bundle = await sourceStore.exportAll();

    const target = await provision();
    cleanups.push(target.destroy);
    const targetStore = new PageStore(target.db);
    // The target has its OWN ledger already.
    await targetStore.ledger.ensureSetup(SEED_ACTOR);
    const ownAudit = canonicalLedgerJson(await targetStore.ledger.exportAuditStream());

    const result = await targetStore.importBundle({
      pages: bundle.pages,
      databases: bundle.databases,
      ledger: bundle.ledger,
      mode: 'overwrite',
    });
    expect(result.ledger).toBe('skipped-existing-ledger');
    // The target's own ledger is untouched: same audit stream, still clean.
    expect(canonicalLedgerJson(await targetStore.ledger.exportAuditStream())).toBe(ownAudit);
    expect((await targetStore.verifyLedger()).findings).toEqual([]);
  }, 120_000);

  it('skips the ledger section in copy mode (re-ids would sever the audit chain)', async () => {
    const source = await provision();
    cleanups.push(source.destroy);
    const sourceStore = new PageStore(source.db);
    await seedLedgerFromFixture(sourceStore, buildBeancountMiniBook());
    const bundle = await sourceStore.exportAll();

    const target = await provision();
    cleanups.push(target.destroy);
    const targetStore = new PageStore(target.db);
    const result = await targetStore.importBundle({
      pages: bundle.pages,
      databases: bundle.databases,
      ledger: bundle.ledger,
      mode: 'copy',
    });
    expect(result.ledger).toBe('skipped-copy-mode');
    // No ledger materialized: the section was not applied.
    expect(await targetStore.ledgerIds()).toBeNull();
  }, 120_000);

  it('skips the ledger section when the selection did not carry the ledger pages', async () => {
    const source = await provision();
    cleanups.push(source.destroy);
    const sourceStore = new PageStore(source.db);
    await seedLedgerFromFixture(sourceStore, buildBeancountMiniBook());
    const bundle = await sourceStore.exportAll();

    const target = await provision();
    cleanups.push(target.destroy);
    const targetStore = new PageStore(target.db);
    const result = await targetStore.importBundle({
      pages: [], // the user deselected everything ledger-shaped
      databases: [],
      ledger: bundle.ledger,
      mode: 'overwrite',
    });
    expect(result.ledger).toBe('skipped-incomplete');
    expect(await targetStore.ledgerIds()).toBeNull();
  }, 120_000);

  it('rejects a bundle whose evidence bytes do not answer to their hash', async () => {
    const source = await provision();
    cleanups.push(source.destroy);
    const sourceStore = new PageStore(source.db);
    await seedLedgerFromFixture(sourceStore, buildBeancountMiniBook());
    const bundle = await sourceStore.exportAll();
    const forged = structuredClone(bundle.ledger);
    expect(forged?.assets.length).toBeGreaterThan(0);
    // Swap the receipt's bytes, keep its claimed hash.
    (forged as NonNullable<typeof forged>).assets[0].bytesBase64 = Buffer.from('forged receipt').toString('base64');

    const target = await provision();
    cleanups.push(target.destroy);
    const targetStore = new PageStore(target.db);
    await expect(
      targetStore.importBundle({pages: bundle.pages, databases: bundle.databases, ledger: forged, mode: 'overwrite'}),
    ).rejects.toThrow(/do not answer to/);
    // The rejection is transactional: nothing half-restored.
    expect(await targetStore.ledgerIds()).toBeNull();
  }, 120_000);
});
