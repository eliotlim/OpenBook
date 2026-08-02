/**
 * Independent invariant verifier — corruption fixtures (LGR-7).
 *
 * Builds a small fixture book THROUGH the ledger (LedgerStore is the sole
 * writer), then corrupts raw rows DIRECTLY via the Db handle — deliberately
 * bypassing every guard, exactly the out-of-band mutation the verifier exists
 * to catch — and asserts each corruption class is flagged with a precise,
 * entity-id-bearing finding:
 *
 *   flipped amount            → unbalanced
 *   orphan posting            → orphan-posting (+ unknown-account)
 *   mutated posted description→ posted-hash-mismatch
 *   deleted posting           → unbalanced (+ posted-hash-mismatch)
 *   forged / auditless row    → replay-divergence
 *   tampered audit hash       → audit-chain-broken
 *   consistent row+payload    → audit-hash-forged (re-derived digest)
 *   ERASED (NULL) audit hash  → audit-hash-forged (a null is not a pass)
 *   renumbered entry          → entry-no-gap
 *
 * A full-lifecycle clean book (post, reverse, cleared flip, account update,
 * draft edit + delete) verifies with ZERO findings — the false-positive pin.
 */

import {randomUUID} from 'node:crypto';
import {beforeEach, describe, expect, it} from 'vitest';
import {API, canonicalLedgerJson, emptyPageSnapshot, type LedgerPosting, type LedgerTransaction, type Principal} from '@book.dev/sdk';
import {PgliteDb, type Db} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {transactionContent as writerContent} from './ledger';
import {verifyLedger, transactionContent as verifierContent, type LedgerVerifyCode, type LedgerVerifyReport} from './ledgerVerify';

const ACTOR: Principal = {kind: 'user', subject: 'https://iss#tester', issuer: 'https://iss', name: 'Tester', verifiedVia: 'jws'};

let db: Db;
let store: PageStore;
let cashId: string;
let incomeId: string;
let posted: LedgerTransaction;

beforeEach(async () => {
  db = await PgliteDb.create('memory://');
  store = new PageStore(db);
  await store.migrate();
  await store.ledger.ensureSetup(ACTOR);
  const cash = await store.ledger.createAccount({name: 'Assets:Cash', type: 'asset'}, ACTOR);
  const income = await store.ledger.createAccount({name: 'Revenue:Sales', type: 'revenue'}, ACTOR);
  cashId = cash.id;
  incomeId = income.id;
  const draft = await store.ledger.createDraft(
    {
      date: '2026-08-01',
      description: 'Sale 1',
      postings: [
        {accountId: cash.id, amountMinor: 10_000},
        {accountId: income.id, amountMinor: -10_000},
      ],
    },
    ACTOR,
  );
  posted = await store.ledger.post(draft.id, ACTOR);
});

const codes = async (): Promise<LedgerVerifyCode[]> => (await verifyLedger(db)).findings.map((f) => f.code);

/** Mutate a raw page row's properties directly — the out-of-band write path. */
async function corruptProps(id: string, fn: (props: Record<string, unknown>) => void): Promise<void> {
  const rows = await db.query<{properties: Record<string, unknown> | string | null}>(
    'SELECT properties FROM pages WHERE id = $1',
    [id],
  );
  const props =
    typeof rows[0].properties === 'string'
      ? (JSON.parse(rows[0].properties) as Record<string, unknown>)
      : ((rows[0].properties ?? {}) as Record<string, unknown>);
  fn(props);
  await db.query('UPDATE pages SET properties = $2::jsonb WHERE id = $1', [id, JSON.stringify(props)]);
}

describe('LGR-7 — ledger invariant verifier vs raw corruption', () => {
  it('a clean full-lifecycle book verifies with ZERO findings', async () => {
    // Exercise every audited mutation shape so the chain/replay logic is pinned
    // against false positives: update+repost, cleared flip, reverse, account
    // rename, draft edit + delete.
    await store.ledger.setPostingCleared(posted.postings[0].id, 'cleared', {}, ACTOR);
    const d2 = await store.ledger.createDraft(
      {
        date: '2026-08-02',
        description: 'Sale 2',
        postings: [
          // A leg WITH a memo and a leg without (LGR-16): the verifier
          // recomputes the writer's content hash independently, so a memo
          // missing from one of the two projections would make this clean book
          // report as tampered-with.
          {accountId: cashId, amountMinor: 2_500, memo: 'invoice 118'},
          {accountId: incomeId, amountMinor: -2_500},
        ],
      },
      ACTOR,
    );
    await store.ledger.updateDraft(d2.id, {description: 'Sale 2 (edited)'}, ACTOR);
    const p2 = await store.ledger.post(d2.id, ACTOR);
    await store.ledger.reverse(p2.id, {}, ACTOR);
    await store.ledger.updateAccount(incomeId, {name: 'Revenue:AllSales'}, ACTOR);
    // Account CLOSE — the one audited shape with its own precondition
    // (zero posted balance), so the clean-book fixture must include it.
    const spare = await store.ledger.createAccount({name: 'Assets:Unused', type: 'asset'}, ACTOR);
    const closed = await store.ledger.updateAccount(spare.id, {status: 'closed'}, ACTOR);
    expect(closed.status).toBe('closed');
    const doomed = await store.ledger.createDraft({date: '2026-08-03', description: 'oops'}, ACTOR);
    await store.ledger.deleteDraft(doomed.id, ACTOR);

    const report = await verifyLedger(db);
    expect(report.initialized).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.checkedTransactions).toBe(3); // posted + posted-void pair… (deleted draft gone)
    expect(report.checkedAuditEvents).toBeGreaterThanOrEqual(10);
  });

  it('a NEVER-MIGRATED library reports initialized:false (no crash, no migration)', async () => {
    // The CLI can be pointed at a fresh or foreign data dir with no `settings`
    // table at all; the verifier is read-only and must report "no ledger".
    const bare = await PgliteDb.create('memory://');
    const report = await verifyLedger(bare);
    expect(report.initialized).toBe(false);
    expect(report.findings).toEqual([]);
    // Still un-migrated: verification created nothing.
    await expect(bare.query('SELECT 1 FROM settings')).rejects.toThrow();
    await bare.close();
  });

  it('an unseeded library reports initialized:false and no findings', async () => {
    const fresh = await PgliteDb.create('memory://');
    const freshStore = new PageStore(fresh);
    await freshStore.migrate();
    const report = await verifyLedger(fresh);
    expect(report.initialized).toBe(false);
    expect(report.findings).toEqual([]);
    await freshStore.close();
  });

  it('flipped amount → unbalanced (named transaction)', async () => {
    await corruptProps(posted.postings[0].id, (props) => {
      props.lp_amount_minor = -(props.lp_amount_minor as number);
    });
    const report = await verifyLedger(db);
    const unbalanced = report.findings.filter((f) => f.code === 'unbalanced');
    expect(unbalanced).toHaveLength(1);
    expect(unbalanced[0].entityId).toBe(posted.id);
    expect(unbalanced[0].message).toContain('-20000');
  });

  it('orphan posting → orphan-posting (named posting)', async () => {
    const forged = randomUUID();
    await db.query(
      `INSERT INTO pages (id, name, data, database_id, properties, position, updated_at)
       VALUES ($1, NULL, $2::jsonb, $3, $4::jsonb, 99, now())`,
      [
        forged,
        JSON.stringify(emptyPageSnapshot()),
        (await store.ledgerIds())?.postings,
        JSON.stringify({lp_transaction: randomUUID(), lp_account: randomUUID(), lp_amount_minor: 7, lp_cleared: 'pending'}),
      ],
    );
    const found = await codes();
    expect(found).toContain('orphan-posting');
    expect(found).toContain('unknown-account');
    const finding = (await verifyLedger(db)).findings.find((f) => f.code === 'orphan-posting');
    expect(finding?.entityId).toBe(forged);
  });

  it('mutated posted description → posted-hash-mismatch (named transaction)', async () => {
    await corruptProps(posted.id, (props) => {
      props.lp_description = 'Sale 1 — doctored after posting';
    });
    const report = await verifyLedger(db);
    const mismatch = report.findings.filter((f) => f.code === 'posted-hash-mismatch');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].entityId).toBe(posted.id);
    // …and nothing else fires at all: the balance and the audit rows are intact.
    expect(report.findings.map((f) => f.code)).toEqual(['posted-hash-mismatch']);
  });

  it('deleted posting → unbalanced + posted-hash-mismatch', async () => {
    await db.query('DELETE FROM pages WHERE id = $1', [posted.postings[1].id]);
    const found = await codes();
    expect(found).toContain('unbalanced');
    expect(found).toContain('posted-hash-mismatch');
  });

  it('forged raw row with no audit trail → replay-divergence', async () => {
    const forged = randomUUID();
    await db.query(
      `INSERT INTO pages (id, name, data, database_id, properties, position, updated_at)
       VALUES ($1, 'forged', $2::jsonb, $3, $4::jsonb, 98, now())`,
      [
        forged,
        JSON.stringify(emptyPageSnapshot()),
        (await store.ledgerIds())?.transactions,
        JSON.stringify({lp_date: '2026-08-09', lp_description: 'forged', lp_state: 'draft'}),
      ],
    );
    const divergence = (await verifyLedger(db)).findings.filter((f) => f.code === 'replay-divergence');
    expect(divergence.some((f) => f.entityId === forged && f.message.includes('no audit trail'))).toBe(true);
  });

  it('deleted audit events → replay-divergence (raw row without a trail)', async () => {
    // The post event's payload alone still reconstructs the row (the stream is
    // replayable by design) — erase the transaction's whole trail.
    await db.query('DELETE FROM ledger_audit WHERE action IN (\'transaction.create\', \'transaction.post\')');
    const divergence = (await verifyLedger(db)).findings.filter((f) => f.code === 'replay-divergence');
    expect(divergence.some((f) => f.entityId === posted.id && f.message.includes('no audit trail'))).toBe(true);
  });

  it('tampered audit hash → audit-chain-broken', async () => {
    // Doctor the create event's afterHash; the post event's beforeHash no
    // longer chains from it.
    await db.query('UPDATE ledger_audit SET after_hash = \'doctored\' WHERE action = \'transaction.create\'');
    const report = await verifyLedger(db);
    const broken = report.findings.filter((f) => f.code === 'audit-chain-broken');
    expect(broken).toHaveLength(1);
    expect(broken[0].entityId).toBe(posted.id);
  });

  it('CONSISTENT surgery (row + audit payload, hashes untouched) → audit-hash-forged', async () => {
    // The sophisticated attack: doctor the stored row AND the matching field in
    // every audit payload, leaving the hash columns alone. Linkage checks all
    // still pass — only re-deriving each recorded hash from its own payload
    // catches it. This is what makes the chain load-bearing.
    const doctored = 'Sale 1 — rewritten everywhere';
    await corruptProps(posted.id, (props) => {
      props.lp_description = doctored;
    });
    const auditRows = await db.query<{seq: number; payload: unknown}>(
      'SELECT seq, payload FROM ledger_audit WHERE action IN (\'transaction.create\', \'transaction.post\') ORDER BY seq ASC',
    );
    expect(auditRows).toHaveLength(2);
    for (const row of auditRows) {
      const payload = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as {
        transaction: {description: string};
      };
      payload.transaction.description = doctored;
      await db.query('UPDATE ledger_audit SET payload = $2::jsonb WHERE seq = $1', [row.seq, JSON.stringify(payload)]);
    }

    const report = await verifyLedger(db);
    const forged = report.findings.filter((f) => f.code === 'audit-hash-forged');
    expect(forged).toHaveLength(2); // both rewritten audit rows are named
    expect(forged.every((f) => f.entityId === posted.id)).toBe(true);
    // The row and the payload now agree, so replay itself does NOT diverge —
    // the recomputed digests are the only thing that catches this.
    expect(report.findings.map((f) => f.code)).not.toContain('replay-divergence');
    expect(report.findings.map((f) => f.code)).not.toContain('posted-hash-mismatch');
  });

  it('DELETING the digest is caught too — a NULL afterHash is itself the forgery', async () => {
    // The cheaper version of the attack above: run the same consistent surgery,
    // then simply NULL OUT the recorded digests instead of forging them. An
    // early `if (ev.afterHash === null) return` made the whole re-derivation
    // opt-out-able with one UPDATE, from the same raw-SQL access the covered
    // attack already needs.
    const doctored = 'Sale 1 — rewritten, digests erased';
    await corruptProps(posted.id, (props) => {
      props.lp_description = doctored;
    });
    const auditRows = await db.query<{seq: number; payload: unknown}>(
      'SELECT seq, payload FROM ledger_audit WHERE action IN (\'transaction.create\', \'transaction.post\') ORDER BY seq ASC',
    );
    for (const row of auditRows) {
      const payload = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as {
        transaction: {description: string};
      };
      payload.transaction.description = doctored;
      await db.query('UPDATE ledger_audit SET payload = $2::jsonb WHERE seq = $1', [row.seq, JSON.stringify(payload)]);
    }
    await db.query(
      'UPDATE ledger_audit SET after_hash = NULL WHERE action IN (\'transaction.create\', \'transaction.post\')',
    );

    const report = await verifyLedger(db);
    const forged = report.findings.filter((f) => f.code === 'audit-hash-forged');
    expect(forged).toHaveLength(2); // both erased rows are named, not skipped
    expect(forged.every((f) => f.entityId === posted.id)).toBe(true);
    expect(forged.every((f) => f.message.includes('afterHash NULL'))).toBe(true);
  });

  it('a non-missing-table read failure PROPAGATES (never a false "clean")', async () => {
    // A verifier that reports "clean" because its read failed is worse than one
    // that crashes: narrow the swallow to the missing-relation case only.
    const exploding = {
      query: async () => {
        throw Object.assign(new Error('permission denied for table settings'), {code: '42501'});
      },
      begin: async () => undefined,
      close: async () => undefined,
    } as unknown as Db;
    await expect(verifyLedger(exploding)).rejects.toThrow(/permission denied/);
  });

  it('renumbered entry → entry-no-gap', async () => {
    await corruptProps(posted.id, (props) => {
      props.lp_entry_no = 5;
    });
    const found = await codes();
    expect(found).toContain('entry-no-gap');
  });

  it('GET /api/ledger/verify serves the report; admin-gated once claimed', async () => {
    const app = createApp(store, undefined, new PageHub());
    const headers = {'X-OpenBook-Client': '1'};
    // Unclaimed (legacy single-user): the admin gate floors to the create gate.
    const ok = await app.request(API.ledgerVerify, {headers});
    expect(ok.status).toBe(200);
    const report = (await ok.json()) as LedgerVerifyReport;
    expect(report.initialized).toBe(true);
    expect(report.findings).toEqual([]);
    // Claimed: an anonymous guest is not the owner/admin → 403.
    await store.claimOwnership('https://account.book.pub#owner');
    expect((await app.request(API.ledgerVerify, {headers})).status).toBe(403);
  });

  it('erased entry number → entry-no-missing; duplicated → entry-no-duplicate', async () => {
    const d2 = await store.ledger.createDraft(
      {
        date: '2026-08-04',
        description: 'Sale 3',
        postings: [
          {accountId: cashId, amountMinor: 100},
          {accountId: incomeId, amountMinor: -100},
        ],
      },
      ACTOR,
    );
    const p2 = await store.ledger.post(d2.id, ACTOR);
    await corruptProps(p2.id, (props) => {
      props.lp_entry_no = 1; // duplicate of the first entry
    });
    expect(await codes()).toContain('entry-no-duplicate');
    await corruptProps(p2.id, (props) => {
      delete props.lp_entry_no;
    });
    expect(await codes()).toContain('entry-no-missing');
  });

  /**
   * The additive-field trap (LGR-16 review, security gate).
   *
   * There are THREE projections of a transaction's hashable content, not two:
   * the writer's (`ledger.ts`), the verifier's independent re-read
   * (`ledgerVerify.ts`) — and the FROZEN audit payload an OLDER BUILD wrote,
   * which `replayLedgerAudit` returns verbatim and which nothing can migrate
   * because it is inside the hash chain. A pre-LGR-16 payload has no `memo` key
   * at all; a pre-LGR-16 posting row has no `lp_memo` property. If either
   * projection EMITS `memo: null` (canonical JSON keeps nulls) the two hashes
   * differ and a perfectly clean pre-LGR-16 book reports every posted entry as
   * `posted-hash-mismatch` ("mutated outside the ledger") and every draft as
   * `replay-divergence`.
   *
   * The existing fixtures cannot catch this: they write the book with the NEW
   * code, so no frozen payload is ever memo-less. This one manufactures one.
   */
  it('a book written BEFORE the memo field existed still verifies clean (no memo ≡ no memo key)', async () => {
    // A pre-LGR-16 draft alongside the posted fixture, so both the
    // posted-hash-mismatch and the replay-divergence paths are exercised.
    const draft = await store.ledger.createDraft(
      {
        date: '2026-08-05',
        description: 'Sale 4',
        postings: [
          {accountId: cashId, amountMinor: 300},
          {accountId: incomeId, amountMinor: -300},
        ],
      },
      ACTOR,
    );
    expect(draft.postings.every((p) => p.memo === null)).toBe(true);

    // ── Rewind storage to the pre-LGR-16 shape ────────────────────────────────
    // The posting rows lose the property entirely…
    const postingRows = await db.query<{id: string}>('SELECT id FROM pages WHERE database_id = $1', [
      (await store.ledgerIds())?.postings,
    ]);
    for (const row of postingRows) {
      await corruptProps(row.id, (props) => {
        delete props.lp_memo;
      });
    }
    // …and every frozen audit payload loses the key from each posting, WITHOUT
    // touching a single hash column — exactly what an old build left behind.
    const auditRows = await db.query<{seq: number; payload: unknown}>(
      'SELECT seq, payload FROM ledger_audit ORDER BY seq ASC',
    );
    for (const row of auditRows) {
      const payload = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as {
        transaction?: {postings?: Array<Record<string, unknown>>};
      };
      if (!payload.transaction?.postings) continue;
      for (const posting of payload.transaction.postings) delete posting.memo;
      await db.query('UPDATE ledger_audit SET payload = $2::jsonb WHERE seq = $1', [row.seq, JSON.stringify(payload)]);
    }

    // The out-of-band-mutation detector must stay silent on a clean old book.
    const report = await verifyLedger(db);
    expect(report.findings).toEqual([]);
  });

  /**
   * STRUCTURAL PIN for the two in-repo projections. Field-for-field agreement is
   * currently proved only INDIRECTLY (a fixture whose every field happens to be
   * non-`undefined`), which a future field defaulting to `undefined` would slip
   * straight through: `JSON.stringify` drops it on both sides and the digests
   * still match, right up until real data fills it in. So compare the KEY SETS,
   * not only the bytes.
   */
  it('the writer and verifier content projections agree key for key (drift guard)', () => {
    // `Required<>`, which is a no-op TODAY (every `LedgerPosting` field is
    // required) and exists for tomorrow. A required addition already fails to
    // compile against this fixture; an OPTIONAL one (`tags?: string[]`) would
    // compile, both projections would omit it, key sets and digests would agree
    // — and production would diverge on the first row carrying a value. This
    // forces the fixture to populate it, which fires the literal assertions.
    const legs: Required<LedgerPosting>[] = [
      {id: 'p-1', transactionId: 'tx-1', accountId: 'a-1', amountMinor: 500, cleared: 'cleared', reconciliationId: 'r-1', memo: 'a memo'},
      {id: 'p-2', transactionId: 'tx-1', accountId: 'a-2', amountMinor: -500, cleared: 'pending', reconciliationId: null, memo: null},
    ];
    const full: LedgerTransaction = {
      id: 'tx-1',
      date: '2026-08-01',
      description: 'Everything populated',
      state: 'posted',
      postedAt: '2026-08-01T00:00:00.000Z',
      postedBy: 'https://iss#tester',
      reverses: 'tx-0',
      entryNo: 7,
      evidence: [{filename: 'invoice.pdf', sha256: 'a'.repeat(64), size: 12}],
      postings: legs,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const writer = writerContent(full);
    const verifier = verifierContent(full);

    expect(Object.keys(writer).sort()).toEqual(Object.keys(verifier).sort());
    const postingKeys = (c: Record<string, unknown>): string[][] =>
      (c.postings as Array<Record<string, unknown>>).map((p) => Object.keys(p).sort());
    expect(postingKeys(writer)).toEqual(postingKeys(verifier));

    // An EXPLICIT list, not just cross-side agreement. Comparing the two sides
    // catches a field added unconditionally to one of them — but NOT one added
    // through the `if (x != null)` idiom both docblocks tell future authors to
    // copy, because a fixture value of `null` makes both sides omit it and the
    // comparison goes green while production diverges the first time a row
    // carries a value. Pinning the literal set forces this line to be updated,
    // and the update is where the third-projection question gets asked. (The
    // type system supplies the other half: the legs are
    // `Required<LedgerPosting>`, so a new posting field — optional or not —
    // does not compile until the fixture gives it a value, at which point this
    // assertion fires.)
    expect(postingKeys(writer)[0]).toEqual(['accountId', 'amountMinor', 'cleared', 'id', 'memo', 'reconciliationId']);
    // The memo-less leg omits the key on BOTH sides — that omission IS the
    // pre-LGR-16 compatibility guarantee, so pin it here too.
    expect(postingKeys(writer)[1]).toEqual(['accountId', 'amountMinor', 'cleared', 'id', 'reconciliationId']);
    // …and the bytes the digest is taken over are identical.
    expect(canonicalLedgerJson(writer)).toBe(canonicalLedgerJson(verifier));
  });
});
