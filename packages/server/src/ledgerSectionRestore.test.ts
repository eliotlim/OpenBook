/**
 * LX-4 — the ledger-records ROUND TRIP: an LX-2 export section, carried over
 * the island wire, restored into a fresh library by REPLAYING it through the
 * ledger writer.
 *
 * What a passing suite means:
 *  - ROUND TRIP: a real book (the hostile mini fixture, deepened with
 *    reconciliations and a reopened period) is captured through the exporting
 *    principal's own reads (`gatherLedgerExportSection`), serialized into a
 *    site island (`libraryIslandScript`), read back (`readLibraryIsland` — the
 *    untrusted-input parse boundary), and restored into a brand-new library.
 *    The restored book produces IDENTICAL report numbers (per-account posted
 *    balances, and the full multiset of posted/void posting lines with their
 *    workflow state), the LGR-7 verifier is CLEAN, the fresh audit chain
 *    verifies end-to-end, and its tail is a `ledger.restore` provenance event
 *    naming the actor, the section's content hash, and the source book's
 *    exported chain anchor.
 *  - THE DOOR: a target that already keeps ANY ledger data refuses with an
 *    actionable typed error and writes NOTHING (merge is out of scope); a
 *    seeded-but-empty ledger restores; an incoherent section (an unbalanced
 *    posted entry) is refused BEFORE the first write.
 *  - THE ROUTE: `POST /api/ledger/restore-section` is instance-administration
 *    gated — a signed-in viewer gets 403 and writes nothing; the owner
 *    restores.
 */
import {describe, expect, it} from 'vitest';
import {
  API,
  gatherLedgerExportSection,
  libraryIslandScript,
  ledgerAuditEventHash,
  mintIdentityKeypair,
  readLibraryIsland,
  signIdentity,
  buildBeancountMiniBook,
  LedgerError,
  type IdentityClaims,
  type IdentityKeypair,
  type LedgerExportSection,
} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';
import {LocalDataClient} from './localClient';
import {SEED_ACTOR, seedLedgerFromFixture} from './ledgerFixtureSeed';

async function freshStore(): Promise<PageStore> {
  const store = new PageStore(await PgliteDb.create('memory://'));
  await store.migrate();
  return store;
}

/**
 * Deepen the mini book with the surfaces the fixture generators leave out:
 * a FINISHED reconciliation (born-cleared postings frozen), an ABANDONED one,
 * an OPEN one holding a tick, and a REOPENED period whose closing entry was
 * real — so the round trip proves reconciliation ownership, cleared state,
 * and the close→reopen chronology survive, not just journal rows.
 */
async function deepenFixture(store: PageStore): Promise<void> {
  const accounts = await store.ledger.listAccounts();
  const byName = (name: string) => {
    const account = accounts.find((a) => a.name === name);
    if (!account) throw new Error(`fixture bug: account ${name} missing`);
    return account;
  };
  const bank = byName('Assets:Bank:Checking');
  const card = byName('Liabilities:CreditCard');
  const opening = byName('Equity:OpeningBalances');
  const sales = byName('Revenue:Sales');

  // A born-cleared bank entry, then a statement that reconciles the account's
  // whole cleared balance (the born-cleared mini postings freeze with it).
  const draft = await store.ledger.createDraft(
    {
      date: '2026-02-03',
      description: 'deposit to reconcile',
      postings: [
        {accountId: bank.id, amountMinor: 4_200, cleared: 'cleared'},
        {accountId: sales.id, amountMinor: -4_200},
      ],
    },
    SEED_ACTOR,
  );
  await store.ledger.post(draft.id, SEED_ACTOR);
  const cleared = (await store.ledger.listTransactions({limit: 1000}))
    .filter((t) => t.state === 'posted' || t.state === 'void')
    .flatMap((t) => t.postings)
    .filter((p) => p.accountId === bank.id && p.cleared === 'cleared')
    .reduce((n, p) => n + p.amountMinor, 0);
  const finished = await store.ledger.startReconciliation(
    {accountId: bank.id, statementDate: '2026-02-28', statementBalanceMinor: cleared},
    SEED_ACTOR,
  );
  await store.ledger.finishReconciliation(finished.id, SEED_ACTOR);

  // An abandoned attempt on the same account (terminal, frees the slot)…
  const abandoned = await store.ledger.startReconciliation(
    {accountId: bank.id, statementDate: '2026-03-31', statementBalanceMinor: 0},
    SEED_ACTOR,
  );
  await store.ledger.abandonReconciliation(abandoned.id, SEED_ACTOR);
  // …and an OPEN one on the card, holding a tick.
  const open = await store.ledger.startReconciliation(
    {accountId: card.id, statementDate: '2026-02-28', statementBalanceMinor: -2_500},
    SEED_ACTOR,
  );
  const cardLeg = (await store.ledger.listTransactions({limit: 1000}))
    .flatMap((t) => t.postings)
    .find((p) => p.accountId === card.id && p.cleared === 'pending');
  if (!cardLeg) throw new Error('fixture bug: no pending card posting to tick');
  await store.ledger.setReconciliationPostingCleared(open.id, cardLeg.id, 'cleared', SEED_ACTOR);

  // A February close over real activity, then a reopen: the section carries a
  // REOPENED period whose (void) closing entry and posted reversal both exist.
  const feb = await store.ledger.createDraft(
    {
      date: '2026-02-10',
      description: 'february revenue',
      postings: [
        {accountId: bank.id, amountMinor: 9_900},
        {accountId: sales.id, amountMinor: -9_900},
      ],
    },
    SEED_ACTOR,
  );
  await store.ledger.post(feb.id, SEED_ACTOR);
  const closed = await store.ledger.closePeriod({start: '2026-02-01', end: '2026-02-28'}, SEED_ACTOR);
  expect(closed.closingEntry).not.toBeNull();
  await store.ledger.reopenPeriod(closed.period.id, SEED_ACTOR);
  void opening;
}

/** Everything "the reports" can see, as one comparable value. */
async function reportFingerprint(store: PageStore) {
  const accounts = await store.ledger.listAccounts();
  const nameById = new Map(accounts.map((a) => [a.id, a.name]));
  const transactions = await store.ledger.listTransactions({limit: 1000});
  const lines = (state: 'posted' | 'void' | 'draft') =>
    transactions
      .filter((t) => t.state === state)
      .flatMap((t) =>
        t.postings.map(
          (p) => `${nameById.get(p.accountId)}|${t.date}|${p.amountMinor}|${p.cleared}|${t.kind ?? ''}|${p.memo ?? ''}`,
        ),
      )
      .sort();
  const balances: Record<string, number> = {};
  for (const account of accounts) {
    balances[account.name] = await store.ledger.accountPostedBalance(account.id);
  }
  const reconciliations = (await store.ledger.listReconciliations())
    .map((r) => `${nameById.get(r.accountId)}|${r.statementDate}|${r.statementBalanceMinor}|${r.status}`)
    .sort();
  const periods = (await store.ledger.listPeriods())
    .map((p) => `${p.start}|${p.end}|${p.status}|${p.closingEntryId ? 'entry' : 'none'}|${p.reopenEntryId ? 'reversal' : 'none'}`)
    .sort();
  const accountMeta = accounts.map((a) => `${a.name}|${a.type}|${a.status}|${a.currency}|${a.evidenceRequired}`).sort();
  return {posted: lines('posted'), void: lines('void'), drafts: lines('draft'), balances, reconciliations, periods, accountMeta};
}

/** Capture the LX-2 section and round-trip it over the island WIRE. */
async function captureOverWire(store: PageStore): Promise<LedgerExportSection> {
  const client = new LocalDataClient(store, new PageHub());
  const section = await gatherLedgerExportSection(client);
  expect(section, 'the fixture book must capture a complete section').not.toBeNull();
  const html = `<html><body>${libraryIslandScript('root', {pages: [], databases: []}, {ledger: section!})}</body></html>`;
  const island = readLibraryIsland(html);
  expect(island?.ledger, 'the island wire must carry the section back').toBeDefined();
  return island!.ledger!;
}

describe('LX-4 — export section → island wire → replay restore', () => {
  it('round-trips the deepened mini book with identical report numbers, a clean verifier, and import provenance', async () => {
    const source = await freshStore();
    await seedLedgerFromFixture(source, buildBeancountMiniBook());
    await deepenFixture(source);

    const before = await reportFingerprint(source);
    const sourceVerify = await source.verifyLedger();
    expect(sourceVerify.findings).toEqual([]);
    const sourceHead = (await source.ledger.listAudit({limit: 1}))[0];

    const section = await captureOverWire(source);

    const target = await freshStore();
    const result = await target.ledger.restoreExportSection(section, SEED_ACTOR);

    // ── Honest degradation counters: the mini book carries evidence, and an
    // HTML export cannot carry the bytes — dropped, counted, never silent.
    expect(result.evidenceDropped).toBeGreaterThan(0);
    expect(result.reconciliationsDowngraded).toBe(0);
    expect(result.restored.accounts).toBe(before.accountMeta.length);
    expect(result.restored.periods).toBe(before.periods.length);

    // ── Report numbers: identical, line for line and balance for balance.
    const after = await reportFingerprint(target);
    expect(after.balances).toEqual(before.balances);
    expect(after.posted).toEqual(before.posted);
    expect(after.void).toEqual(before.void);
    expect(after.drafts).toEqual(before.drafts);
    expect(after.reconciliations).toEqual(before.reconciliations);
    expect(after.periods).toEqual(before.periods);
    expect(after.accountMeta).toEqual(before.accountMeta);

    // ── The books verify: no findings (the dropped evidence is not an
    // advisory here — no account in the mini book requires evidence), and the
    // FRESH audit chain verifies end to end.
    const verify = await target.verifyLedger();
    expect(verify.findings).toEqual([]);
    expect(verify.auditChain?.ok).toBe(true);
    expect(verify.checkedTransactions).toBeGreaterThan(0);

    // ── Provenance: the chain's tail is the `ledger.restore` event (the
    // LGR-15 convention, extended), naming actor, section hash, and the SOURCE
    // book's exported chain anchor.
    const [tail] = await target.ledger.listAudit({limit: 1});
    expect(tail.action).toBe('ledger.restore');
    expect(tail.actorSubject).toBe(SEED_ACTOR.subject);
    const payload = tail.payload as Record<string, unknown>;
    expect(payload.source).toBe('export-section');
    expect(payload.bundleSha).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.sourceAuditHeadSeq).toBe(sourceHead.seq);
    expect(payload.sourceAuditHeadHash).toBe(await ledgerAuditEventHash(sourceHead));
    expect(payload.evidenceDropped).toBe(result.evidenceDropped);
    expect(payload.auditEvents).toBeGreaterThan(0);

    // ── The restored ledger is ALIVE: the writer extends the fresh chain.
    const accounts = await target.ledger.listAccounts();
    const bank = accounts.find((a) => a.name === 'Assets:Bank:Checking');
    const sales = accounts.find((a) => a.name === 'Revenue:Sales');
    const draft = await target.ledger.createDraft(
      {
        date: '2026-03-02',
        description: 'post-restore entry',
        postings: [
          {accountId: (bank as {id: string}).id, amountMinor: 123},
          {accountId: (sales as {id: string}).id, amountMinor: -123},
        ],
      },
      SEED_ACTOR,
    );
    await target.ledger.post(draft.id, SEED_ACTOR);
    const extended = await target.verifyLedger();
    expect(extended.findings).toEqual([]);
    expect(extended.auditChain?.ok).toBe(true);

    // ── And the restored period lock is REAL: a post dated inside the
    // still-closed January period refuses exactly as it would on the source.
    const janDraft = await target.ledger.createDraft(
      {
        date: '2026-01-20',
        description: 'dated into the restored closed period',
        postings: [
          {accountId: (bank as {id: string}).id, amountMinor: 5},
          {accountId: (sales as {id: string}).id, amountMinor: -5},
        ],
      },
      SEED_ACTOR,
    );
    await expect(target.ledger.post(janDraft.id, SEED_ACTOR)).rejects.toMatchObject({code: 'period-closed'});
  }, 240_000);

  it('REFUSES a non-empty target with an actionable message and writes nothing (merge is out of scope)', async () => {
    const source = await freshStore();
    await seedLedgerFromFixture(source, buildBeancountMiniBook());
    const section = await captureOverWire(source);

    const target = await freshStore();
    await target.ledger.ensureSetup(SEED_ACTOR);
    await target.ledger.createAccount({name: 'Assets:Cash', type: 'asset'}, SEED_ACTOR);
    const auditBefore = await target.ledger.exportAuditStream();

    await expect(target.ledger.restoreExportSection(section, SEED_ACTOR)).rejects.toMatchObject({
      code: 'invalid-state',
      message: expect.stringMatching(/already keeps books.*1 account.*empty ledger.*fresh library/s),
    });
    // Nothing was written: same audit stream, same single account.
    expect(await target.ledger.exportAuditStream()).toEqual(auditBefore);
    expect((await target.ledger.listAccounts()).length).toBe(1);
  }, 120_000);

  it('restores into a SEEDED-BUT-EMPTY ledger (opening the ledger screen must not brick the import)', async () => {
    const source = await freshStore();
    await seedLedgerFromFixture(source, buildBeancountMiniBook());
    const section = await captureOverWire(source);

    const target = await freshStore();
    await target.ledger.ensureSetup(SEED_ACTOR); // seeded, zero rows
    const result = await target.ledger.restoreExportSection(section, SEED_ACTOR);
    expect(result.restored.accounts).toBeGreaterThan(0);
    expect((await target.verifyLedger()).findings).toEqual([]);
  }, 120_000);

  it('refuses an incoherent section BEFORE the first write (an unbalanced posted entry)', async () => {
    const source = await freshStore();
    await seedLedgerFromFixture(source, buildBeancountMiniBook());
    const section = await captureOverWire(source);

    const doctored = structuredClone(section);
    const postingsDb = (doctored.settings.ledgerDb as {postings: string}).postings;
    const victim = doctored.library.pages.find(
      (p) => p.databaseId === postingsDb && typeof (p.properties as Record<string, unknown>).lp_amount_minor === 'number',
    );
    expect(victim).toBeDefined();
    (victim!.properties as Record<string, unknown>).lp_amount_minor =
      ((victim!.properties as Record<string, unknown>).lp_amount_minor as number) + 1;

    const target = await freshStore();
    await expect(target.ledger.restoreExportSection(doctored, SEED_ACTOR)).rejects.toMatchObject({code: 'invalid-input'});
    // Refused up front: the target never grew a ledger.
    expect(await target.ledgerIds()).toBeNull();
  }, 120_000);

  it('the HTTP door is instance-administration gated: a viewer 403s and writes nothing; the owner restores', async () => {
    const source = await freshStore();
    await seedLedgerFromFixture(source, buildBeancountMiniBook());
    const section = await captureOverWire(source);

    const target = await freshStore();
    const ISS = 'https://account.book.pub';
    const kp: IdentityKeypair = await mintIdentityKeypair('k1');
    await target.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks: {keys: [kp.publicJwk]}}], ownerSubject: `${ISS}#owner`});
    await target.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
    const idFor = (sub: string, over: Partial<IdentityClaims> = {}): Promise<string> =>
      signIdentity(
        kp.privateKey,
        {iss: ISS, sub, name: sub, iat: Math.floor(Date.now() / 1000) - 30, exp: Math.floor(Date.now() / 1000) + 3600, jti: `jti-${sub}-${Math.random()}`, ...over},
        kp.publicJwk.kid,
      );
    const app = createApp(target, undefined, new PageHub(), {identity: new IdentityService(target)});
    const post = async (jws: string) =>
      app.request(API.ledgerRestoreSection, {
        method: 'POST',
        headers: {'X-OpenBook-Client': '1', 'Content-Type': 'application/json', [IDENTITY_HEADER]: jws},
        body: JSON.stringify(section),
      });

    const viewerRes = await post(await idFor('viewer'));
    expect(viewerRes.status).toBe(403);
    expect(await target.ledgerIds()).toBeNull(); // the refusal wrote nothing

    const ownerRes = await post(await idFor('owner'));
    expect(ownerRes.status).toBe(200);
    const body = (await ownerRes.json()) as {restored: {accounts: number}};
    expect(body.restored.accounts).toBeGreaterThan(0);
    expect((await target.verifyLedger()).findings).toEqual([]);

    // A second POST now hits the non-empty gate: typed 409, actionable body.
    const again = await post(await idFor('owner'));
    expect(again.status).toBe(409);
    const refusal = (await again.json()) as {error: string; code: string};
    expect(refusal.code).toBe('invalid-state');
    expect(refusal.error).toMatch(/already keeps books/);
  }, 240_000);

  it('LedgerError semantics: a doctored reconciled↔frozen invariant is an invalid-input refusal', async () => {
    const source = await freshStore();
    await seedLedgerFromFixture(source, buildBeancountMiniBook());
    const section = await captureOverWire(source);
    const doctored = structuredClone(section);
    const postingsDb = (doctored.settings.ledgerDb as {postings: string}).postings;
    const victim = doctored.library.pages.find((p) => p.databaseId === postingsDb);
    expect(victim).toBeDefined();
    (victim!.properties as Record<string, unknown>).lp_cleared = 'reconciled'; // frozen by nothing

    const target = await freshStore();
    const err = await target.ledger.restoreExportSection(doctored, SEED_ACTOR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).code).toBe('invalid-input');
    expect((err as LedgerError).message).toMatch(/reconciled/);
    expect(await target.ledgerIds()).toBeNull();
  }, 120_000);
});
