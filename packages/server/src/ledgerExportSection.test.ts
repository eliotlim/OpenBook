/**
 * LX-2 — the site export's embedded ledger records, captured against a REAL
 * store through the exporting principal's own read paths.
 *
 * What a passing suite means:
 *  - GOLDEN: a book seeded by the SDK's own "Startup books" template exports a
 *    COMPLETE section — account/transaction/posting row counts match the
 *    server's ledger store exactly, the settings mirror the stored `ledgerDb`
 *    ids verbatim, and the audit anchor is the true chain head (recomputed
 *    hash-for-hash against the newest event).
 *  - AUTHZ (no escalation through export): on a claimed instance, a stranger's
 *    capture yields NOTHING — not an error, not a partial book — because every
 *    read runs through their own client and the server answers with its
 *    existence-hiding no-ledger body. A viewer holding read grants on the five
 *    ledger HOST pages (but not the rows — row pages don't inherit host ACLs,
 *    OB-207) trips the completeness check and ALSO gets nothing, rather than a
 *    silently row-less "book". Export mints no capability either way.
 */
import {describe, expect, it} from 'vitest';
import {
  API,
  HttpDataClient,
  PAGE_TEMPLATES,
  gatherLedgerExportSection,
  ledgerAuditEventHash,
  mintIdentityKeypair,
  signIdentity,
  type DataClient,
  type IdentityKeypair,
  type StoredPage,
} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {LocalDataClient} from './localClient';
import {IdentityService} from './instanceConfig';

const ISS = 'https://account.book.pub';

async function freshStore(): Promise<PageStore> {
  const store = new PageStore(await PgliteDb.create('memory://'));
  await store.migrate();
  return store;
}

/** Seed the fixture book through the SDK's own Startup Books template creator. */
async function seedStartupBooks(client: DataClient): Promise<StoredPage> {
  const template = PAGE_TEMPLATES.find((t) => t.id === 'startup-books')!;
  return template.create(client, 'Startup books');
}

const rowsOf = (section: NonNullable<Awaited<ReturnType<typeof gatherLedgerExportSection>>>, dbId: string) =>
  section.library.pages.filter((p) => p.databaseId === dbId);

describe('LX-2 — gatherLedgerExportSection against a real store (owner, local transport)', () => {
  it('captures the complete books: count parity, stored ids verbatim, true chain head', async () => {
    const store = await freshStore();
    const client = new LocalDataClient(store, new PageHub());
    await seedStartupBooks(client);

    const section = await gatherLedgerExportSection(client);
    expect(section).not.toBeNull();
    const s = section!;

    // The settings mirror the STORED seeded ids exactly (the `ledgerDb` row).
    const ids = (await store.ledgerIds())!;
    expect(s.settings.ledgerDb).toEqual(ids);
    // No periods were closed, so the key is simply absent (matches the stored
    // settings surface: the row does not exist until the first close).
    expect(s.settings.ledgerPeriods).toBeUndefined();

    // All four managed databases travel with their schema…
    expect(s.library.databases.map((d) => d.id).sort()).toEqual(
      [ids.accounts, ids.transactions, ids.postings, ids.reconciliations].sort(),
    );
    // …and all five host pages are present.
    for (const hostId of [ids.hostPageId, ...Object.values(ids.hostPages)]) {
      expect(s.library.pages.some((p) => p.id === hostId)).toBe(true);
    }

    // COUNT PARITY with the server's ledger store, entity by entity.
    const accounts = await store.ledger.listAccounts();
    const transactions = await store.ledger.listTransactions();
    const postings = transactions.reduce((n, t) => n + t.postings.length, 0);
    expect(accounts.length).toBeGreaterThan(0); // the template really seeded
    expect(transactions.length).toBeGreaterThan(0);
    expect(rowsOf(s, ids.accounts)).toHaveLength(accounts.length);
    expect(rowsOf(s, ids.transactions)).toHaveLength(transactions.length);
    expect(rowsOf(s, ids.postings)).toHaveLength(postings);
    expect(rowsOf(s, ids.reconciliations)).toHaveLength(0);
    // Nothing beyond hosts + rows rides along.
    expect(s.library.pages).toHaveLength(5 + accounts.length + transactions.length + postings);

    // The audit anchor is the REAL chain head: same seq, same recomputed hash.
    const [head] = await store.ledger.listAudit({limit: 1});
    expect(s.auditHead).toEqual({seq: head.seq, hash: await ledgerAuditEventHash(head)});

    await store.close();
  });

  it('returns null on a library with no seeded ledger', async () => {
    const store = await freshStore();
    const client = new LocalDataClient(store, new PageHub());
    expect(await gatherLedgerExportSection(client)).toBeNull();
    await store.close();
  });
});

describe('LX-2 — authz: capture through a principal-bound HTTP client', () => {
  /** Claimed instance (guests off) with the ledger seeded pre-claim, plus
   *  identity-bound HttpDataClients running over the in-process app. */
  async function claimedWorld() {
    const store = await freshStore();
    const kp: IdentityKeypair = await mintIdentityKeypair('k1');
    const app = createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});
    // Seed while unclaimed (legacy guest = full access), then claim.
    await app.request(API.ledger, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'}});
    const localSeed = new LocalDataClient(store, new PageHub());
    await seedStartupBooks(localSeed);
    await store.updateInstanceConfig({
      trustedIssuers: [{issuer: ISS, jwks: {keys: [kp.publicJwk]}}],
      ownerSubject: `${ISS}#owner`,
      guestAccess: 'off',
    });
    const clientFor = async (sub: string): Promise<DataClient> => {
      const jws = await signIdentity(
        kp.privateKey,
        {iss: ISS, sub, name: sub, exp: Math.floor(Date.now() / 1000) + 3600, jti: `j-${sub}`},
        'k1',
      );
      const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => Promise.resolve(app.request(input, init));
      return new HttpDataClient('', undefined, {fetchImpl, getIdentity: () => ({jws})});
    };
    return {store, clientFor};
  }

  it('a stranger gets NO section — and no error (existence-hiding all the way down)', async () => {
    const {store, clientFor} = await claimedWorld();
    const stranger = await clientFor('stranger');
    expect(await gatherLedgerExportSection(stranger)).toBeNull();
    await store.close();
  });

  it('the owner gets the full section over HTTP (transport parity with local)', async () => {
    const {store, clientFor} = await claimedWorld();
    const owner = await clientFor('owner');
    const section = await gatherLedgerExportSection(owner);
    expect(section).not.toBeNull();
    const ids = (await store.ledgerIds())!;
    const accounts = await store.ledger.listAccounts();
    expect(rowsOf(section!, ids.accounts)).toHaveLength(accounts.length);
    expect(section!.auditHead).not.toBeNull();
    await store.close();
  });

  it('a viewer with HOST-page grants only (rows read-filtered) trips the completeness check: no partial book', async () => {
    // Row pages do not inherit an ACL grant on the host pages (ancestor
    // inheritance is OB-207): this viewer passes the typed API's host gate but
    // the generic row reads silently filter every row. Without the tripwire the
    // export would embed all four schemas with ZERO rows — a silently
    // incomplete book. Fail-closed is the contract: no section at all.
    const {store, clientFor} = await claimedWorld();
    await store.addMember({subject: `${ISS}#viewer`, email: null, role: 'viewer', status: 'active'});
    const ids = (await store.ledgerIds())!;
    for (const hostId of [ids.hostPageId, ...Object.values(ids.hostPages)]) {
      await store.setPageAcl(hostId, {subject: `${ISS}#viewer`, email: null, level: 'read'});
    }
    const viewer = await clientFor('viewer');
    expect(await gatherLedgerExportSection(viewer)).toBeNull();
    await store.close();
  });
});
