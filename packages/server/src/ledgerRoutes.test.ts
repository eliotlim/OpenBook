/**
 * Ledger HTTP surface + transport parity (LGR-3).
 *
 * Pins:
 *  - the generic page/row/database mutation routes answer 403 `{code:'managed'}`
 *    for ledger rows (the store guards surface through onError) while ledger
 *    reads stay open;
 *  - the ledger routes enforce the invariants with `{error, code}` bodies and
 *    the right statuses (400 validation / 403 immutable-managed-locked /
 *    404 missing / 409 state);
 *  - route ↔ client ↔ localClient PARITY: the same scenario driven through
 *    `HttpDataClient` (over `app.request`) and `LocalDataClient` (no HTTP at
 *    all) produces identical results AND identical typed `LedgerError`s.
 */

import {describe, expect, it, beforeEach} from 'vitest';
import {
  API,
  HttpDataClient,
  LedgerError,
  mintIdentityKeypair,
  signIdentity,
  type DataClient,
  type IdentityKeypair,
  type Jwks,
} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {LocalDataClient} from './localClient';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';
import {agentScopeAllows} from './agentTokens';

const JSON_HEADERS = {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'};

/** A fresh unclaimed app (legacy guest = full access) over an in-memory store. */
async function freshApp(): Promise<{store: PageStore; app: ReturnType<typeof createApp>}> {
  const db = await PgliteDb.create('memory://');
  const store = new PageStore(db);
  await store.migrate();
  const app = createApp(store, undefined, new PageHub());
  return {store, app};
}

const req = (app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('LGR-3 — generic mutation routes answer 403 managed on ledger rows', () => {
  let app: ReturnType<typeof createApp>;
  let dbs: Record<string, string>;
  let postedId: string;
  let postingId: string;

  beforeEach(async () => {
    ({app} = await freshApp());
    const init = await req(app, 'POST', API.ledger);
    // Always 200 — a 201-vs-200 split would leak whether books already existed.
    expect(init.status).toBe(200);
    dbs = ((await init.json()) as {databases: Record<string, string>}).databases;
    const cash = await (await req(app, 'POST', API.ledgerAccounts, {name: 'Assets:Cash', type: 'asset'})).json();
    const income = await (await req(app, 'POST', API.ledgerAccounts, {name: 'Revenue', type: 'revenue'})).json();
    const draft = await (
      await req(app, 'POST', API.ledgerTransactions, {
        date: '2026-08-01',
        description: 'Sale',
        postings: [
          {accountId: cash.id, amountMinor: 100},
          {accountId: income.id, amountMinor: -100},
        ],
      })
    ).json();
    const posted = await (await req(app, 'POST', API.ledgerTransactionPost(draft.id))).json();
    postedId = posted.id;
    postingId = posted.postings[0].id;
  });

  const expectManaged = async (res: Response): Promise<void> => {
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('managed');
  };

  it('PATCH /api/databases/:id/rows/:rowId → 403 managed', async () => {
    await expectManaged(await req(app, 'PATCH', API.databaseRow(dbs.postings, postingId), {properties: {lp_amount_minor: 1}}));
  });

  it('POST /api/databases/:id/rows → 403 managed', async () => {
    await expectManaged(await req(app, 'POST', API.databaseRows(dbs.transactions), {name: 'forged'}));
  });

  it('page routes (PUT/PATCH/DELETE/properties) on a ledger row → 403 managed', async () => {
    await expectManaged(await req(app, 'PUT', API.page(postedId), {name: 'clobbered', data: {editorjs: {blocks: []}, values: [], names: []}}));
    await expectManaged(await req(app, 'PATCH', API.page(postedId), {name: 'renamed'}));
    await expectManaged(await req(app, 'PATCH', API.pageProperties(postedId), {properties: {lp_state: 'draft'}}));
    await expectManaged(await req(app, 'DELETE', API.page(postedId)));
  });

  it('database schema/delete + rows order routes → 403 managed', async () => {
    await expectManaged(await req(app, 'PATCH', API.database(dbs.postings), {name: 'tampered'}));
    await expectManaged(await req(app, 'DELETE', API.database(dbs.transactions)));
    await expectManaged(await req(app, 'PUT', API.databaseRowsOrder(dbs.postings), {orderedIds: [postingId]}));
  });

  it('trash purge route on a ledger row → 403 managed; reads stay open', async () => {
    await expectManaged(await req(app, 'DELETE', API.trashItem(postedId)));
    // Reads are untouched: rows list + transaction fetch both work.
    expect((await req(app, 'GET', API.databaseRows(dbs.transactions))).status).toBe(200);
    const tx = await (await req(app, 'GET', API.ledgerTransaction(postedId))).json();
    expect(tx.state).toBe('posted');
  });

  it('ledger drafts are also fenced from the generic surface', async () => {
    const draft = await (await req(app, 'POST', API.ledgerTransactions, {date: '2026-08-02'})).json();
    await expectManaged(await req(app, 'DELETE', API.page(draft.id)));
    // …while the ledger DELETE route allows it (invariant 3).
    expect((await req(app, 'DELETE', API.ledgerTransaction(draft.id))).status).toBe(204);
  });

  it('surfaces ledger statuses: 404 unseeded, 400 invalid, 409 state, 403 immutable', async () => {
    const {app: bare} = await freshApp();
    expect((await req(bare, 'GET', API.ledgerAccounts)).status).toBe(404);
    const bad = await req(app, 'POST', API.ledgerAccounts, {name: 'A::B', type: 'asset'});
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('invalid-input');
    const repost = await req(app, 'POST', API.ledgerTransactionPost(postedId));
    expect(repost.status).toBe(409);
    expect((await repost.json()).code).toBe('invalid-state');
    const edit = await req(app, 'PATCH', API.ledgerTransaction(postedId), {description: 'nope'});
    expect(edit.status).toBe(403);
    expect((await edit.json()).code).toBe('immutable');
  });

  it('audit log reads paginated over HTTP; no mutation route exists for it', async () => {
    const all = await (await req(app, 'GET', `${API.ledgerAudit}?limit=100`)).json();
    expect(all.length).toBeGreaterThanOrEqual(4); // init + 2 accounts + create + post
    const page1 = await (await req(app, 'GET', `${API.ledgerAudit}?limit=2`)).json();
    expect(page1).toHaveLength(2);
    const page2 = await (await req(app, 'GET', `${API.ledgerAudit}?limit=2&before=${page1[1].seq}`)).json();
    expect(page2[0].seq).toBeLessThan(page1[1].seq);
    // The audit surface is GET-only: every mutating verb 404s (no route).
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await req(app, method, API.ledgerAudit, {})).status).toBe(404);
    }
  });
});

// ── Transport parity: HttpDataClient (over app.request) vs LocalDataClient ────

type ClientFactory = () => Promise<{client: DataClient}>;

const factories: Array<[string, ClientFactory]> = [
  [
    'HttpDataClient (HTTP routes)',
    async () => {
      const {app} = await freshApp();
      const client = new HttpDataClient('', undefined, {
        fetchImpl: async (input, init) => app.request(input, init),
      });
      return {client};
    },
  ],
  [
    'LocalDataClient (in-process, no HTTP)',
    async () => {
      const db = await PgliteDb.create('memory://');
      const store = new PageStore(db);
      await store.migrate();
      return {client: new LocalDataClient(store)};
    },
  ],
];

describe.each(factories)('LGR-3 — transport parity via %s', (_name, factory) => {
  let client: DataClient;

  beforeEach(async () => {
    ({client} = await factory());
  });

  const ledgerCode = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return 'NO-ERROR';
    } catch (err) {
      if (err instanceof LedgerError) return err.code;
      throw err;
    }
  };

  it('runs the full ledger lifecycle with identical results and typed errors', async () => {
    // Unseeded → typed not-initialized over BOTH transports.
    expect(await ledgerCode(client.ledgerListAccounts())).toBe('not-initialized');

    const info = await client.ledgerInit();
    expect(info.exists).toBe(true);
    expect((await client.ledgerInit()).hostPageId).toBe(info.hostPageId); // idempotent

    const cash = await client.ledgerCreateAccount({name: 'Assets:Bank:Checking', type: 'asset'});
    const income = await client.ledgerCreateAccount({name: 'Revenue:Sales', type: 'revenue'});
    expect(cash.currency).toBe('USD');
    expect(await client.ledgerGetAccount(cash.id)).toEqual(cash);
    expect(await client.ledgerGetAccount('00000000-0000-4000-8000-000000000000')).toBeNull();

    // Draft lifecycle.
    const draft = await client.ledgerCreateDraft({
      date: '2026-08-01',
      description: 'Invoice 1',
      postings: [
        {accountId: cash.id, amountMinor: 12_345},
        {accountId: income.id, amountMinor: -12_345},
      ],
    });
    expect(draft.state).toBe('draft');
    const edited = await client.ledgerUpdateDraft(draft.id, {description: 'Invoice 1 (edited)'});
    expect(edited.description).toBe('Invoice 1 (edited)');

    // Invariant rejections carry the SAME typed code on both transports.
    const bad = await client.ledgerCreateDraft({
      date: '2026-08-01',
      postings: [
        {accountId: cash.id, amountMinor: 100},
        {accountId: income.id, amountMinor: -50},
      ],
    });
    expect(await ledgerCode(client.ledgerPostTransaction(bad.id))).toBe('unbalanced');
    expect(await ledgerCode(client.ledgerCreateDraft({date: 'nope'}))).toBe('invalid-input');
    expect(
      await ledgerCode(
        client.ledgerCreateDraft({date: '2026-08-01', postings: [{accountId: cash.id, amountMinor: 1.5}]}),
      ),
    ).toBe('invalid-amount');

    // Post → reverse → audit.
    const posted = await client.ledgerPostTransaction(draft.id);
    expect(posted.state).toBe('posted');
    expect(posted.entryNo).toBe(1);
    expect(await ledgerCode(client.ledgerUpdateDraft(posted.id, {description: 'nope'}))).toBe('immutable');
    expect(await ledgerCode(client.ledgerDeleteDraft(posted.id))).toBe('immutable');
    expect(await ledgerCode(client.ledgerUpdateAccount(cash.id, {status: 'closed'}))).toBe('nonzero-balance');

    const cleared = await client.ledgerSetPostingCleared(posted.postings[0].id, 'cleared');
    expect(cleared.cleared).toBe('cleared');
    expect(await ledgerCode(client.ledgerSetPostingCleared(posted.postings[0].id, 'reconciled'))).toBe('reconciled-locked');

    const reversal = await client.ledgerReverseTransaction(posted.id);
    expect(reversal.reverses).toBe(posted.id);
    expect(reversal.entryNo).toBe(2);
    expect((await client.ledgerGetTransaction(posted.id))?.state).toBe('void');

    const listed = await client.ledgerListTransactions({state: 'posted'});
    expect(listed.map((t) => t.id)).toEqual([reversal.id]);

    // Account closes cleanly once the reversal zeroes the balance.
    expect((await client.ledgerUpdateAccount(cash.id, {status: 'closed'})).status).toBe('closed');

    // Audit: exactly one event per mutation, newest first, seq-paginated.
    const audit = await client.ledgerListAudit({limit: 100});
    const actions = audit.map((e) => e.action).reverse();
    expect(actions).toEqual([
      'ledger.init',
      'account.create',
      'account.create',
      'transaction.create',
      'transaction.update',
      'transaction.create', // the unbalanced draft records its CREATION…
      'transaction.post', // …but failed posts / rejected inputs record nothing
      'posting.cleared',
      'transaction.reverse',
      'account.update',
    ]);
    const page = await client.ledgerListAudit({limit: 3, before: audit[0].seq});
    expect(page.map((e) => e.seq)).toEqual(audit.slice(1, 4).map((e) => e.seq));
  });

  it('keeps the generic client surface fenced off ledger rows (managed)', async () => {
    await client.ledgerInit();
    const cash = await client.ledgerCreateAccount({name: 'Assets:Cash', type: 'asset'});
    const income = await client.ledgerCreateAccount({name: 'Revenue', type: 'revenue'});
    const draft = await client.ledgerCreateDraft({
      date: '2026-08-01',
      postings: [
        {accountId: cash.id, amountMinor: 10},
        {accountId: income.id, amountMinor: -10},
      ],
    });
    const posted = await client.ledgerPostTransaction(draft.id);
    const info = await client.ledgerInfo();
    const dbs = info.databases!;
    // The DataClient generic mutation surface — both transports reject alike.
    await expect(client.updateRow(dbs.postings, posted.postings[0].id, {properties: {lp_amount_minor: 1}})).rejects.toThrow(
      /managed|ledger/i,
    );
    await expect(client.createRow(dbs.transactions, {name: 'forged'})).rejects.toThrow(/managed|ledger/i);
    await expect(client.renamePage(posted.id, 'clobbered')).rejects.toThrow(/managed|ledger/i);
    await expect(client.deletePage(posted.id)).rejects.toThrow(/managed|ledger/i);
    await expect(client.deleteDatabase(dbs.transactions)).rejects.toThrow(/managed|ledger/i);
    await expect(client.updateDatabase(dbs.postings, {name: 'tampered'})).rejects.toThrow(/managed|ledger/i);
    // Reads still work.
    expect((await client.listRows(dbs.transactions)).length).toBeGreaterThan(0);
    expect((await client.ledgerGetTransaction(posted.id))?.postings[0].amountMinor).toBe(10);
  });
});

// ── Access posture: PAT denial, roster roles, existence hiding ────────────────

describe('LGR-3 — agent PATs can never reach the ledger surface', () => {
  // The AGENT-6 scope-gate is a default-deny PATH allowlist. Nothing under
  // `/api/ledger` is listed, so a PAT is refused today — this pins it so a
  // future allowlist entry (or a careless prefix widening) can't silently grant
  // an unattended agent the power to post, reverse, or read the books.
  const LEDGER_PATHS = [
    API.ledger,
    API.ledgerAccounts,
    API.ledgerAccount('a'),
    API.ledgerTransactions,
    API.ledgerTransaction('t'),
    API.ledgerTransactionPost('t'),
    API.ledgerTransactionReverse('t'),
    API.ledgerPostingCleared('p'),
    API.ledgerAudit,
  ];

  it('denies every ledger path for both read and write scopes', () => {
    for (const path of LEDGER_PATHS) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(agentScopeAllows('read', method, path), `read ${method} ${path}`).toBe(false);
        expect(agentScopeAllows('write', method, path), `write ${method} ${path}`).toBe(false);
      }
    }
  });
});

describe('LGR-3 — ledger access rides the restricted host pages', () => {
  const ISS = 'https://account.book.pub';
  let store: PageStore;
  let app: ReturnType<typeof createApp>;
  let kp: IdentityKeypair;
  let jwks: Jwks;

  const idFor = (sub: string): Promise<string> =>
    signIdentity(
      kp.privateKey,
      {
        iss: ISS,
        sub,
        name: sub,
        iat: Math.floor(Date.now() / 1000) - 30,
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: `jti-${sub}-${Math.random()}`,
      },
      kp.publicJwk.kid,
    );

  const asUser = (method: string, path: string, jws: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {...JSON_HEADERS, [IDENTITY_HEADER]: jws},
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeEach(async () => {
    const db = await PgliteDb.create('memory://');
    store = new PageStore(db);
    await store.migrate();
    kp = await mintIdentityKeypair();
    jwks = {keys: [kp.publicJwk]};
    app = createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});
    // Seed the ledger while still unclaimed (guest = full access), then claim.
    await req(app, 'POST', API.ledger);
    await store.updateInstanceConfig({
      trustedIssuers: [{issuer: ISS, jwks}],
      ownerSubject: `${ISS}#owner`,
      guestAccess: 'off',
    });
  });

  it('the owner may read and write the ledger', async () => {
    const owner = await idFor('owner');
    expect((await asUser('GET', API.ledgerAccounts, owner)).status).toBe(200);
    const created = await asUser('POST', API.ledgerAccounts, owner, {name: 'Assets:Cash', type: 'asset'});
    expect(created.status).toBe(201);
  });

  it('a read-only member reads but cannot write (403)', async () => {
    const owner = await idFor('owner');
    await asUser('POST', API.ledgerAccounts, owner, {name: 'Assets:Cash', type: 'asset'});
    // A `viewer` roster row with read ACL on every ledger host: reads, never writes.
    await store.addMember({subject: `${ISS}#viewer`, email: null, role: 'viewer', status: 'active'});
    const ids = (await store.ledgerIds())!;
    for (const hostId of [ids.hostPageId, ...Object.values(ids.hostPages)]) {
      await store.setPageAcl(hostId, {subject: `${ISS}#viewer`, email: null, level: 'read'});
    }
    const viewer = await idFor('viewer');
    expect((await asUser('GET', API.ledgerAccounts, viewer)).status).toBe(200);
    const write = await asUser('POST', API.ledgerAccounts, viewer, {name: 'Assets:Sneaky', type: 'asset'});
    expect(write.status).toBe(403);
  });

  it('a non-reader gets 404 on ledger routes and a no-ledger body on GET /api/ledger', async () => {
    const stranger = await idFor('stranger');
    // Route-level: existence-hiding 404, never a 403 that confirms the books.
    expect((await asUser('GET', API.ledgerAccounts, stranger)).status).toBe(404);
    expect((await asUser('GET', API.ledgerTransactions, stranger)).status).toBe(404);
    expect((await asUser('POST', API.ledgerTransactions, stranger, {date: '2026-08-01'})).status).toBe(404);
    // The discovery route answers EXACTLY as an unseeded library does, so a
    // stranger can't tell whether this library keeps books at all.
    const probe = await asUser('GET', API.ledger, stranger);
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({exists: false, hostPageId: null, databases: null});

    const {app: bare} = await freshApp();
    const unseeded = await req(bare, 'GET', API.ledger);
    expect(await unseeded.json()).toEqual({exists: false, hostPageId: null, databases: null});
  });

  it('POST /api/ledger is idempotent, 200, and read-gated on the already-seeded branch', async () => {
    // A re-POST returns the ids only to a caller who can READ the ledger, via
    // the same existence-hiding branch the GET uses.
    //
    // NOTE that branch is DEFENCE IN DEPTH, not a reachable leak today: every
    // role that clears `requireCreate` (owner / admin / loopback owner, or any
    // guest on an unclaimed write-open instance) also passes the read gate on a
    // restricted page, so there is currently no principal that reaches the
    // handler and gets the hidden body. It exists so that a future role which
    // can create but not read the ledger cannot be handed its map. What IS
    // pinned here: the status never varies with existence (the original oracle),
    // and a reader's re-POST is a non-duplicating no-op.
    const owner = await idFor('owner');
    const first = await asUser('POST', API.ledger, owner);
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.exists).toBe(true);
    expect(body.databases).not.toBeNull();

    const second = await asUser('POST', API.ledger, owner);
    expect(second.status).toBe(200); // identical status whether or not it existed
    expect(await second.json()).toEqual(body); // no second ledger seeded
  });
});
