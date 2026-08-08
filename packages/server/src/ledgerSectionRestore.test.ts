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
import {describe, expect, it, vi} from 'vitest';
import {
  API,
  gatherLedgerExportSection,
  isLedgerVerifyAdvisory,
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
  type LedgerVerifyReport,
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

/** The TAMPER band of a verify report — advisory (current-policy) findings
 *  excluded. The fixture flags an account `evidenceRequired` over bare history
 *  (deliberately — it must survive the round trip), which is an advisory on
 *  BOTH sides, never a tamper signal. */
const tamperFindings = (report: LedgerVerifyReport) => report.findings.filter((f) => !isLedgerVerifyAdvisory(f.code));

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

  // A second currency (Quinn 5c): an EUR pair with one posted entry — the
  // round trip must carry the currency on the accounts and the entry intact.
  const eurBank = await store.ledger.createAccount({name: 'Assets:Bank:EUR', type: 'asset', currency: 'EUR'}, SEED_ACTOR);
  const eurOpen = await store.ledger.createAccount({name: 'Equity:Opening:EUR', type: 'equity', currency: 'EUR'}, SEED_ACTOR);
  const eur = await store.ledger.createDraft(
    {
      date: '2026-02-04',
      description: 'EUR opening balance',
      postings: [
        {accountId: eurBank.id, amountMinor: 77_000},
        {accountId: eurOpen.id, amountMinor: -77_000},
      ],
    },
    SEED_ACTOR,
  );
  await store.ledger.post(eur.id, SEED_ACTOR);

  // A CLOSED zero-balance account and an evidence-required flag (Quinn 5b):
  // both are deferred-then-reasserted by the replay, so without them the
  // accountMeta comparison was vacuously green.
  const escrow = await store.ledger.createAccount({name: 'Assets:Escrow', type: 'asset'}, SEED_ACTOR);
  await store.ledger.updateAccount(escrow.id, {status: 'closed'}, SEED_ACTOR);
  const cafe = byName('Expenses:café & misc.');
  await store.ledger.updateAccount(cafe.id, {evidenceRequired: true}, SEED_ACTOR);

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
          (p) => `${nameById.get(p.accountId)}|${t.date}|${t.description}|${p.amountMinor}|${p.cleared}|${t.kind ?? ''}|${p.memo ?? ''}`,
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
    // Tamper band clean; the evidence-required flag over bare history is a
    // deliberate ADVISORY on the source (and must round-trip as one).
    expect(tamperFindings(sourceVerify)).toEqual([]);
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

    // ── The books verify: tamper band empty, and the FRESH audit chain
    // verifies end to end. The evidence-required advisory carried over from
    // the source (same code, same band) — assert the two sides band alike.
    const verify = await target.verifyLedger();
    expect(tamperFindings(verify)).toEqual([]);
    expect(verify.findings.map((f) => f.code).sort()).toEqual(sourceVerify.findings.map((f) => f.code).sort());
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
    expect(tamperFindings(extended)).toEqual([]);
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

    // A JSON-valid but non-section body is a typed 400, never a 500 (Quinn 4).
    const owner = await idFor('owner');
    const junkRes = await app.request(API.ledgerRestoreSection, {
      method: 'POST',
      headers: {'X-OpenBook-Client': '1', 'Content-Type': 'application/json', [IDENTITY_HEADER]: owner},
      body: 'null',
    });
    expect(junkRes.status).toBe(400);
    expect(((await junkRes.json()) as {code: string}).code).toBe('invalid-input');
    expect(await target.ledgerIds()).toBeNull();

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

  it('a deep-junk envelope key refuses BEFORE the first write (Sasha F1 — the hash moved pre-write)', async () => {
    const source = await freshStore();
    await seedLedgerFromFixture(source, buildBeancountMiniBook());
    const section = await captureOverWire(source);
    // A valid book with ~15k-deep junk under a key the parser never read:
    // pre-fix this replayed FULLY, then blew the recursive canonicalizer at
    // provenance time — a marker-less, verify-clean book behind an
    // unretryable empty-target gate. Now the strict envelope refuses it
    // before anything is written, and the hash runs over the validated
    // projection anyway.
    let junk: unknown = 'bottom';
    for (let i = 0; i < 15_000; i += 1) junk = {d: junk};
    const doctored = {...section, junk} as unknown as LedgerExportSection;

    const target = await freshStore();
    await expect(target.ledger.restoreExportSection(doctored, SEED_ACTOR)).rejects.toMatchObject({
      code: 'invalid-input',
      message: expect.stringContaining('unexpected section key'),
    });
    expect(await target.ledgerIds()).toBeNull(); // nothing written, retry open
  }, 120_000);

  it('REFUSES pre-write when income dated in a closed period was posted after its close (Quinn 2)', async () => {
    // The legal live history that cannot round-trip: close February, then
    // post JANUARY-dated income (January is not inside the closed range, so
    // the date lock admits it) — the replayed close would re-sweep it.
    const source = await freshStore();
    await source.ledger.ensureSetup(SEED_ACTOR);
    const cash = await source.ledger.createAccount({name: 'Assets:Cash', type: 'asset'}, SEED_ACTOR);
    const sales = await source.ledger.createAccount({name: 'Revenue:Sales', type: 'revenue'}, SEED_ACTOR);
    await source.ledger.createAccount({name: 'Equity:RetainedEarnings', type: 'equity'}, SEED_ACTOR);
    const feb = await source.ledger.createDraft(
      {date: '2026-02-10', description: 'feb income', postings: [{accountId: cash.id, amountMinor: 100}, {accountId: sales.id, amountMinor: -100}]},
      SEED_ACTOR,
    );
    await source.ledger.post(feb.id, SEED_ACTOR);
    await source.ledger.closePeriod({start: '2026-02-01', end: '2026-02-28'}, SEED_ACTOR);
    const jan = await source.ledger.createDraft(
      {date: '2026-01-15', description: 'january income, posted late', postings: [{accountId: cash.id, amountMinor: 70}, {accountId: sales.id, amountMinor: -70}]},
      SEED_ACTOR,
    );
    await source.ledger.post(jan.id, SEED_ACTOR); // legal: January is not closed
    expect((await source.verifyLedger()).findings).toEqual([]); // an honest book

    const section = await captureOverWire(source);
    const target = await freshStore();
    await expect(target.ledger.restoreExportSection(section, SEED_ACTOR)).rejects.toMatchObject({
      code: 'invalid-input',
      message: expect.stringMatching(/does not match the sweep.*backup bundle/s),
    });
    expect(await target.ledgerIds()).toBeNull(); // refused before the first write
  }, 120_000);

  it('a mid-replay failure ends TYPED, names the partial state, and stamps a failed marker (Quinn 3)', async () => {
    const source = await freshStore();
    await seedLedgerFromFixture(source, buildBeancountMiniBook());
    const section = await captureOverWire(source);

    const target = await freshStore();
    // Induce an environment failure on the second post — exactly the class of
    // error the up-front validation cannot rule out.
    const realPost = target.ledger.post.bind(target.ledger);
    let posts = 0;
    vi.spyOn(target.ledger, 'post').mockImplementation(async (id, actor) => {
      posts += 1;
      if (posts === 2) throw new Error('disk full');
      return realPost(id, actor);
    });

    const err = await target.ledger.restoreExportSection(section, SEED_ACTOR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).code).toBe('invalid-state');
    expect((err as LedgerError).message).toMatch(/PARTIAL book \(1 of \d+ journal entries replayed; cause: disk full\)/);

    // The book ITSELF carries the marker: tail event is a failed ledger.restore.
    const [tail] = await target.ledger.listAudit({limit: 1});
    expect(tail.action).toBe('ledger.restore');
    const payload = tail.payload as Record<string, unknown>;
    expect(payload.failed).toBe(true);
    expect(payload.replayedEntries).toBe(1);
    expect(typeof payload.totalEntries).toBe('number');
    expect(payload.bundleSha).toMatch(/^[0-9a-f]{64}$/);
    // The marker itself verifies (same derived-hash shape as every restore
    // event) and the chain stays linked over the partial history.
    const report = await target.verifyLedger();
    expect(report.auditChain?.ok).toBe(true);
    expect(report.findings.filter((f) => f.code === 'audit-hash-forged')).toEqual([]);
  }, 120_000);

  it('the reconciliation DOWNGRADE arm: a finish leaning on a later-reopened freeze replays as abandoned (Quinn 5a)', async () => {
    const source = await freshStore();
    await source.ledger.ensureSetup(SEED_ACTOR);
    const bank = await source.ledger.createAccount({name: 'Assets:Bank', type: 'asset'}, SEED_ACTOR);
    const equity = await source.ledger.createAccount({name: 'Equity:Opening', type: 'equity'}, SEED_ACTOR);
    const post = async (date: string, amount: number) => {
      const draft = await source.ledger.createDraft(
        {date, description: `deposit ${amount}`, postings: [{accountId: bank.id, amountMinor: amount, cleared: 'cleared'}, {accountId: equity.id, amountMinor: -amount}]},
        SEED_ACTOR,
      );
      return source.ledger.post(draft.id, SEED_ACTOR);
    };
    await post('2026-01-05', 100);
    const r1 = await source.ledger.startReconciliation({accountId: bank.id, statementDate: '2026-01-31', statementBalanceMinor: 100}, SEED_ACTOR);
    await source.ledger.finishReconciliation(r1.id, SEED_ACTOR);
    await post('2026-02-05', 50);
    const r2 = await source.ledger.startReconciliation({accountId: bank.id, statementDate: '2026-02-28', statementBalanceMinor: 150}, SEED_ACTOR);
    await source.ledger.finishReconciliation(r2.id, SEED_ACTOR); // leans on R1's frozen 100
    await source.ledger.reopenReconciliation(r1.id, SEED_ACTOR); // releases the 100 → R2's zero is no longer reproducible

    const section = await captureOverWire(source);
    const target = await freshStore();
    const result = await target.ledger.restoreExportSection(section, SEED_ACTOR);
    expect(result.reconciliationsDowngraded).toBe(1);

    // R2's replay attempt was ABANDONED (audited), its ticks left cleared —
    // workflow metadata degraded honestly; the amounts are untouched.
    const recs = await target.ledger.listReconciliations();
    const byDate = new Map(recs.map((r) => [r.statementDate, r]));
    expect(byDate.get('2026-02-28')?.status).toBe('abandoned');
    expect(byDate.get('2026-01-31')?.status).toBe('open'); // the reopened R1
    const postings = (await target.ledger.listTransactions({limit: 100})).flatMap((t) => t.postings);
    expect(postings.filter((p) => p.cleared === 'reconciled')).toEqual([]);
    expect(postings.filter((p) => p.cleared === 'cleared').length).toBeGreaterThan(0);

    const bankAfter = (await target.ledger.listAccounts()).find((a) => a.name === 'Assets:Bank');
    expect(await target.ledger.accountPostedBalance((bankAfter as {id: string}).id)).toBe(150);
    const [tail] = await target.ledger.listAudit({limit: 1});
    expect((tail.payload as Record<string, unknown>).reconciliationsDowngraded).toBe(1);
    expect((await target.verifyLedger()).findings).toEqual([]);
  }, 120_000);

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
