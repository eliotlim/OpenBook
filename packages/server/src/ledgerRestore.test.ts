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
import {canonicalLedgerJson, type BackupAsset, type LedgerAuditEvent, type LedgerBackupSection, type LedgerVerifyReport, type LibraryBackup} from '@book.dev/sdk';
import {
  buildBeancountMiniBook,
  buildBeancountParityBook,
  mintIdentityKeypair,
  signIdentity,
  type IdentityClaims,
  type IdentityKeypair,
} from '@book.dev/sdk';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';
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
  events: LedgerAuditEvent[];
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
    events: audit,
  };
}

/** The `checked*` counts as one comparable object. */
function counts(verify: LedgerVerifyReport): Record<string, number> {
  return {
    transactions: verify.checkedTransactions,
    postings: verify.checkedPostings,
    accounts: verify.checkedAccounts,
    auditEvents: verify.checkedAuditEvents,
    periods: verify.checkedPeriods,
    evidence: verify.checkedEvidence,
    reconciliations: verify.checkedReconciliations,
  };
}

/**
 * Deepen the fixture with the surfaces the generators do not cover (Quinn Q2):
 * a posted entry outside every closed period, an OPEN reconciliation with a
 * cleared tick on it, and an ABANDONED one — so the round trip proves
 * reconciliation state and workflow flags survive, not just journal rows.
 */
async function seedReconciliations(store: PageStore): Promise<void> {
  const accounts = await store.ledger.listAccounts();
  const bank = accounts.find((a) => a.name === 'Assets:Bank:Checking');
  const card = accounts.find((a) => a.name === 'Liabilities:CreditCard');
  const opening = accounts.find((a) => a.name === 'Equity:OpeningBalances');
  if (!bank || !card || !opening) throw new Error('fixture bug: expected chart accounts missing');
  const draft = await store.ledger.createDraft(
    {
      date: '2026-03-01',
      description: 'statement line to reconcile',
      postings: [
        {accountId: bank.id, amountMinor: 4_200},
        {accountId: opening.id, amountMinor: -4_200},
      ],
    },
    SEED_ACTOR,
  );
  const posted = await store.ledger.post(draft.id, SEED_ACTOR);
  const bankLeg = posted.postings.find((p) => p.accountId === bank.id);
  if (!bankLeg) throw new Error('fixture bug: posted entry lost its bank leg');
  const open = await store.ledger.startReconciliation(
    {accountId: bank.id, statementDate: '2026-03-31', statementBalanceMinor: 4_200},
    SEED_ACTOR,
  );
  await store.ledger.setReconciliationPostingCleared(open.id, bankLeg.id, 'cleared', SEED_ACTOR);
  const abandoned = await store.ledger.startReconciliation(
    {accountId: card.id, statementDate: '2026-03-31', statementBalanceMinor: 0},
    SEED_ACTOR,
  );
  await store.ledger.abandonReconciliation(abandoned.id, SEED_ACTOR);
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

  it(`round-trips the ${FIXTURE} book plus ordinary assets and ACL state with byte + semantic equality`, async () => {
    // ── Seed a real library from the fixture book.
    const source = await provision();
    const sourceStore = new PageStore(source.db);
    await seedLedgerFromFixture(sourceStore, buildBook());
    await seedReconciliations(sourceStore);

    // OB-699's non-ledger loss repro: two ordinary pages share one stored image
    // (dedup), and one carries non-default visibility, ACLs, and agent policy.
    const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 3, 1, 4, 1, 5]);
    const {id: imageId} = await sourceStore.putAsset(imageBytes, 'image/png');
    const imageSnapshot = {
      editorjs: {blocks: []},
      values: [] as Array<[string, unknown]>,
      names: [] as Array<[string, string]>,
      blockdoc: {v: 1, update: '', blocks: [{id: 'image', type: 'image', props: {assetId: imageId}}]},
    };
    const imagePage = await sourceStore.upsertPage({name: 'ordinary image', data: imageSnapshot});
    const sharedPage = await sourceStore.upsertPage({name: 'same image, second page', data: imageSnapshot});
    await sourceStore.refAsset(imageId, imagePage.id);
    // Deliberately leave the second ref edge absent: page documents are the
    // canonical reference source and v3 must repair this stale-edge shape.
    await sourceStore.setPageVisibility(imagePage.id, 'authenticated');
    await sourceStore.setPageAgentEdits(imagePage.id, 'direct');
    await sourceStore.setPageAcl(imagePage.id, {
      subject: 'https://issuer.example#reader',
      level: 'read',
      invitedBy: 'https://issuer.example#owner',
    });
    await sourceStore.setPageAcl(imagePage.id, {
      email: 'Writer@Example.com',
      issuer: 'https://issuer.example',
      level: 'write',
      invitedBy: 'https://issuer.example#owner',
    });
    const sourceAcl = await sourceStore.getPageAcl(imagePage.id);

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
    expect(bundle.version).toBe(3);
    expect(bundle.assets?.length).toBeGreaterThan(1); // ledger evidence + ordinary image
    expect(bundle.assets?.filter((asset) => asset.id === imageId)).toEqual([
      expect.objectContaining({size: imageBytes.byteLength, refs: [imagePage.id, sharedPage.id].sort()}),
    ]);
    expect(bundle.pageAccess?.find((access) => access.pageId === imagePage.id)).toMatchObject({
      visibility: 'authenticated',
      agentEdits: 'direct',
      acl: expect.arrayContaining([
        expect.objectContaining({subject: 'https://issuer.example#reader', level: 'read'}),
        expect.objectContaining({email: 'writer@example.com', issuer: 'https://issuer.example', level: 'write'}),
      ]),
    });

    // ── Destroy. Nothing of the source survives past this line.
    await source.destroy();

    // ── Restore into a brand-new library.
    const target = await provision();
    cleanups.push(target.destroy);
    const targetStore = new PageStore(target.db);
    const result = await targetStore.importBundle(
      {...bundle, mode: 'overwrite', installForeignPageAccess: true},
      {actor: SEED_ACTOR},
    );
    expect(result.ledger).toBe('restored');
    expect(result.diagnostics).toBeUndefined();
    const restoredImage = await targetStore.getAsset(imageId);
    expect(restoredImage?.mime).toBe('image/png');
    expect(Array.from(restoredImage?.bytes ?? [])).toEqual(Array.from(imageBytes));
    expect((await targetStore.pagesReferencingAsset(imageId)).sort()).toEqual([imagePage.id, sharedPage.id].sort());
    expect(await targetStore.getPageVisibility(imagePage.id)).toBe('authenticated');
    expect(await targetStore.getPageAgentEdits(imagePage.id)).toBe('direct');
    expect(await targetStore.getPageAcl(imagePage.id)).toEqual(sourceAcl);

    // ── Diff: semantic equality via the LGR-7 verifier + the audit chain.
    // The restored history carries ONE more event than the source's: the
    // `ledger.restore` provenance event bracketing the installed stream (S6).
    const after = await snapshot(targetStore);
    expect(after.verify.initialized).toBe(true);
    expect(after.verify.findings).toEqual([]);
    expect(after.chainOk, 'the tamper-evidence chain must survive the round trip').toBe(true);
    expect(after.chainLength).toBe(before.chainLength + 1);
    expect(before.verify.checkedReconciliations).toBeGreaterThan(0);
    expect(counts(after.verify)).toEqual({...counts(before.verify), auditEvents: before.verify.checkedAuditEvents + 1});

    // ── Diff: byte equality over the canonical serializers + the audit stream
    // (verbatim up to the appended provenance event, which is then pinned).
    expect(after.csv).toBe(before.csv);
    expect(after.beancount).toBe(before.beancount);
    expect(canonicalLedgerJson(after.events.slice(0, -1))).toBe(before.auditCanonical);
    const provenance = after.events[after.events.length - 1];
    expect(provenance.action).toBe('ledger.restore');
    expect(provenance.actorSubject).toBe(SEED_ACTOR.subject);
    const provPayload = provenance.payload as {bundleSha?: unknown; auditEvents?: unknown; assets?: unknown};
    expect(provPayload.bundleSha).toMatch(/^[0-9a-f]{64}$/);
    expect(provPayload.auditEvents).toBe(before.verify.checkedAuditEvents);
    expect(provPayload.assets).toBe(bundle.assets?.length);

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

  // ── The restore DOOR. One mini-book source bundle is seeded once and shared
  // (door tests mutate clones); each test gets its own fresh target.
  type Bundle = LibraryBackup & {ledger: LedgerBackupSection & {assets: BackupAsset[]}};
  let cachedBundle: Bundle | null = null;
  const sourceBundle = async (): Promise<Bundle> => {
    if (cachedBundle) return cachedBundle;
    const source = await provision();
    const s = new PageStore(source.db);
    await seedLedgerFromFixture(s, buildBeancountMiniBook());
    const v3 = await s.exportAll();
    const {assets = [], ...legacy} = v3;
    delete legacy.pageAccess;
    cachedBundle = {
      ...legacy,
      version: 2,
      ledger: {...v3.ledger!, assets},
    };
    await source.destroy();
    return cachedBundle;
  };
  const freshTarget = async (): Promise<{env: ProvisionedDb; store: PageStore}> => {
    const env = await provision();
    cleanups.push(env.destroy);
    return {env, store: new PageStore(env.db)};
  };

  it('refuses to apply a ledger section over an existing ledger (LGR-3 stands)', async () => {
    const bundle = await sourceBundle();
    const {store: targetStore} = await freshTarget();
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
    const bundle = await sourceBundle();
    const {store: targetStore} = await freshTarget();
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
    const bundle = await sourceBundle();
    const {store: targetStore} = await freshTarget();
    const result = await targetStore.importBundle({
      pages: [], // the user deselected everything ledger-shaped
      databases: [],
      ledger: bundle.ledger,
      mode: 'overwrite',
    });
    expect(result.ledger).toBe('skipped-incomplete');
    expect(await targetStore.ledgerIds()).toBeNull();
  }, 120_000);

  it('cannot conscript an EXISTING database into being "the ledger" (membership, not existence — S2)', async () => {
    const bundle = await sourceBundle();
    const {store: targetStore} = await freshTarget();
    // The victim: an ordinary database the target's owner already uses.
    const victimHost = await targetStore.upsertPage({name: 'CRM', data: {editorjs: {blocks: []}, values: [], names: []}});
    const victimDb = await targetStore.createDatabase({pageId: victimHost.id, name: 'CRM', schema: {properties: [], views: []}});
    // A crafted section claims the victim's rows as the ledger's — with an
    // empty page selection, so only the target's own tables could satisfy a
    // naive existence check.
    const crafted = structuredClone(bundle.ledger) as NonNullable<Bundle['ledger']>;
    const claimed = crafted.settings.ledgerDb as {hostPageId: string; transactions: string; hostPages: Record<string, string>};
    claimed.transactions = victimDb.id;
    claimed.hostPageId = victimHost.id;
    const result = await targetStore.importBundle({pages: [], databases: [], ledger: crafted, mode: 'overwrite'});
    expect(result.ledger).toBe('skipped-incomplete');
    expect(await targetStore.ledgerIds()).toBeNull();
    // The victim database never became "managed": its owner can still write it.
    expect(await targetStore.isLedgerDatabase(victimDb.id)).toBe(false);
  }, 120_000);

  it('requires a genesis event: a stream not opening with ledger.init is skipped (S2)', async () => {
    const bundle = await sourceBundle();
    const {store: targetStore} = await freshTarget();
    const headless = structuredClone(bundle.ledger) as NonNullable<Bundle['ledger']>;
    headless.audit = headless.audit.slice(1); // drop the genesis event
    const result = await targetStore.importBundle({
      pages: bundle.pages,
      databases: bundle.databases,
      ledger: headless,
      mode: 'overwrite',
    });
    expect(result.ledger).toBe('skipped-incomplete');
    expect(await targetStore.ledgerIds()).toBeNull();
  }, 120_000);

  it('REFUSES a stream the tamper check rejects: forged prev-hash links never install (S4)', async () => {
    const bundle = await sourceBundle();
    const {store: targetStore} = await freshTarget();
    const forged = structuredClone(bundle.ledger) as NonNullable<Bundle['ledger']>;
    expect(forged.audit.length).toBeGreaterThan(2);
    // Unique-but-wrong link: dodges the 0021 uniqueness indexes, and before S4
    // restored GREEN under the documented check (which never compared it).
    forged.audit[2] = {...forged.audit[2], prevHash: 'f'.repeat(64)};
    await expect(
      targetStore.importBundle({pages: bundle.pages, databases: bundle.databases, ledger: forged, mode: 'overwrite'}),
    ).rejects.toThrow(/chain broken at seq/);
    expect(await targetStore.ledgerIds()).toBeNull();
  }, 120_000);

  it('verifyLedger now FLAGS a severed prev-hash chain (mutation-verified — S4)', async () => {
    const bundle = await sourceBundle();
    const {env, store: targetStore} = await freshTarget();
    const result = await targetStore.importBundle(
      {pages: bundle.pages, databases: bundle.databases, ledger: bundle.ledger, mode: 'overwrite'},
      {actor: SEED_ACTOR},
    );
    expect(result.ledger).toBe('restored');
    const clean = await targetStore.verifyLedger();
    expect(clean.findings).toEqual([]);
    expect(clean.auditChain?.ok).toBe(true);
    // The mutation: sever one link by direct surgery.
    await env.db.query('UPDATE ledger_audit SET prev_hash = $1 WHERE seq = 3', ['f'.repeat(64)]);
    const dirty = await targetStore.verifyLedger();
    expect(dirty.findings.map((f) => f.code)).toContain('audit-prev-hash-broken');
    expect(dirty.auditChain?.ok).toBe(false);
    expect(dirty.auditChain?.brokenAtSeq).toBe(3);
  }, 120_000);

  it('doctoring the ledger.restore provenance payload is audit-hash-forged (mutation-verified — S6)', async () => {
    const bundle = await sourceBundle();
    const {env, store: targetStore} = await freshTarget();
    await targetStore.importBundle(
      {pages: bundle.pages, databases: bundle.databases, ledger: bundle.ledger, mode: 'overwrite'},
      {actor: SEED_ACTOR},
    );
    expect((await targetStore.verifyLedger()).findings).toEqual([]);
    // Rewrite WHICH bundle was restored, keeping the recorded hash — the
    // repudiation attempt the derived-payload check exists to catch.
    await env.db.query(
      'UPDATE ledger_audit SET payload = jsonb_set(payload, \'{bundleSha}\', to_jsonb($1::text)) WHERE action = \'ledger.restore\'',
      ['0'.repeat(64)],
    );
    const dirty = await targetStore.verifyLedger();
    expect(dirty.findings.map((f) => f.code)).toContain('audit-hash-forged');
  }, 120_000);

  it('rejects a bundle whose evidence bytes do not answer to their hash', async () => {
    const bundle = await sourceBundle();
    const forged = structuredClone(bundle.ledger);
    expect(forged?.assets.length).toBeGreaterThan(0);
    // Swap the receipt's bytes, keep its claimed hash.
    (forged as NonNullable<typeof forged>).assets[0].bytesBase64 = Buffer.from('forged receipt').toString('base64');

    const {store: targetStore} = await freshTarget();
    await expect(
      targetStore.importBundle({pages: bundle.pages, databases: bundle.databases, ledger: forged, mode: 'overwrite'}),
    ).rejects.toThrow(/do not answer to/);
    // The rejection is transactional: nothing half-restored.
    expect(await targetStore.ledgerIds()).toBeNull();
  }, 120_000);

  it('restored assets go through the upload door: mime sanitized, cap and budget enforced, refs bundle-only (S5)', async () => {
    const bundle = await sourceBundle();
    const {env, store: targetStore} = await freshTarget();

    // A victim page that exists in the target but NOT in the bundle: a crafted
    // ref onto it must not attach.
    const victim = await targetStore.upsertPage({name: 'victim', data: {editorjs: {blocks: []}, values: [], names: []}});

    // (a) Executable mime + foreign ref, on an otherwise-honest bundle.
    const doctored = structuredClone(bundle.ledger) as NonNullable<Bundle['ledger']>;
    doctored.assets[0] = {...doctored.assets[0], mime: 'text/html', refs: [...doctored.assets[0].refs, victim.id]};
    const result = await targetStore.importBundle({
      pages: bundle.pages,
      databases: bundle.databases,
      ledger: doctored,
      mode: 'overwrite',
    });
    expect(result.ledger).toBe('restored');
    const stored = await env.db.query<{mime: string}>('SELECT mime FROM assets WHERE id = $1', [doctored.assets[0].id]);
    // `text/html` can never be stored: it would be served from the app origin.
    expect(stored[0]?.mime).toBe('application/octet-stream');
    const refs = await env.db.query<{page_id: string}>('SELECT page_id FROM asset_refs WHERE asset_id = $1 AND page_id = $2', [doctored.assets[0].id, victim.id]);
    expect(refs.length).toBe(0);

    // The remaining refusals get their own fresh target (the restore above
    // already installed a ledger here).
    const {store: t2} = await freshTarget();
    // (b) Control characters in the mime — the header-injection shape.
    const evil = structuredClone(bundle.ledger) as NonNullable<Bundle['ledger']>;
    evil.assets[0] = {...evil.assets[0], mime: 'image/png\r\nX-Injected: 1'};
    await expect(
      t2.importBundle({pages: bundle.pages, databases: bundle.databases, ledger: evil, mode: 'overwrite'}),
    ).rejects.toThrow(/control character/);

    // (c) Over the per-asset byte cap (the upload door's 10 MiB).
    const {createHash} = await import('node:crypto');
    const big = new Uint8Array(11 * 1024 * 1024).fill(7);
    const bigId = createHash('sha256').update(big).digest('hex');
    const oversized = structuredClone(bundle.ledger) as NonNullable<Bundle['ledger']>;
    oversized.assets.push({id: bigId, mime: 'application/pdf', size: big.byteLength, bytesBase64: Buffer.from(big).toString('base64'), refs: []});
    await expect(
      t2.importBundle({pages: bundle.pages, databases: bundle.databases, ledger: oversized, mode: 'overwrite'}),
    ).rejects.toThrow(/asset cap/);

    // (d) The storage budget — same guarded insert as `putAsset`.
    await expect(
      t2.importBundle({pages: bundle.pages, databases: bundle.databases, ledger: bundle.ledger, mode: 'overwrite'}, {assetBudgetBytes: 8}),
    ).rejects.toThrow(/storage budget/);
    // Every refusal above was transactional.
    expect(await t2.ledgerIds()).toBeNull();
  }, 180_000);

  it('re-asserts the restricted visibility posture: a member cannot read the restored books (S1)', async () => {
    const bundle = await sourceBundle();
    const {env, store: targetStore} = await freshTarget();
    const result = await targetStore.importBundle(
      {pages: bundle.pages, databases: bundle.databases, ledger: bundle.ledger, mode: 'overwrite'},
      {actor: SEED_ACTOR},
    );
    expect(result.ledger).toBe('restored');

    // The column posture doSeed establishes, re-established: all five ledger
    // host pages restricted (the bundle cannot carry `visibility` — it is a
    // column, not part of StoredPage — so without the re-assert they landed
    // `inherit` and any member could read the books).
    const ids = await targetStore.ledgerIds();
    expect(ids).not.toBeNull();
    const hostIds = [ids?.hostPageId, ids?.hostPages.accounts, ids?.hostPages.transactions, ids?.hostPages.postings, ids?.hostPages.reconciliations];
    const vis = await env.db.query<{id: string; visibility: string}>('SELECT id, visibility FROM pages WHERE id = ANY($1)', [hostIds]);
    expect(vis.length).toBe(5);
    for (const row of vis) expect(row.visibility).toBe('restricted');

    // The probe, end to end: a signed-in MEMBER (viewer role, no ACL grant) is
    // denied the host page, a transaction row, and the evidence bytes — the
    // three reads the source library denied and a pre-S1 restore handed out.
    const ISS = 'https://account.book.pub';
    const kp: IdentityKeypair = await mintIdentityKeypair('k1');
    await targetStore.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks: {keys: [kp.publicJwk]}}], ownerSubject: `${ISS}#owner`});
    await targetStore.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
    const idFor = (sub: string, over: Partial<IdentityClaims> = {}): Promise<string> =>
      signIdentity(
        kp.privateKey,
        {iss: ISS, sub, name: sub, iat: Math.floor(Date.now() / 1000) - 30, exp: Math.floor(Date.now() / 1000) + 3600, jti: `jti-${sub}-${Math.random()}`, ...over},
        kp.publicJwk.kid,
      );
    const app = createApp(targetStore, undefined, new PageHub(), {identity: new IdentityService(targetStore)});
    const get = async (path: string, jws: string) =>
      app.request(path, {headers: {'X-OpenBook-Client': '1', [IDENTITY_HEADER]: jws}});

    const txRow = (await targetStore.ledger.listTransactions({limit: 1}))[0];
    const assetId = bundle.ledger?.assets[0]?.id as string;
    const viewer = await idFor('viewer');
    expect((await get(`/api/pages/${ids?.hostPageId}`, viewer)).status).toBe(404);
    expect((await get(`/api/pages/${txRow.id}`, viewer)).status).toBe(404);
    expect((await get(`/api/assets/${assetId}`, viewer)).status).toBe(404);
    // The owner still reads all three (the restore did not over-lock).
    const owner = await idFor('owner');
    expect((await get(`/api/pages/${ids?.hostPageId}`, owner)).status).toBe(200);
    expect((await get(`/api/pages/${txRow.id}`, owner)).status).toBe(200);
    expect((await get(`/api/assets/${assetId}`, owner)).status).toBe(200);
  }, 180_000);

  it('the no-existing-ledger check holds INSIDE the transaction: races end typed, never 500 (S3)', async () => {
    // Two DIFFERENT ledger bundles racing into one fresh library: exactly one
    // restores; the loser reports skipped-existing-ledger (a typed outcome,
    // not a unique-index 500), and the surviving book verifies clean.
    const bundleA = await sourceBundle();
    const sourceB = await provision();
    const sb = new PageStore(sourceB.db);
    await seedLedgerFromFixture(sb, buildBeancountMiniBook());
    const bundleB = await sb.exportAll();
    await sourceB.destroy();

    const {store: t1} = await freshTarget();
    const [ra, rb] = await Promise.all([
      t1.importBundle({pages: bundleA.pages, databases: bundleA.databases, ledger: bundleA.ledger, mode: 'overwrite'}, {actor: SEED_ACTOR}),
      t1.importBundle({pages: bundleB.pages, databases: bundleB.databases, ledger: bundleB.ledger, mode: 'overwrite'}, {actor: SEED_ACTOR}),
    ]);
    expect([ra.ledger, rb.ledger].sort()).toEqual(['restored', 'skipped-existing-ledger']);
    expect((await t1.verifyLedger()).findings).toEqual([]);

    // Restore racing ensureSetup: both complete (no raw 500-shaped throw),
    // exactly one ledger stands, and it verifies clean.
    const {store: t2} = await freshTarget();
    const [rc] = await Promise.all([
      t2.importBundle({pages: bundleA.pages, databases: bundleA.databases, ledger: bundleA.ledger, mode: 'overwrite'}, {actor: SEED_ACTOR}),
      t2.ledger.ensureSetup(SEED_ACTOR),
    ]);
    expect(['restored', 'skipped-existing-ledger']).toContain(rc.ledger);
    const report = await t2.verifyLedger();
    expect(report.initialized).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.auditChain?.ok).toBe(true);
  }, 180_000);
});
