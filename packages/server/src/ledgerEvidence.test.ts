/**
 * Evidence integrity (LGR-14) — the manifest, the gate, and the drift detector.
 *
 * Three suites:
 *  1. STORE — attach/detach on drafts (wholesale replacement, sizes resolved
 *     from the content-addressed asset store), the post-time snapshot, manifest
 *     immutability with the posted entry, and the evidence-required post gate
 *     (with its reversal / period-close exemptions).
 *  2. LIFECYCLE — the asset-deletion question: an attached receipt is
 *     structurally un-reapable (asset_refs on the tx row + the manifest hash in
 *     the row's properties both hold the GC off), and a deleted draft releases
 *     its refs again.
 *  3. VERIFIER — `checkEvidenceManifests`: a receipt replaced or removed by
 *     direct SQL — every ledger row and hash untouched — is flagged on the next
 *     run. The replace test is the LGR-22 mutation check for this task: with
 *     the verifier's evidence section deleted, THAT test fails and (aside from
 *     its sibling fixtures here) nothing else does, because the swap is
 *     invisible to every other check by construction.
 */

import {beforeEach, describe, expect, it} from 'vitest';
import {LedgerError, canonicalLedgerJson, type LedgerAccount, type LedgerTransaction, type Principal} from '@book.dev/sdk';
import {PgliteDb, type Db} from './db';
import {PageStore} from './store';
import {accountContent as writerAccountContent} from './ledger';
import {verifyLedger, accountContent as verifierAccountContent, type LedgerVerifyReport} from './ledgerVerify';

const ACTOR: Principal = {kind: 'user', subject: 'https://iss#tester', issuer: 'https://iss', name: 'Tester', verifiedVia: 'jws'};

let db: Db;
let store: PageStore;
let cashId: string;
let incomeId: string;

/** Deterministic fake receipt bytes. */
const receipt = (seed: string): Uint8Array => new TextEncoder().encode(`%PDF-1.4 receipt ${seed}`);

/** Upload bytes into the content-addressed store; returns the sha256 id. */
async function upload(seed: string): Promise<string> {
  const {id} = await store.putAsset(receipt(seed), 'application/octet-stream');
  return id;
}

async function balancedDraft(evidence?: Array<{sha256: string; filename: string}>): Promise<LedgerTransaction> {
  return store.ledger.createDraft(
    {
      date: '2026-08-01',
      description: 'Sale',
      postings: [
        {accountId: cashId, amountMinor: 10_000},
        {accountId: incomeId, amountMinor: -10_000},
      ],
      ...(evidence ? {evidence} : {}),
    },
    ACTOR,
  );
}

const findingCodes = (report: LedgerVerifyReport): string[] => report.findings.map((f) => f.code);

beforeEach(async () => {
  db = await PgliteDb.create('memory://');
  store = new PageStore(db);
  await store.migrate();
  await store.ledger.ensureSetup(ACTOR);
  const cash = await store.ledger.createAccount({name: 'Assets:Cash', type: 'asset'}, ACTOR);
  const income = await store.ledger.createAccount({name: 'Revenue:Sales', type: 'revenue'}, ACTOR);
  cashId = cash.id;
  incomeId = income.id;
});

describe('LGR-14 — evidence manifest on drafts and at post', () => {
  it('attach at create: sizes come from the asset store, never the client', async () => {
    const sha = await upload('a');
    const draft = await balancedDraft([{sha256: sha, filename: 'receipt-a.pdf'}]);
    expect(draft.evidence).toEqual([{filename: 'receipt-a.pdf', sha256: sha, size: receipt('a').byteLength}]);
  });

  it('updateDraft replaces the manifest wholesale; [] detaches everything', async () => {
    const shaA = await upload('a');
    const shaB = await upload('b');
    const draft = await balancedDraft([{sha256: shaA, filename: 'a.pdf'}]);
    const swapped = await store.ledger.updateDraft(draft.id, {evidence: [{sha256: shaB, filename: 'b.pdf'}]}, ACTOR);
    expect(swapped.evidence.map((e) => e.sha256)).toEqual([shaB]);
    const cleared = await store.ledger.updateDraft(draft.id, {evidence: []}, ACTOR);
    expect(cleared.evidence).toEqual([]);
    // And the row's stored property is gone entirely — the one-representation
    // rule that keeps an emptied draft byte-identical to a never-attached one.
    const rows = await db.query<{properties: Record<string, unknown> | string}>('SELECT properties FROM pages WHERE id = $1', [draft.id]);
    const props = typeof rows[0].properties === 'string' ? JSON.parse(rows[0].properties) as Record<string, unknown> : rows[0].properties;
    expect('lp_evidence' in props).toBe(false);
  });

  it('rejects a malformed hash, a duplicate, an unknown asset, and an oversize filename — each typed', async () => {
    const sha = await upload('a');
    await expect(balancedDraft([{sha256: 'nothex', filename: 'x.pdf'}])).rejects.toMatchObject({code: 'invalid-input'});
    await expect(balancedDraft([{sha256: sha, filename: ''}])).rejects.toMatchObject({code: 'invalid-input'});
    await expect(balancedDraft([{sha256: sha, filename: 'x'.repeat(256)}])).rejects.toMatchObject({code: 'invalid-input'});
    await expect(
      balancedDraft([
        {sha256: sha, filename: 'x.pdf'},
        {sha256: sha, filename: 'again.pdf'},
      ]),
    ).rejects.toMatchObject({code: 'invalid-input'});
    // Well-formed hash, no such bytes: upload first is the named fix.
    await expect(balancedDraft([{sha256: 'a'.repeat(64), filename: 'ghost.pdf'}])).rejects.toMatchObject({code: 'not-found'});
    // A rejected create writes NOTHING — no orphan row, no audit event.
    expect(await store.ledger.listTransactions()).toEqual([]);
  });

  it('post snapshots the manifest and freezes it with the entry (store-level immutability)', async () => {
    const sha = await upload('a');
    const draft = await balancedDraft([{sha256: sha, filename: 'receipt-a.pdf'}]);
    const posted = await store.ledger.post(draft.id, ACTOR);
    expect(posted.evidence).toEqual([{filename: 'receipt-a.pdf', sha256: sha, size: receipt('a').byteLength}]);

    // The read path agrees with the write path.
    const reread = await store.ledger.getTransaction(posted.id);
    expect(reread?.evidence).toEqual(posted.evidence);

    // IMMUTABLE with the posted transaction: the only evidence writer is the
    // draft-patch surface, and it refuses a posted entry outright.
    await expect(store.ledger.updateDraft(posted.id, {evidence: []}, ACTOR)).rejects.toMatchObject({code: 'immutable'});

    // And the audit trail froze the same manifest into the post event payload.
    const events = await store.ledger.listAudit();
    const post = events.find((ev) => ev.action === 'transaction.post');
    expect((post?.payload as {transaction: LedgerTransaction}).transaction.evidence).toEqual(posted.evidence);
  });

  it('a posted entry with NO evidence still posts on ordinary accounts (badge case, not a blocker)', async () => {
    const draft = await balancedDraft();
    const posted = await store.ledger.post(draft.id, ACTOR);
    expect(posted.evidence).toEqual([]);
  });
});

describe('LGR-14 — the evidence-required account gate', () => {
  it('createAccount stores the toggle; false is the ABSENT key (one representation)', async () => {
    const strict = await store.ledger.createAccount({name: 'Expenses:Travel', type: 'expense', evidenceRequired: true}, ACTOR);
    expect(strict.evidenceRequired).toBe(true);
    expect((await store.ledger.getAccount(cashId))?.evidenceRequired).toBe(false);

    const off = await store.ledger.updateAccount(strict.id, {evidenceRequired: false}, ACTOR);
    expect(off.evidenceRequired).toBe(false);
    const rows = await db.query<{properties: Record<string, unknown> | string}>('SELECT properties FROM pages WHERE id = $1', [strict.id]);
    const props = typeof rows[0].properties === 'string' ? JSON.parse(rows[0].properties) as Record<string, unknown> : rows[0].properties;
    expect('lp_evidence_required' in props).toBe(false);
  });

  it('blocks the post with a typed rejection naming the account and the fix; evidence unblocks it', async () => {
    await store.ledger.updateAccount(cashId, {evidenceRequired: true}, ACTOR);
    const draft = await balancedDraft();
    const refusal = await store.ledger.post(draft.id, ACTOR).then(
      () => null,
      (err: unknown) => err,
    );
    expect(refusal).toBeInstanceOf(LedgerError);
    expect((refusal as LedgerError).code).toBe('evidence-required');
    expect((refusal as LedgerError).message).toContain('Assets:Cash');
    expect((refusal as LedgerError).message).toContain('attach');
    // Server-side negative: NOTHING was posted.
    expect((await store.ledger.getTransaction(draft.id))?.state).toBe('draft');

    const sha = await upload('a');
    await store.ledger.updateDraft(draft.id, {evidence: [{sha256: sha, filename: 'receipt.pdf'}]}, ACTOR);
    const posted = await store.ledger.post(draft.id, ACTOR);
    expect(posted.state).toBe('posted');
  });

  it('a reversal CARRIES its original\'s manifest (F1) and needs no fresh receipt on a required account', async () => {
    await store.ledger.updateAccount(cashId, {evidenceRequired: true}, ACTOR);
    const sha = await upload('a');
    const draft = await balancedDraft([{sha256: sha, filename: 'receipt.pdf'}]);
    const posted = await store.ledger.post(draft.id, ACTOR);
    const reversal = await store.ledger.reverse(posted.id, {}, ACTOR);
    expect(reversal.state).toBe('posted');
    // Carried verbatim — sizes included — not re-attested.
    expect(reversal.evidence).toEqual(posted.evidence);
    // The carried manifest refs the asset to the REVERSAL row too, so the
    // receipt's read gate and GC protection follow it.
    expect((await store.pagesReferencingAsset(sha)).sort()).toEqual([posted.id, reversal.id].sort());
    // Frozen-payload parity on a reversal-with-manifest event: the clean
    // verify below re-derives the transaction.reverse afterHash from its own
    // payload AND replays it against the raw rows — an asymmetry between the
    // writer's and verifier's projection of a carried manifest fails here.
    const report = await verifyLedger(db);
    expect(report.findings).toEqual([]);
  });

  it('reversals of BARE entries stay exempt: no receipt is conjured, and the gate does not block the undo', async () => {
    const draft = await balancedDraft();
    const posted = await store.ledger.post(draft.id, ACTOR);
    // The requirement arrives AFTER the fact — the reversal must still work,
    // or a policy change would freeze every pre-policy mistake in place.
    await store.ledger.updateAccount(cashId, {evidenceRequired: true}, ACTOR);
    const reversal = await store.ledger.reverse(posted.id, {}, ACTOR);
    expect(reversal.state).toBe('posted');
    expect(reversal.evidence).toEqual([]);
  });

  it('double reversal cannot launder evidence off a live entry (the F1 hole, closed)', async () => {
    // Before F1: reverse E, reverse the reversal — the live book ends with
    // exactly E's legs and an EMPTY manifest, badge clean, CSV clean,
    // verifier clean, no SQL touched. With carry-forward the manifest follows
    // the chain: R2 (the live re-enactment of E) answers with E's receipts.
    await store.ledger.updateAccount(cashId, {evidenceRequired: true}, ACTOR);
    const sha = await upload('a');
    const posted = await store.ledger.post((await balancedDraft([{sha256: sha, filename: 'receipt.pdf'}])).id, ACTOR);
    const r1 = await store.ledger.reverse(posted.id, {}, ACTOR);
    const r2 = await store.ledger.reverse(r1.id, {}, ACTOR);
    expect(r2.state).toBe('posted');
    expect(r2.evidence).toEqual(posted.evidence);
    // And the whole chain — evidenced original, two carrying reversals, a
    // required account — verifies clean, with no policy advisory: every entry
    // in the chain can answer for itself.
    const report = await verifyLedger(db);
    expect(report.findings).toEqual([]);
    expect(report.checkedEvidence).toBe(3);
  });

  it('names multiple required accounts with plural agreement', async () => {
    await store.ledger.updateAccount(cashId, {evidenceRequired: true}, ACTOR);
    await store.ledger.updateAccount(incomeId, {evidenceRequired: true}, ACTOR);
    const refusal = await store.ledger.post((await balancedDraft()).id, ACTOR).then(
      () => null,
      (err: unknown) => err,
    );
    expect((refusal as LedgerError).code).toBe('evidence-required');
    expect((refusal as LedgerError).message).toMatch(/accounts .* require evidence/);
    expect((refusal as LedgerError).message).toContain('Assets:Cash');
    expect((refusal as LedgerError).message).toContain('Revenue:Sales');
  });

  it('rejects control and BIDI-formatting characters in a filename with a typed error (F3)', async () => {
    const sha = await upload('a');
    // A NUL previously escaped to Postgres as a raw 22P05 → untyped 500.
    await expect(balancedDraft([{sha256: sha, filename: 'bad\u0000name.pdf'}])).rejects.toMatchObject({code: 'invalid-input'});
    // An RLO would reorder the verifier report's line about this very file.
    await expect(balancedDraft([{sha256: sha, filename: 'receipt\u202Efdp.exe'}])).rejects.toMatchObject({code: 'invalid-input'});
    await expect(balancedDraft([{sha256: sha, filename: 'zero\u200Bwidth.pdf'}])).rejects.toMatchObject({code: 'invalid-input'});
    // Q2: the full importModel UNSAFE_TEXT set — ALM (a genuine Bidi_Control)
    // and the U+E0000-E007F tag block (invisible instruction smuggling; this
    // ledger is MCP-readable, so a filename is an agent-facing channel).
    await expect(balancedDraft([{sha256: sha, filename: 'alm\u061Cname.pdf'}])).rejects.toMatchObject({code: 'invalid-input'});
    await expect(balancedDraft([{sha256: sha, filename: 'tag\u{E0041}block.pdf'}])).rejects.toMatchObject({code: 'invalid-input'});
    await expect(balancedDraft([{sha256: sha, filename: 'mongolian\u180Esep.pdf'}])).rejects.toMatchObject({code: 'invalid-input'});
    expect(await store.ledger.listTransactions()).toEqual([]);
  });

  it('a pre-planted wrong size column cannot be frozen into the manifest (F4)', async () => {
    const sha = await upload('a');
    // Doctor the CACHED size cell before attach — the one moment a manifest
    // could have been born lying, flagging an untampered book forever.
    await db.query('UPDATE assets SET size = 999999 WHERE id = $1', [sha]);
    const posted = await store.ledger.post((await balancedDraft([{sha256: sha, filename: 'receipt.pdf'}])).id, ACTOR);
    // The manifest measured the BYTES, not the cell.
    expect(posted.evidence[0].size).toBe(receipt('a').byteLength);
    const report = await verifyLedger(db);
    expect(report.findings).toEqual([]);
  });

  it('period close is exempt: a closing entry sweeping an evidence-required flow account still posts', async () => {
    await store.ledger.updateAccount(incomeId, {evidenceRequired: true}, ACTOR);
    await store.ledger.createAccount({name: 'Equity:RetainedEarnings', type: 'equity'}, ACTOR);
    const sha = await upload('a');
    const draft = await balancedDraft([{sha256: sha, filename: 'receipt.pdf'}]);
    await store.ledger.post(draft.id, ACTOR);
    const closed = await store.ledger.closePeriod({start: '2026-08-01', end: '2026-08-31'}, ACTOR);
    expect(closed.closingEntry).not.toBeNull();
    expect(closed.closingEntry?.evidence).toEqual([]);
  });
});

describe('LGR-14 — evidence asset lifecycle (the deletable-receipt question)', () => {
  it('an attached receipt survives the asset GC; a detached one is reapable again', async () => {
    const sha = await upload('a');
    const draft = await balancedDraft([{sha256: sha, filename: 'receipt.pdf'}]);
    // The attach ref'd the asset to the tx row page.
    expect(await store.pagesReferencingAsset(sha)).toEqual([draft.id]);

    // Grace of zero: everything unprotected is eligible immediately.
    const gc1 = await store.gcUnreferencedAssets({graceMs: 0});
    expect(gc1.ids).not.toContain(sha);
    expect(await store.getAsset(sha)).not.toBeNull();

    // Post freezes the manifest; still protected (ref + properties scan).
    const posted = await store.ledger.post(draft.id, ACTOR);
    const gc2 = await store.gcUnreferencedAssets({graceMs: 0});
    expect(gc2.ids).not.toContain(sha);
    expect(posted.evidence[0].sha256).toBe(sha);
  });

  it('deleting a draft releases its evidence refs (cascade), and the GC may then reap', async () => {
    const sha = await upload('b');
    const draft = await balancedDraft([{sha256: sha, filename: 'receipt.pdf'}]);
    await store.ledger.deleteDraft(draft.id, ACTOR);
    expect(await store.pagesReferencingAsset(sha)).toEqual([]);
    const gc = await store.gcUnreferencedAssets({graceMs: 0});
    expect(gc.ids).toContain(sha);
  });

  it('posting refuses when an attached asset vanished out-of-band (no manifest the store cannot honour)', async () => {
    const sha = await upload('c');
    const draft = await balancedDraft([{sha256: sha, filename: 'receipt.pdf'}]);
    // Out-of-band removal (no API deletes assets; direct SQL only).
    await db.query('DELETE FROM assets WHERE id = $1', [sha]);
    await expect(store.ledger.post(draft.id, ACTOR)).rejects.toMatchObject({code: 'invalid-state'});
    expect((await store.ledger.getTransaction(draft.id))?.state).toBe('draft');
  });
});

describe('LGR-14 — verifier: manifest drift against the asset store', () => {
  /** A posted entry with one receipt attached; returns {txId, sha}. */
  async function postedWithReceipt(seed: string): Promise<{txId: string; sha: string}> {
    const sha = await upload(seed);
    const draft = await balancedDraft([{sha256: sha, filename: `receipt-${seed}.pdf`}]);
    const posted = await store.ledger.post(draft.id, ACTOR);
    return {txId: posted.id, sha};
  }

  it('a clean book WITH evidence verifies with zero findings — and provably checked it', async () => {
    await postedWithReceipt('a');
    const report = await verifyLedger(db);
    expect(report.findings).toEqual([]);
    // The green-on-nothing guard: zero here means the section stopped running,
    // and this expectation is what fails first if it ever does.
    expect(report.checkedEvidence).toBe(1);
  });

  it('REPLACING the receipt bytes after posting is detected on the next run (the tamper test)', async () => {
    // The receipt swap: same asset row, new bytes — every ledger row, every
    // audit payload and every hash column left EXACTLY as the honest post wrote
    // them. Replay agrees with itself, the chain links, the content hashes
    // match; re-hashing the stored bytes against the manifest is the only
    // detector standing. MUTATION-CHECKED: with `checkEvidenceManifests` (or
    // its call) deleted, this test fails and no non-LGR-14 test does.
    const {txId, sha} = await postedWithReceipt('a');
    const forged = receipt('FORGED — same file id, different contents');
    await db.query('UPDATE assets SET bytes = $2, size = $3 WHERE id = $1', [sha, Buffer.from(forged), forged.byteLength]);

    const report = await verifyLedger(db);
    const codes = findingCodes(report);
    expect(codes).toContain('evidence-asset-replaced');
    expect(codes).not.toContain('posted-hash-mismatch'); // proves no other check even looks
    expect(codes).not.toContain('replay-divergence');
    const finding = report.findings.find((f) => f.code === 'evidence-asset-replaced');
    expect(finding?.entityId).toBe(txId);
    expect(finding?.message).toContain('receipt-a.pdf');
  });

  it('REMOVING the receipt after posting is detected on the next run', async () => {
    const {txId, sha} = await postedWithReceipt('a');
    // Direct SQL — the refs and the properties scan hold the GC off, so this is
    // the only way the row can go.
    await db.query('DELETE FROM asset_refs WHERE asset_id = $1', [sha]);
    await db.query('DELETE FROM assets WHERE id = $1', [sha]);

    const report = await verifyLedger(db);
    expect(findingCodes(report)).toContain('evidence-asset-missing');
    const finding = report.findings.find((f) => f.code === 'evidence-asset-missing');
    expect(finding?.entityId).toBe(txId);
    expect(finding?.message).toContain('removed after posting');
  });

  it('a doctored manifest is named precisely, not only as a generic hash mismatch', async () => {
    const {txId} = await postedWithReceipt('a');
    const rows = await db.query<{properties: Record<string, unknown> | string}>('SELECT properties FROM pages WHERE id = $1', [txId]);
    const props = typeof rows[0].properties === 'string' ? JSON.parse(rows[0].properties) as Record<string, unknown> : rows[0].properties;
    (props.lp_evidence as Array<{size: number}>)[0].size = 999_999;
    await db.query('UPDATE pages SET properties = $2::jsonb WHERE id = $1', [txId, JSON.stringify(props)]);

    const report = await verifyLedger(db);
    const codes = findingCodes(report);
    // The generic out-of-band detector fires (the manifest is audited content)…
    expect(codes).toContain('posted-hash-mismatch');
    // …AND the evidence check says specifically what about it is now a lie.
    expect(codes).toContain('evidence-size-mismatch');
  });

  it('a malformed manifest item is flagged, never skipped', async () => {
    const {txId} = await postedWithReceipt('a');
    const rows = await db.query<{properties: Record<string, unknown> | string}>('SELECT properties FROM pages WHERE id = $1', [txId]);
    const props = typeof rows[0].properties === 'string' ? JSON.parse(rows[0].properties) as Record<string, unknown> : rows[0].properties;
    props.lp_evidence = [{garbage: true}];
    await db.query('UPDATE pages SET properties = $2::jsonb WHERE id = $1', [txId, JSON.stringify(props)]);

    const report = await verifyLedger(db);
    expect(findingCodes(report)).toContain('evidence-manifest-invalid');
  });

  it('the traceless flag flip is caught: SQL-off, post bare, SQL-on → policy advisory, nothing else (F2)', async () => {
    // Sasha's exact choreography — the feature's one bypass that left NO
    // trace: the flag is turned on through the API (audited), SQL'd OFF the
    // raw row, a bare entry posts through the ordinary API (the gate reads
    // the row and waves it through), and the flag is SQL'd back ON. The row
    // again matches its audit trail, so every tamper check is clean by
    // construction — the CURRENT-POLICY advisory is the only detector.
    // MUTATION-CHECKED: with the advisory check deleted, this test (and the
    // history test below) fail and nothing else does.
    await store.ledger.updateAccount(cashId, {evidenceRequired: true}, ACTOR);
    const flip = async (on: boolean): Promise<void> => {
      const rows = await db.query<{properties: Record<string, unknown> | string}>('SELECT properties FROM pages WHERE id = $1', [cashId]);
      const props = typeof rows[0].properties === 'string' ? JSON.parse(rows[0].properties) as Record<string, unknown> : rows[0].properties;
      if (on) props.lp_evidence_required = true;
      else delete props.lp_evidence_required;
      await db.query('UPDATE pages SET properties = $2::jsonb WHERE id = $1', [cashId, JSON.stringify(props)]);
    };
    await flip(false);
    const posted = await store.ledger.post((await balancedDraft()).id, ACTOR); // the gate reads the doctored row
    await flip(true);

    const report = await verifyLedger(db);
    expect(findingCodes(report)).toEqual(['evidence-required-missing']);
    const finding = report.findings[0];
    expect(finding.entityId).toBe(posted.id);
    expect(finding.message).toContain('policy advisory');
    expect(finding.message).toContain('Assets:Cash');
    // `checkedEvidence` counts manifest ITEMS — zero here, which is exactly
    // why the advisory cannot hide behind the green-on-nothing guard.
    expect(report.checkedEvidence).toBe(0);
  });

  it('turning the flag on flags bare HISTORY — by design, and said so in the message', async () => {
    // No SQL at all: an honestly bare entry posted while the account was
    // ordinary, then the requirement arrives. The advisory answers "which
    // posted entries cannot satisfy TODAY'S policy" — pre-policy history is
    // part of that answer, and the message says it is not tamper evidence.
    const posted = await store.ledger.post((await balancedDraft()).id, ACTOR);
    await store.ledger.updateAccount(cashId, {evidenceRequired: true}, ACTOR);
    const report = await verifyLedger(db);
    expect(findingCodes(report)).toEqual(['evidence-required-missing']);
    expect(report.findings[0].entityId).toBe(posted.id);
    expect(report.findings[0].message).toContain('before the requirement was turned on');
  });

  it('the advisory carves out closing entries and reversal chains — bare-legacy pairs flag only the ORIGINAL', async () => {
    // A bare legacy entry, reversed after the requirement arrived (the exempt
    // undo): the advisory names the VOID original — the entry that could not
    // answer — and not the reversal, whose bareness the carve-out shields
    // because the policy claim belongs to the entry it undoes.
    const posted = await store.ledger.post((await balancedDraft()).id, ACTOR);
    await store.ledger.updateAccount(cashId, {evidenceRequired: true}, ACTOR);
    const reversal = await store.ledger.reverse(posted.id, {}, ACTOR);
    // And a REAL closing entry over a required flow account: the requirement
    // arrives, an evidenced sale gives the income account a balance, and the
    // close sweeps it — the closing entry is BARE and touches the required
    // account, so without its carve-out it would flag here.
    await store.ledger.updateAccount(incomeId, {evidenceRequired: true}, ACTOR);
    const sha = await upload('a');
    await store.ledger.post((await balancedDraft([{sha256: sha, filename: 'receipt.pdf'}])).id, ACTOR);
    await store.ledger.createAccount({name: 'Equity:RetainedEarnings', type: 'equity'}, ACTOR);
    const closed = await store.ledger.closePeriod({start: '2026-08-01', end: '2026-08-31'}, ACTOR);
    expect(closed.closingEntry).not.toBeNull(); // the carve-out is actually exercised

    const report = await verifyLedger(db);
    const advisories = report.findings.filter((f) => f.code === 'evidence-required-missing');
    expect(advisories.map((f) => f.entityId)).toEqual([posted.id]);
    expect(advisories.map((f) => f.entityId)).not.toContain(reversal.id);
    expect(advisories.map((f) => f.entityId)).not.toContain(closed.closingEntry!.id);
    expect(findingCodes(report).filter((c) => c !== 'evidence-required-missing')).toEqual([]);
  });
});

describe('LGR-14 — frozen-payload parity for the account projection', () => {
  it('writer and verifier account projections agree key for key, evidenceRequired populated', () => {
    const full: LedgerAccount = {
      id: 'a-1',
      name: 'Expenses:Travel',
      type: 'expense',
      status: 'open',
      currency: 'USD',
      evidenceRequired: true,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const writer = writerAccountContent(full);
    const verifier = verifierAccountContent(full);
    expect(Object.keys(writer).sort()).toEqual(Object.keys(verifier).sort());
    expect(Object.keys(writer).sort()).toEqual(['currency', 'evidenceRequired', 'id', 'name', 'status', 'type']);
    expect(canonicalLedgerJson(writer)).toBe(canonicalLedgerJson(verifier));
  });

  it('a pre-LGR-14 frozen payload (no evidenceRequired key) hashes identically to a toggled-off row', () => {
    // The LGR-16/LGR-12 discipline applied to accounts: `false` must be
    // byte-identical to ABSENT in the hashable content, on both sides, or every
    // account written before LGR-14 reports as diverged on a healthy book.
    const oldPayloadAccount = {
      id: 'a-1',
      name: 'Assets:Cash',
      type: 'asset',
      status: 'open',
      currency: 'USD',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    } as unknown as LedgerAccount;
    const newRow: LedgerAccount = {...oldPayloadAccount, evidenceRequired: false};
    for (const project of [writerAccountContent, verifierAccountContent]) {
      expect(canonicalLedgerJson(project(oldPayloadAccount))).toBe(canonicalLedgerJson(project(newRow)));
      expect('evidenceRequired' in project(newRow)).toBe(false);
    }
  });
});
