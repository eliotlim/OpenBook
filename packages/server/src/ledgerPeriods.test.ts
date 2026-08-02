/**
 * Period close (LGR-12) — store-level enforcement tests.
 *
 * Pins the acceptance surface at the STORE layer (the browser-local path — the
 * HTTP routes are thin skins over the same methods, spot-checked at the end):
 *  - closing a period posts the closing entry through the ordinary machinery
 *    (real transaction: entry number, register/list visibility, audit event,
 *    `verifyLedger` clean) and ZEROES every income-statement account as of the
 *    close while moving the total to retained earnings (the spec's
 *    day-after-close AC, at the balance level the fold reads);
 *  - a post OR a reversal dated inside a closed period rejects `period-closed`;
 *    dated outside, both proceed;
 *  - a closing entry cannot be reversed directly (`invalid-state`) — reopening
 *    its period is the one sanctioned void;
 *  - reopen restores postability, voids the closing entry via a real reversal
 *    (negated legs, `reverses` link, original → `void`), keeps the period
 *    record as history, and the audit trail carries the whole story
 *    (`period.close` + `period.reopen`, hash chain intact, replay in
 *    agreement);
 *  - overlapping closes reject `period-overlap`; malformed input rejects
 *    `invalid-input`; a missing retained-earnings account rejects
 *    `account-not-found`; a range with nothing to close still LOCKS;
 *  - open reconciliations WARN (named in the result) and never block.
 *
 * CONCURRENCY CAVEAT (the LGR-11 honesty-note pattern): PGlite serializes every
 * transaction, so the periods-row lock choreography — post's `FOR SHARE`
 * against close's `FOR UPDATE`, and the `period-close-conflict` recompute — is
 * NOT exercised here and cannot be. Those paths are code-review-verified
 * against the lock order documented on `loadAccountPostingsOn`. Do not weaken
 * a lock on the strength of this suite staying green.
 */

import {beforeEach, describe, expect, it} from 'vitest';
import {
  API,
  LedgerError,
  ledgerErrorStatus,
  replayLedgerAudit,
  type LedgerPeriodCloseResult,
  type LedgerTransaction,
  type Principal,
} from '@book.dev/sdk';
import {PgliteDb, type Db} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {verifyLedger} from './ledgerVerify';

const ACTOR: Principal = {kind: 'user', subject: 'https://iss#tester', issuer: 'https://iss', name: 'Tester', verifiedVia: 'jws'};

let db: Db;
let store: PageStore;
let cashId: string;
let salesId: string;
let rentId: string;
let retainedId: string;

/** Post one balanced two-leg entry dated `date`: cash debit, `creditId` credit. */
async function postEntry(date: string, amountMinor: number, creditId: string, description = `entry ${date}`): Promise<LedgerTransaction> {
  const draft = await store.ledger.createDraft(
    {
      date,
      description,
      postings: [
        {accountId: cashId, amountMinor},
        {accountId: creditId, amountMinor: -amountMinor},
      ],
    },
    ACTOR,
  );
  return store.ledger.post(draft.id, ACTOR);
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'NO-ERROR';
  } catch (err) {
    if (err instanceof LedgerError) return err.code;
    throw err;
  }
};

beforeEach(async () => {
  db = await PgliteDb.create('memory://');
  store = new PageStore(db);
  await store.migrate();
  await store.ledger.ensureSetup(ACTOR);
  cashId = (await store.ledger.createAccount({name: 'Assets:Cash', type: 'asset'}, ACTOR)).id;
  salesId = (await store.ledger.createAccount({name: 'Income:Sales', type: 'revenue'}, ACTOR)).id;
  rentId = (await store.ledger.createAccount({name: 'Expenses:Rent', type: 'expense'}, ACTOR)).id;
  retainedId = (await store.ledger.createAccount({name: 'Equity:RetainedEarnings', type: 'equity'}, ACTOR)).id;
});

/** Book a quarter of activity and close it. Sales 10 000 Cr, rent 4 000 Dr. */
async function closeQ1(): Promise<LedgerPeriodCloseResult> {
  await postEntry('2026-01-15', 10_000, salesId, 'January sales');
  await postEntry('2026-02-10', -4_000, rentId, 'February rent');
  return store.ledger.closePeriod({start: '2026-01-01', end: '2026-03-31'}, ACTOR);
}

describe('LGR-12 — closing a period', () => {
  it('posts a REAL closing entry: income accounts zeroed, retained earnings updated (the day-after AC)', async () => {
    const result = await closeQ1();
    const entry = result.closingEntry;
    expect(entry).not.toBeNull();
    expect(entry!.state).toBe('posted');
    expect(entry!.kind).toBe('closing');
    expect(entry!.date).toBe('2026-03-31');
    expect(entry!.entryNo).not.toBeNull();
    // The legs: sales balance −10 000 → +10 000 leg; rent balance +4 000 →
    // −4 000 leg; retained earnings carries the net (a 6 000 profit = credit).
    const byAccount = new Map(entry!.postings.map((p) => [p.accountId, p.amountMinor]));
    expect(byAccount.get(salesId)).toBe(10_000);
    expect(byAccount.get(rentId)).toBe(-4_000);
    expect(byAccount.get(retainedId)).toBe(-6_000);
    // DAY AFTER: every flow account reads zero; equity holds the earnings.
    expect(await store.ledger.accountPostedBalance(salesId)).toBe(0);
    expect(await store.ledger.accountPostedBalance(rentId)).toBe(0);
    expect(await store.ledger.accountPostedBalance(retainedId)).toBe(-6_000);
    // A real transaction: it is in the ordinary read surface and the export.
    const listed = await store.ledger.listTransactions();
    expect(listed.some((t) => t.id === entry!.id)).toBe(true);
    expect(await store.ledger.exportPostingsCsv()).toContain(entry!.id);
    // The period record.
    expect(result.period.status).toBe('closed');
    expect(result.period.closingEntryId).toBe(entry!.id);
    const periods = await store.ledger.listPeriods();
    expect(periods).toHaveLength(1);
    expect(periods[0].id).toBe(result.period.id);
    // The book stays verifiably clean.
    expect((await verifyLedger(db)).findings).toEqual([]);
  });

  it('closing amounts are CUMULATIVE as of end — pre-start activity is swept too', async () => {
    // First close does not start at the book's first entry: income posted
    // BEFORE `start` must still be zeroed, or the flow accounts would not read
    // zero the day after the close.
    await postEntry('2025-11-20', 5_000, salesId, 'November sales');
    const result = await closeQ1();
    const byAccount = new Map(result.closingEntry!.postings.map((p) => [p.accountId, p.amountMinor]));
    expect(byAccount.get(salesId)).toBe(15_000);
    expect(await store.ledger.accountPostedBalance(salesId)).toBe(0);
    expect(await store.ledger.accountPostedBalance(retainedId)).toBe(-11_000);
  });

  it('a range with NOTHING to close still locks, with no closing entry', async () => {
    const result = await store.ledger.closePeriod({start: '2026-01-01', end: '2026-03-31'}, ACTOR);
    expect(result.closingEntry).toBeNull();
    expect(result.period.closingEntryId).toBeNull();
    const draft = await store.ledger.createDraft(
      {date: '2026-02-01', description: 'in the locked range', postings: [
        {accountId: cashId, amountMinor: 100},
        {accountId: salesId, amountMinor: -100},
      ]},
      ACTOR,
    );
    expect(await code(store.ledger.post(draft.id, ACTOR))).toBe('period-closed');
    expect((await verifyLedger(db)).findings).toEqual([]);
  });

  it('rejects malformed input, an inverted range, and an overlapping close (typed)', async () => {
    expect(await code(store.ledger.closePeriod({start: 'nope', end: '2026-03-31'}, ACTOR))).toBe('invalid-input');
    expect(await code(store.ledger.closePeriod({start: '2026-03-31', end: '2026-01-01'}, ACTOR))).toBe('invalid-input');
    await closeQ1();
    // Overlap at the edge (end of the new range inside the closed one).
    expect(await code(store.ledger.closePeriod({start: '2025-12-01', end: '2026-01-01'}, ACTOR))).toBe('period-overlap');
    // A disjoint later range is fine.
    const q2 = await store.ledger.closePeriod({start: '2026-04-01', end: '2026-06-30'}, ACTOR);
    expect(q2.period.status).toBe('closed');
  });

  it('rejects an OUT-OF-ORDER close — the double-sweep cannot happen (Quinn R1)', async () => {
    // The failure this rule exists to prevent, walked to its edge: Q1 holds
    // 10 000 of revenue, Q2 another 5 000. Closing Q2 FIRST sweeps the
    // cumulative 15 000 (correct on its own terms) — and closing Q1 afterwards
    // would re-sweep Q1's 10 000, because Q1's balance-as-of-end cannot see
    // Q2's LATER-dated closing entry: revenue would end at +10 000 (a debit
    // balance on a revenue account), retained earnings at −25 000, both
    // periods' day-after-zero claims false, and `verifyLedger` still green
    // (the books are store-written). The store rejects instead.
    await postEntry('2026-01-15', 10_000, salesId, 'Q1 sales');
    await postEntry('2026-05-10', 5_000, salesId, 'Q2 sales');
    const q2 = await store.ledger.closePeriod({start: '2026-04-01', end: '2026-06-30'}, ACTOR);
    const q2Legs = new Map(q2.closingEntry!.postings.map((p) => [p.accountId, p.amountMinor]));
    expect(q2Legs.get(salesId)).toBe(15_000);
    expect(await store.ledger.accountPostedBalance(salesId)).toBe(0);
    expect(await store.ledger.accountPostedBalance(retainedId)).toBe(-15_000);

    // The earlier range is DISJOINT (no overlap) — only the ordering rule
    // stands between this call and corrupted books.
    expect(await code(store.ledger.closePeriod({start: '2026-01-01', end: '2026-03-31'}, ACTOR))).toBe('period-out-of-order');

    // Day-after balances are still TRUE, and nothing was double-swept.
    expect(await store.ledger.accountPostedBalance(salesId)).toBe(0);
    expect(await store.ledger.accountPostedBalance(retainedId)).toBe(-15_000);

    // The sanctioned path the rejection names: reopen the later period, then
    // close in chronological order — each sweep takes exactly its own money.
    await store.ledger.reopenPeriod(q2.period.id, ACTOR);
    const q1 = await store.ledger.closePeriod({start: '2026-01-01', end: '2026-03-31'}, ACTOR);
    expect(new Map(q1.closingEntry!.postings.map((p) => [p.accountId, p.amountMinor])).get(salesId)).toBe(10_000);
    const q2Again = await store.ledger.closePeriod({start: '2026-04-01', end: '2026-06-30'}, ACTOR);
    expect(new Map(q2Again.closingEntry!.postings.map((p) => [p.accountId, p.amountMinor])).get(salesId)).toBe(5_000);
    expect(await store.ledger.accountPostedBalance(salesId)).toBe(0);
    expect(await store.ledger.accountPostedBalance(retainedId)).toBe(-15_000);
    expect((await verifyLedger(db)).findings).toEqual([]);
  });

  it('rejects when no retained-earnings account can be resolved (typed, with guidance)', async () => {
    // A fresh book without the starter chart's equity account.
    db = await PgliteDb.create('memory://');
    store = new PageStore(db);
    await store.migrate();
    await store.ledger.ensureSetup(ACTOR);
    cashId = (await store.ledger.createAccount({name: 'Assets:Cash', type: 'asset'}, ACTOR)).id;
    salesId = (await store.ledger.createAccount({name: 'Income:Sales', type: 'revenue'}, ACTOR)).id;
    await postEntry('2026-01-15', 1_000, salesId);
    expect(await code(store.ledger.closePeriod({start: '2026-01-01', end: '2026-03-31'}, ACTOR))).toBe('account-not-found');
    // An explicit non-equity target is rejected too.
    expect(await code(store.ledger.closePeriod({start: '2026-01-01', end: '2026-03-31', retainedEarningsAccountId: cashId}, ACTOR))).toBe('invalid-input');
  });

  it('open reconciliations WARN in the result and never block the close', async () => {
    await postEntry('2026-01-15', 10_000, salesId);
    const rec = await store.ledger.startReconciliation(
      {accountId: cashId, statementDate: '2026-01-31', statementBalanceMinor: 10_000},
      ACTOR,
    );
    const result = await store.ledger.closePeriod({start: '2026-01-01', end: '2026-03-31'}, ACTOR);
    expect(result.period.status).toBe('closed'); // proceeded — a notice, not a gate
    expect(result.openReconciliations.map((r) => r.id)).toEqual([rec.id]);
    // The audit payload names them too (advisory context for the trail).
    const events = await store.ledger.listAudit({limit: 5});
    const close = events.find((e) => e.action === 'period.close');
    expect((close!.payload as {openReconciliationIds?: string[]}).openReconciliationIds).toEqual([rec.id]);
  });
});

describe('LGR-12 — the date-range lock', () => {
  it('a post dated inside a closed period rejects period-closed; outside, it posts', async () => {
    await closeQ1();
    const inRange = await store.ledger.createDraft(
      {date: '2026-03-31', description: 'late arrival', postings: [
        {accountId: cashId, amountMinor: 700},
        {accountId: salesId, amountMinor: -700},
      ]},
      ACTOR,
    );
    expect(await code(store.ledger.post(inRange.id, ACTOR))).toBe('period-closed');
    // The rejection rolled the whole post back: still a draft, no entry number.
    const still = await store.ledger.getTransaction(inRange.id);
    expect(still!.state).toBe('draft');
    expect(still!.entryNo).toBeNull();
    // Re-dating the SAME draft outside the range makes the same post legal.
    await store.ledger.updateDraft(inRange.id, {date: '2026-04-01'}, ACTOR);
    const posted = await store.ledger.post(inRange.id, ACTOR);
    expect(posted.state).toBe('posted');
  });

  it('a reversal dated inside a closed period rejects period-closed — on both dating paths', async () => {
    // Path 1: the original is INSIDE the closed period, so the DEFAULT
    // reversal date (the original's) is locked.
    const original = await postEntry('2026-02-20', 3_000, salesId, 'to be corrected');
    await store.ledger.closePeriod({start: '2026-01-01', end: '2026-03-31'}, ACTOR);
    expect(await code(store.ledger.reverse(original.id, {}, ACTOR))).toBe('period-closed');
    // An EXPLICIT date outside the period is the sanctioned correction shape.
    const reversal = await store.ledger.reverse(original.id, {date: '2026-04-01'}, ACTOR);
    expect(reversal.state).toBe('posted');
    expect(reversal.reverses).toBe(original.id);
    // Path 2: the original is OUTSIDE, but the caller dates the reversal in.
    const later = await postEntry('2026-05-05', 900, salesId);
    expect(await code(store.ledger.reverse(later.id, {date: '2026-02-01'}, ACTOR))).toBe('period-closed');
  });

  it('drafts stay freely editable in a closed range — only the books are locked', async () => {
    await closeQ1();
    const draft = await store.ledger.createDraft(
      {date: '2026-02-14', description: 'draft in closed range', postings: [
        {accountId: cashId, amountMinor: 50},
        {accountId: salesId, amountMinor: -50},
      ]},
      ACTOR,
    );
    await store.ledger.updateDraft(draft.id, {description: 'still editable'}, ACTOR);
    expect(await store.ledger.deleteDraft(draft.id, ACTOR)).toBe(true);
  });

  it('the new error codes map to 409 (state conflicts, not bad requests)', () => {
    expect(ledgerErrorStatus('period-closed')).toBe(409);
    expect(ledgerErrorStatus('period-overlap')).toBe(409);
    expect(ledgerErrorStatus('period-out-of-order')).toBe(409);
    expect(ledgerErrorStatus('period-close-conflict')).toBe(409);
  });
});

describe('LGR-12 — reopen', () => {
  it('a closing entry cannot be reversed directly — reopening its period is the one void', async () => {
    const {closingEntry} = await closeQ1();
    expect(await code(store.ledger.reverse(closingEntry!.id, {date: '2026-04-01'}, ACTOR))).toBe('invalid-state');
  });

  it('reopen voids the closing entry via a real reversal, restores postability, and keeps the record', async () => {
    const closed = await closeQ1();
    const {period, reversal} = await store.ledger.reopenPeriod(closed.period.id, ACTOR);

    // The reversal pair, through the ordinary machinery.
    expect(reversal).not.toBeNull();
    expect(reversal!.reverses).toBe(closed.closingEntry!.id);
    expect(reversal!.date).toBe(closed.closingEntry!.date);
    const voided = await store.ledger.getTransaction(closed.closingEntry!.id);
    expect(voided!.state).toBe('void');
    const negated = new Map(reversal!.postings.map((p) => [p.accountId, p.amountMinor]));
    for (const leg of closed.closingEntry!.postings) {
      expect(negated.get(leg.accountId)).toBe(-leg.amountMinor);
    }
    // The flow-account balances are restored (void + posted reversal offset).
    expect(await store.ledger.accountPostedBalance(salesId)).toBe(-10_000);
    expect(await store.ledger.accountPostedBalance(retainedId)).toBe(0);

    // The record is HISTORY, not deleted — and postability is back.
    expect(period.status).toBe('reopened');
    expect(period.reopenEntryId).toBe(reversal!.id);
    expect((await store.ledger.listPeriods())[0].status).toBe('reopened');
    const again = await postEntry('2026-02-01', 1_234, salesId, 'postable again');
    expect(again.state).toBe('posted');

    // Reopening twice is a typed state error; an unknown id is not-found.
    expect(await code(store.ledger.reopenPeriod(closed.period.id, ACTOR))).toBe('invalid-state');
    expect(await code(store.ledger.reopenPeriod('nope', ACTOR))).toBe('not-found');

    // The book still verifies clean end to end.
    expect((await verifyLedger(db)).findings).toEqual([]);
  });

  it('the audit trail is complete: close and reopen events, chain intact, replay in agreement', async () => {
    const closed = await closeQ1();
    await store.ledger.reopenPeriod(closed.period.id, ACTOR);

    const events = (await store.ledger.listAudit({limit: 100})).reverse(); // ascending
    const actions = events.map((e) => e.action);
    expect(actions).toContain('period.close');
    expect(actions).toContain('period.reopen');
    // Exactly ONE event per mutation — the close carries its entry, the reopen
    // carries its reversal; neither writes a separate transaction.* event.
    expect(actions.filter((a) => a === 'transaction.reverse')).toHaveLength(0);

    expect((await store.ledger.verifyAuditChain()).ok).toBe(true);

    const replayed = replayLedgerAudit(events);
    const period = replayed.periods[closed.period.id];
    expect(period).toBeDefined();
    expect(period.status).toBe('reopened');
    // The replayed book carries the closing entry as void and its reversal.
    expect(replayed.transactions[closed.closingEntry!.id].state).toBe('void');
  });

  it('a reopened range can be closed again — a NEW record, correct balances', async () => {
    const first = await closeQ1();
    await store.ledger.reopenPeriod(first.period.id, ACTOR);
    await postEntry('2026-03-05', 2_000, salesId, 'late March sale');
    const second = await store.ledger.closePeriod({start: '2026-01-01', end: '2026-03-31'}, ACTOR);
    expect(second.period.id).not.toBe(first.period.id);
    expect(await store.ledger.accountPostedBalance(salesId)).toBe(0);
    expect(await store.ledger.accountPostedBalance(retainedId)).toBe(-8_000);
    expect(await store.ledger.listPeriods()).toHaveLength(2);
    expect((await verifyLedger(db)).findings).toEqual([]);
  });
});

describe('LGR-12 — HTTP surface (thin skins over the store)', () => {
  it('GET/POST /api/ledger/periods and /:id/reopen serve the store, typed errors mapped', async () => {
    const app = createApp(store, undefined, new PageHub());
    const headers = {'X-OpenBook-Client': '1', 'Content-Type': 'application/json'};
    await postEntry('2026-01-15', 10_000, salesId);

    const closeRes = await app.request(API.ledgerPeriods, {
      method: 'POST',
      headers,
      body: JSON.stringify({start: '2026-01-01', end: '2026-03-31'}),
    });
    expect(closeRes.status).toBe(201);
    const closed = (await closeRes.json()) as LedgerPeriodCloseResult;
    expect(closed.period.status).toBe('closed');
    expect(closed.closingEntry).not.toBeNull();

    const listRes = await app.request(API.ledgerPeriods, {headers});
    expect(listRes.status).toBe(200);
    expect(((await listRes.json()) as unknown[]).length).toBe(1);

    // A posting dated inside the closed period rejects over HTTP with the
    // typed body and the 409 the code maps to.
    const draftRes = await app.request(API.ledgerTransactions, {
      method: 'POST',
      headers,
      body: JSON.stringify({date: '2026-02-01', description: 'blocked', postings: [
        {accountId: cashId, amountMinor: 10},
        {accountId: salesId, amountMinor: -10},
      ]}),
    });
    const draft = (await draftRes.json()) as {id: string};
    const postRes = await app.request(API.ledgerTransactionPost(draft.id), {method: 'POST', headers});
    expect(postRes.status).toBe(409);
    expect(((await postRes.json()) as {code: string}).code).toBe('period-closed');

    const reopenRes = await app.request(API.ledgerPeriodReopen(closed.period.id), {method: 'POST', headers});
    expect(reopenRes.status).toBe(200);
    expect((await app.request(API.ledgerTransactionPost(draft.id), {method: 'POST', headers})).status).toBe(200);
  });
});
