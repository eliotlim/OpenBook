/**
 * Managed-workspace roster sync (OB-199 — "bind instance ↔ workspace").
 *
 * Covers: the store-level reconcile (`syncManagedRoster` upsert / update /
 * remove), managed-vs-local coexistence (a local invite is never clobbered),
 * owner-reconcile (workspace owner ≠ site owner → admitted as admin; the site
 * owner is never demoted/locked), and the fail-safe (a fetch error keeps the
 * last-good roster). The account roster API is mocked via an injected
 * {@link RosterFetcher}.
 */

import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {Member, WorkspaceRoster} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';
import {
  RosterSyncer,
  httpRosterFetcher,
  resolveDesiredRoster,
  type RosterAssertionProvider,
  type RosterFetcher,
} from './rosterSync';
import {
  mintIdentityKeypair,
  mintSiteKeypair,
  signIdentity,
  signRosterAssertion,
  verifyRosterAssertion,
  type IdentityClaims,
  type IdentityKeypair,
  type Jwks,
} from '@book.dev/sdk';

const ISS = 'https://account.book.pub'; // the default emailAuthority
const sub = (s: string): string => `${ISS}#${s}`;

let store: PageStore;
let dir: string;
let seq = 0;

/** A controllable mock of `GET /api/workspaces/:id/members`. */
let next: WorkspaceRoster | Error;
let fetchCalls = 0;
const fetchRoster: RosterFetcher = async () => {
  fetchCalls += 1;
  if (next instanceof Error) throw next;
  return next;
};

const syncer = (over: Partial<ConstructorParameters<typeof RosterSyncer>[1]> = {}) =>
  new RosterSyncer(store, {fetchRoster, ...over});

/** Bind the instance to a workspace + pin a site owner (so reconcile has context). */
const bind = (siteOwner = sub('siteowner')) =>
  store.updateInstanceConfig({ownerSubject: siteOwner, workspaceBinding: {workspaceId: 'ws1'}});

const byEmail = (rows: Member[], email: string) => rows.find((m) => m.email === email);
const bySubject = (rows: Member[], s: string) => rows.find((m) => m.subject === s);

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-roster-sync-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  next = {workspaceId: 'ws1', members: []};
  fetchCalls = 0;
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

describe('syncNow — binding + upsert/update/remove', () => {
  it('is a no-op (null) when the instance is not bound to a workspace', async () => {
    next = {workspaceId: 'ws1', members: [{subject: sub('a'), role: 'admin'}]};
    expect(await syncer().syncNow()).toBeNull();
    expect(fetchCalls).toBe(0); // never even fetches when unbound
    expect(await store.listMembers()).toHaveLength(0);
  });

  it('inserts managed members with their roles, keyed by subject', async () => {
    await bind();
    next = {
      workspaceId: 'ws1',
      members: [
        {subject: sub('alice'), role: 'admin'},
        {subject: sub('bob'), role: 'viewer'},
      ],
    };
    const result = await syncer().syncNow();
    expect(result).toMatchObject({added: 2, updated: 0, removed: 0, skipped: 0});

    const rows = await store.listMembers();
    expect(rows).toHaveLength(2);
    expect(bySubject(rows, sub('alice'))).toMatchObject({role: 'admin', status: 'active', source: 'managed', email: null});
    expect(bySubject(rows, sub('bob'))).toMatchObject({role: 'viewer', status: 'active', source: 'managed'});
  });

  it('an email-only entry becomes an invited managed persona under the pinned authority', async () => {
    await bind();
    next = {workspaceId: 'ws1', members: [{email: 'Carol@X.test', role: 'viewer'}]};
    await syncer().syncNow();
    const row = byEmail(await store.listMembers(), 'carol@x.test');
    expect(row).toMatchObject({subject: null, status: 'invited', source: 'managed', issuer: ISS, role: 'viewer'});
  });

  it('reconciles only the ROLE on an existing managed row (idempotent otherwise)', async () => {
    await bind();
    next = {workspaceId: 'ws1', members: [{subject: sub('alice'), role: 'viewer'}]};
    await syncer().syncNow();

    next = {workspaceId: 'ws1', members: [{subject: sub('alice'), role: 'admin'}]};
    const result = await syncer().syncNow();
    expect(result).toMatchObject({added: 0, updated: 1, removed: 0});
    expect(bySubject(await store.listMembers(), sub('alice'))).toMatchObject({role: 'admin', status: 'active'});

    // A second identical sync changes nothing.
    expect(await syncer().syncNow()).toMatchObject({added: 0, updated: 0, removed: 0});
  });

  it('removes managed members dropped from the workspace', async () => {
    await bind();
    next = {
      workspaceId: 'ws1',
      members: [{subject: sub('alice'), role: 'viewer'}, {subject: sub('bob'), role: 'viewer'}],
    };
    await syncer().syncNow();

    next = {workspaceId: 'ws1', members: [{subject: sub('alice'), role: 'viewer'}]};
    const result = await syncer().syncNow();
    expect(result).toMatchObject({removed: 1});
    const rows = await store.listMembers();
    expect(rows).toHaveLength(1);
    expect(bySubject(rows, sub('alice'))).toBeTruthy();
    expect(bySubject(rows, sub('bob'))).toBeUndefined();
  });

  it('a successful EMPTY roster removes all managed rows (distinct from a fetch error)', async () => {
    await bind();
    next = {workspaceId: 'ws1', members: [{subject: sub('alice'), role: 'admin'}]};
    await syncer().syncNow();

    next = {workspaceId: 'ws1', members: []};
    const result = await syncer().syncNow();
    expect(result).toMatchObject({removed: 1});
    expect(await store.listMembers()).toHaveLength(0);
  });
});

describe('managed vs local coexistence', () => {
  it('does not clobber a local invite for the same email, and never removes a local row', async () => {
    await bind();
    // A hand-issued (local) invite — admin, status invited.
    await store.addMember({email: 'dora@x.test', role: 'admin', status: 'invited'}); // source defaults to 'local'
    // A separate local subject invite, NOT in the workspace.
    await store.addMember({subject: sub('localbob'), role: 'admin', status: 'active'});

    // The workspace lists dora as a viewer (would downgrade if it clobbered).
    next = {workspaceId: 'ws1', members: [{email: 'dora@x.test', role: 'viewer'}, {subject: sub('alice'), role: 'viewer'}]};
    const result = await syncer().syncNow();
    expect(result?.skipped).toBe(1); // dora skipped — a local row already owns the email

    const rows = await store.listMembers();
    // Exactly one row for dora, still the LOCAL admin invite (not clobbered/duplicated).
    const doras = rows.filter((m) => m.email === 'dora@x.test');
    expect(doras).toHaveLength(1);
    expect(doras[0]).toMatchObject({source: 'local', role: 'admin', status: 'invited'});
    // The unrelated local invite survives the managed sync.
    expect(bySubject(rows, sub('localbob'))).toMatchObject({source: 'local', role: 'admin'});
    // The genuinely-managed member was added.
    expect(bySubject(rows, sub('alice'))).toMatchObject({source: 'managed', role: 'viewer'});
  });

  it('a local subject invite is not clobbered by a managed entry for the same subject', async () => {
    await bind();
    await store.addMember({subject: sub('eve'), role: 'admin', status: 'active'}); // local
    next = {workspaceId: 'ws1', members: [{subject: sub('eve'), role: 'viewer'}]};
    const result = await syncer().syncNow();
    expect(result?.skipped).toBe(1);
    const eve = bySubject(await store.listMembers(), sub('eve'));
    expect(eve).toMatchObject({source: 'local', role: 'admin'}); // unchanged
    expect((await store.listMembers()).filter((m) => m.subject === sub('eve'))).toHaveLength(1);
  });
});

describe('owner reconcile (OB-198 F2)', () => {
  it('admits the workspace owner as admin even when it differs from the site owner', async () => {
    await bind(sub('siteowner'));
    next = {
      workspaceId: 'ws1',
      ownerSubject: sub('wsowner'),
      // The workspace lists its owner as a mere viewer; reconcile must force admin.
      members: [{subject: sub('wsowner'), role: 'viewer'}, {subject: sub('alice'), role: 'viewer'}],
    };
    await syncer().syncNow();
    const rows = await store.listMembers();
    expect(bySubject(rows, sub('wsowner'))).toMatchObject({role: 'admin', source: 'managed', status: 'active'});
    expect(bySubject(rows, sub('alice'))).toMatchObject({role: 'viewer'});
  });

  it('never creates or demotes a managed row for the instance\'s own site owner', async () => {
    await bind(sub('siteowner'));
    // The workspace roster lists the SITE owner as a viewer — the sync must ignore it.
    next = {
      workspaceId: 'ws1',
      ownerSubject: sub('siteowner'), // workspace owner == site owner
      members: [{subject: sub('siteowner'), role: 'viewer'}, {subject: sub('alice'), role: 'admin'}],
    };
    await syncer().syncNow();
    const rows = await store.listMembers();
    // No managed row for the site owner — they keep full access via the owner
    // short-circuit; a viewer row would be a confusing (and risky) demotion signal.
    expect(bySubject(rows, sub('siteowner'))).toBeUndefined();
    expect(bySubject(rows, sub('alice'))).toMatchObject({role: 'admin', source: 'managed'});
  });
});

describe('fail-safe on fetch error', () => {
  it('keeps the last-good roster when the fetch throws (never drops/ widens)', async () => {
    await bind();
    next = {workspaceId: 'ws1', members: [{subject: sub('alice'), role: 'admin'}]};
    const s = syncer();
    await s.syncNow();
    expect(await store.listMembers()).toHaveLength(1);

    // The account is now unreachable.
    next = new Error('account unreachable');
    await expect(s.syncNow()).rejects.toThrow('account unreachable');

    // The managed roster is intact — no drop, no widening.
    expect(bySubject(await store.listMembers(), sub('alice'))).toMatchObject({role: 'admin'});
    const status = await s.status();
    expect(status.lastError).toContain('account unreachable');
    expect(status.lastResult).toMatchObject({added: 1}); // last GOOD result retained
  });

  it('tick() swallows the error so the periodic timer keeps running', async () => {
    await bind();
    next = new Error('boom');
    await expect(syncer().tick()).resolves.toBeUndefined();
  });
});

describe('robustness (OB-199 hardening)', () => {
  it('aborts a hung fetch after fetchTimeoutMs → fail-safe (last-good kept, lastError set)', async () => {
    await bind();
    // Seed a last-good roster via the module mock fetcher.
    next = {workspaceId: 'ws1', members: [{subject: sub('alice'), role: 'admin'}]};
    await syncer().syncNow();
    expect(await store.listMembers()).toHaveLength(1);

    // A *hung* (not refused) endpoint: never resolves, only rejects when aborted.
    const hanging: RosterFetcher = (_binding, signal) =>
      new Promise((_resolve, reject) => {
        if (signal?.aborted) reject(new Error('roster fetch aborted'));
        signal?.addEventListener('abort', () => reject(new Error('roster fetch aborted')));
      });
    const s = new RosterSyncer(store, {fetchRoster: hanging, fetchTimeoutMs: 10});
    await expect(s.syncNow()).rejects.toThrow('roster fetch aborted');

    // Last-good roster intact (no drop, no widening); the abort recorded.
    expect(bySubject(await store.listMembers(), sub('alice'))).toMatchObject({role: 'admin'});
    const status = await s.status();
    expect(status.lastError).toContain('roster fetch aborted');
    expect(status.lastSyncAt).toBeNull(); // this run never reconciled
  });

  it('records a malformed-200 roster as a fetch error (status reflects; no mutation)', async () => {
    await bind();
    next = {workspaceId: 'ws1', members: [{subject: sub('alice'), role: 'admin'}]};
    await syncer().syncNow(); // seed last-good
    expect(await store.listMembers()).toHaveLength(1);

    // 200 OK but `members` is missing — must be caught in the fetcher (Sasha
    // INFO-1) so it routes through run()'s fetch try/catch and is recorded.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({workspaceId: 'ws1'}), {status: 200})) as unknown as typeof fetch;
    const s = new RosterSyncer(store, {fetchRoster: httpRosterFetcher({fetchImpl})});
    await expect(s.syncNow()).rejects.toThrow(/members/);

    // Roster intact, error recorded, no successful reconcile.
    expect(bySubject(await store.listMembers(), sub('alice'))).toMatchObject({role: 'admin'});
    const status = await s.status();
    expect(status.lastError).toMatch(/members/);
    expect(status.lastSyncAt).toBeNull();
  });

  it('a signer error keeps the last-good roster + records the failure (no widening)', async () => {
    await bind();
    next = {workspaceId: 'ws1', members: [{subject: sub('alice'), role: 'admin'}]};
    await syncer().syncNow(); // seed last-good via the module mock fetcher
    expect(await store.listMembers()).toHaveLength(1);

    // The keychain-holding signer fails (e.g. locked) → the fetcher throws BEFORE
    // any request, routing through run()'s fetch try/catch (fail-safe).
    const fetchImpl = (async () =>
      new Response(JSON.stringify({workspaceId: 'ws1', members: []}), {status: 200})) as unknown as typeof fetch;
    const assertionProvider: RosterAssertionProvider = () => {
      throw new Error('keychain locked');
    };
    const s = new RosterSyncer(store, {fetchRoster: httpRosterFetcher({fetchImpl, assertionProvider})});
    await expect(s.syncNow()).rejects.toThrow('keychain locked');

    // Last-good roster intact (never dropped, never widened); failure recorded.
    expect(bySubject(await store.listMembers(), sub('alice'))).toMatchObject({role: 'admin'});
    const status = await s.status();
    expect(status.lastError).toContain('keychain locked');
    expect(status.lastSyncAt).toBeNull();
  });

  it('records a store-reconcile failure (Quinn #2) and leaves the roster intact', async () => {
    await bind();
    next = {workspaceId: 'ws1', members: [{subject: sub('alice'), role: 'admin'}]};
    await syncer().syncNow(); // seed last-good
    expect(await store.listMembers()).toHaveLength(1);

    // The next reconcile's store write throws (a DB error; the tx would roll back).
    next = {workspaceId: 'ws1', members: [{subject: sub('bob'), role: 'admin'}]};
    store.syncManagedRoster = async () => {
      throw new Error('db write failed');
    };
    const s = syncer();
    await expect(s.syncNow()).rejects.toThrow('db write failed');

    // Roster untouched + the reconcile failure recorded (not a silent throw).
    expect(bySubject(await store.listMembers(), sub('alice'))).toMatchObject({role: 'admin'});
    const status = await s.status();
    expect(status.lastError).toContain('db write failed');
    expect(status.lastSyncAt).toBeNull();
  });

  it('trims a whitespace-padded account email so a local row still wins (Quinn #3)', async () => {
    await bind();
    // A local invite, stored normalized (lowercased, trimmed).
    await store.addMember({email: 'dora@x.test', role: 'admin', status: 'invited'});
    // The workspace lists dora with surrounding whitespace + mixed case.
    next = {workspaceId: 'ws1', members: [{email: '  Dora@X.test  ', role: 'viewer'}]};
    const result = await syncer().syncNow();
    expect(result?.skipped).toBe(1); // trimmed → matches the local email → skipped

    const doras = (await store.listMembers()).filter((m) => m.email === 'dora@x.test');
    expect(doras).toHaveLength(1);
    expect(doras[0]).toMatchObject({source: 'local', role: 'admin', status: 'invited'});
    // No stray whitespace-keyed managed row was created.
    expect(await store.listMembers()).toHaveLength(1);
  });

  it('excludes the site owner when the workspace lists them email-only (Quinn #4)', async () => {
    await bind(sub('siteowner'));
    next = {
      workspaceId: 'ws1',
      members: [
        // The owner bound (subject+email) — the email is learned from here…
        {subject: sub('siteowner'), email: 'owner@x.test', role: 'admin'},
        // …so this email-only dup must NOT mint a managed invited persona.
        {email: '  Owner@X.test  ', role: 'viewer'},
        {subject: sub('alice'), role: 'viewer'},
      ],
    };
    await syncer().syncNow();
    const rows = await store.listMembers();
    expect(rows.find((m) => m.email === 'owner@x.test')).toBeUndefined(); // no owner persona
    expect(bySubject(rows, sub('siteowner'))).toBeUndefined(); // subject excluded too
    expect(bySubject(rows, sub('alice'))).toMatchObject({role: 'viewer', source: 'managed'});
    expect(rows).toHaveLength(1); // only alice
  });
});

describe('resolveDesiredRoster (pure projection)', () => {
  const cfg = (ownerSubject?: string) => ({
    guestAccess: 'read' as const,
    trustedIssuers: [{issuer: ISS}],
    emailAuthority: ISS,
    ownerSubject,
  });

  it('dedupes by identity taking the higher role, and stamps the authority issuer', () => {
    const roster: WorkspaceRoster = {
      workspaceId: 'ws1',
      members: [
        {subject: sub('a'), role: 'viewer'},
        {subject: sub('a'), role: 'admin'}, // dup — admin wins
        {email: 'X@Y.test', role: 'viewer'},
      ],
    };
    const desired = resolveDesiredRoster(roster, cfg());
    expect(desired).toContainEqual({subject: sub('a'), email: null, issuer: ISS, role: 'admin'});
    expect(desired).toContainEqual({subject: null, email: 'x@y.test', issuer: ISS, role: 'viewer'});
    expect(desired).toHaveLength(2);
  });

  it('excludes the site owner and force-admits the workspace owner', () => {
    const roster: WorkspaceRoster = {
      workspaceId: 'ws1',
      ownerSubject: sub('wsowner'),
      members: [{subject: sub('siteowner'), role: 'admin'}, {subject: sub('wsowner'), role: 'viewer'}],
    };
    const desired = resolveDesiredRoster(roster, cfg(sub('siteowner')));
    expect(desired.find((d) => d.subject === sub('siteowner'))).toBeUndefined();
    expect(desired.find((d) => d.subject === sub('wsowner'))).toMatchObject({role: 'admin'});
  });

  it('trims + lowercases persona emails for store parity (Quinn #3)', () => {
    const roster: WorkspaceRoster = {
      workspaceId: 'ws1',
      members: [{email: '  Mixed@Case.test  ', role: 'viewer'}],
    };
    const desired = resolveDesiredRoster(roster, cfg());
    expect(desired).toContainEqual({subject: null, email: 'mixed@case.test', issuer: ISS, role: 'viewer'});
    // A whitespace-only email is dropped (no identity).
    expect(resolveDesiredRoster({workspaceId: 'ws1', members: [{email: '   ', role: 'viewer'}]}, cfg())).toEqual([]);
  });

  it('excludes the site owner listed email-only when their email is resolvable (Quinn #4)', () => {
    const roster: WorkspaceRoster = {
      workspaceId: 'ws1',
      members: [
        {subject: sub('siteowner'), email: 'owner@x.test', role: 'admin'}, // binds the owner email
        {email: '  OWNER@x.test ', role: 'viewer'}, // email-only dup of the owner
        {subject: sub('alice'), role: 'viewer'},
      ],
    };
    const desired = resolveDesiredRoster(roster, cfg(sub('siteowner')));
    expect(desired.find((d) => d.subject === sub('siteowner'))).toBeUndefined();
    expect(desired.find((d) => d.email === 'owner@x.test')).toBeUndefined();
    expect(desired).toEqual([{subject: sub('alice'), email: null, issuer: ISS, role: 'viewer'}]);
  });
});

describe('httpRosterFetcher', () => {
  const binding = {workspaceId: 'ws 1', accountBaseUrl: 'https://acct.test'};

  it('GETs the /roster endpoint and presents the assertion as a bearer', async () => {
    let seen: {url: string; auth: string | null} | null = null;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen = {url, auth: new Headers(init?.headers).get('Authorization')};
      return new Response(JSON.stringify({workspaceId: 'ws 1', members: []}), {status: 200});
    }) as unknown as typeof fetch;
    const fetcher = httpRosterFetcher({fetchImpl, assertionProvider: () => 'tok-123'});
    const roster = await fetcher(binding);
    expect(roster.members).toEqual([]);
    expect(seen!.url).toBe('https://acct.test/api/workspaces/ws%201/roster'); // workspaceId encoded
    expect(seen!.auth).toBe('Bearer tok-123');
  });

  it('passes the workspaceId to the assertion provider', async () => {
    let askedFor: string | null = null;
    const fetchImpl = (async () =>
      new Response(JSON.stringify({workspaceId: 'ws 1', members: []}), {status: 200})) as unknown as typeof fetch;
    const assertionProvider: RosterAssertionProvider = (workspaceId) => {
      askedFor = workspaceId;
      return 'tok';
    };
    await httpRosterFetcher({fetchImpl, assertionProvider})(binding);
    expect(askedFor).toBe('ws 1'); // the raw (un-encoded) bound id
  });

  it('mints a FRESH assertion per fetch (provider invoked every call)', async () => {
    let calls = 0;
    const seen: (string | null)[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('Authorization'));
      return new Response(JSON.stringify({workspaceId: 'ws 1', members: []}), {status: 200});
    }) as unknown as typeof fetch;
    const fetcher = httpRosterFetcher({fetchImpl, assertionProvider: () => `tok-${++calls}`});
    await fetcher(binding);
    await fetcher(binding);
    expect(calls).toBe(2);
    expect(seen).toEqual(['Bearer tok-1', 'Bearer tok-2']); // distinct, fresh per fetch
  });

  it('sends NO auth header when no provider is wired (today\'s inert default)', async () => {
    let auth: string | null = 'sentinel';
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      auth = new Headers(init?.headers).get('Authorization');
      return new Response(JSON.stringify({workspaceId: 'ws 1', members: []}), {status: 200});
    }) as unknown as typeof fetch;
    await httpRosterFetcher({fetchImpl})(binding);
    expect(auth).toBeNull();
  });

  it('a null assertion (no identity yet) sends no auth header', async () => {
    let auth: string | null = 'sentinel';
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      auth = new Headers(init?.headers).get('Authorization');
      return new Response(JSON.stringify({workspaceId: 'ws 1', members: []}), {status: 200});
    }) as unknown as typeof fetch;
    await httpRosterFetcher({fetchImpl, assertionProvider: () => null})(binding);
    expect(auth).toBeNull();
  });

  it('a signer that THROWS fails the fetch BEFORE any request (fail-safe, never unauthenticated)', async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response(JSON.stringify({workspaceId: 'ws 1', members: []}), {status: 200});
    }) as unknown as typeof fetch;
    const assertionProvider: RosterAssertionProvider = () => {
      throw new Error('keychain locked');
    };
    await expect(httpRosterFetcher({fetchImpl, assertionProvider})(binding)).rejects.toThrow('keychain locked');
    expect(fetched).toBe(false); // no request went out — never downgrades to unauthenticated
  });

  it('throws on a non-OK response (so the syncer keeps last-good)', async () => {
    const fetchImpl = (async () => new Response('nope', {status: 403})) as unknown as typeof fetch;
    await expect(httpRosterFetcher({fetchImpl})(binding)).rejects.toThrow('403');
  });

  it('throws on a malformed-200 body — members missing (Sasha INFO-1)', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({workspaceId: 'ws 1'}), {status: 200})) as unknown as typeof fetch;
    await expect(httpRosterFetcher({fetchImpl})(binding)).rejects.toThrow(/members/);
  });

  it('throws on a malformed-200 body — members not an array (Sasha INFO-1)', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({workspaceId: 'ws 1', members: {}}), {status: 200})) as unknown as typeof fetch;
    await expect(httpRosterFetcher({fetchImpl})(binding)).rejects.toThrow(/members/);
  });

  it('throws on a member with an invalid role (Sasha INFO-1)', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({workspaceId: 'ws 1', members: [{subject: 'x', role: 'superuser'}]}), {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(httpRosterFetcher({fetchImpl})(binding)).rejects.toThrow(/role/);
  });

  it('accepts a valid roster (subject/email/ownerSubject) and normalizes the entry shape', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          workspaceId: 'ws 1',
          ownerSubject: 'iss#owner',
          members: [{subject: 'iss#a', role: 'admin'}, {email: 'b@x.test', role: 'viewer'}],
        }),
        {status: 200},
      )) as unknown as typeof fetch;
    const roster = await httpRosterFetcher({fetchImpl})(binding);
    expect(roster.ownerSubject).toBe('iss#owner');
    expect(roster.members).toEqual([
      {subject: 'iss#a', role: 'admin'},
      {email: 'b@x.test', role: 'viewer'},
    ]);
  });
});

// ── The roster assertion (OB-199 wiring): the site-signed bearer the fetcher ───
//     presents. Signing uses a REAL site keypair (the desktop keychain layer); the
//     data-server only ever sees the opaque bearer string.
describe('signRosterAssertion / verifyRosterAssertion (SDK contract)', () => {
  const workspaceId = 'ws-xyz';
  let kp: Awaited<ReturnType<typeof mintSiteKeypair>>;

  beforeEach(async () => {
    kp = await mintSiteKeypair();
  });

  /** Decode the base64url payload half WITHOUT the verifier, to assert raw shape. */
  const decodePayload = (assertion: string): Record<string, unknown> => {
    const b64 = assertion.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  };

  it('frames the bearer as base64url(payload).base64url(sig) with the contract payload', async () => {
    const before = Date.now();
    const assertion = await signRosterAssertion({privateKey: kp.privateKey, publicKey: kp.publicKey, workspaceId});
    const after = Date.now();
    const parts = assertion.split('.');
    expect(parts).toHaveLength(2); // exactly two base64url segments
    expect(parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))).toBe(true);
    const payload = decodePayload(assertion);
    expect(payload).toMatchObject({v: 'openbook.roster.v1', pub: kp.publicKey, workspaceId});
    expect(payload.ts).toBeGreaterThanOrEqual(before); // ts stamped at sign time
    expect(payload.ts).toBeLessThanOrEqual(after);
  });

  it('round-trips: verifies against the site public key', async () => {
    const assertion = await signRosterAssertion({privateKey: kp.privateKey, publicKey: kp.publicKey, workspaceId});
    expect(await verifyRosterAssertion({assertion, publicKey: kp.publicKey, workspaceId})).toMatchObject({
      v: 'openbook.roster.v1',
      pub: kp.publicKey,
      workspaceId,
    });
  });

  it('stamps a FRESH ts per call', async () => {
    const a = await signRosterAssertion({privateKey: kp.privateKey, publicKey: kp.publicKey, workspaceId, now: () => 1_000});
    const b = await signRosterAssertion({privateKey: kp.privateKey, publicKey: kp.publicKey, workspaceId, now: () => 2_000});
    expect(decodePayload(a).ts).toBe(1_000);
    expect(decodePayload(b).ts).toBe(2_000);
    expect(a).not.toBe(b);
  });

  it('verify rejects a wrong workspace, wrong key, tampered sig, or stale ts (→ null)', async () => {
    const at = 10_000;
    const assertion = await signRosterAssertion({privateKey: kp.privateKey, publicKey: kp.publicKey, workspaceId, now: () => at});
    const other = await mintSiteKeypair();
    expect(await verifyRosterAssertion({assertion, publicKey: kp.publicKey, workspaceId: 'other-ws', now: at})).toBeNull();
    expect(await verifyRosterAssertion({assertion, publicKey: other.publicKey, workspaceId, now: at})).toBeNull();
    // Tamper the signature half (flip the first base64url char).
    const [b64, sig] = assertion.split('.');
    const tampered = `${b64}.${(sig[0] === 'A' ? 'B' : 'A')}${sig.slice(1)}`;
    expect(await verifyRosterAssertion({assertion: tampered, publicKey: kp.publicKey, workspaceId, now: at})).toBeNull();
    // Stale (outside the ±5min window) vs. fresh (inside).
    expect(await verifyRosterAssertion({assertion, publicKey: kp.publicKey, workspaceId, now: at + 6 * 60 * 1000})).toBeNull();
    expect(await verifyRosterAssertion({assertion, publicKey: kp.publicKey, workspaceId, now: at})).not.toBeNull();
  });

  it('a real signed assertion flows through httpRosterFetcher and verifies (end-to-end)', async () => {
    let bearer: string | null = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bearer = new Headers(init?.headers).get('Authorization')?.replace(/^Bearer /, '') ?? null;
      return new Response(JSON.stringify({workspaceId, members: []}), {status: 200});
    }) as unknown as typeof fetch;
    const assertionProvider: RosterAssertionProvider = (ws) =>
      signRosterAssertion({privateKey: kp.privateKey, publicKey: kp.publicKey, workspaceId: ws});
    await httpRosterFetcher({fetchImpl, assertionProvider})({workspaceId, accountBaseUrl: 'https://acct.test'});
    expect(bearer).not.toBeNull();
    expect(await verifyRosterAssertion({assertion: bearer!, publicKey: kp.publicKey, workspaceId})).toMatchObject({workspaceId});
  });
});

// ── On-demand route + gating (the /api/workspace/sync surface) ─────────────────

describe('POST /api/workspace/sync route', () => {
  let kp: IdentityKeypair;
  let jwks: Jwks;

  const idFor = (s: string, over: Partial<IdentityClaims> = {}): Promise<string> =>
    signIdentity(
      kp.privateKey,
      {iss: ISS, sub: s, name: s, iat: Math.floor(Date.now() / 1000) - 30, exp: Math.floor(Date.now() / 1000) + 3600, jti: `jti-${s}-${Math.random()}`, ...over},
      kp.publicJwk.kid,
    );

  beforeEach(async () => {
    kp = await mintIdentityKeypair('k1');
    jwks = {keys: [kp.publicJwk]};
    await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], ownerSubject: sub('owner')});
    await store.updateInstanceConfig({workspaceBinding: {workspaceId: 'ws1'}});
    await store.addMember({subject: sub('admin'), role: 'admin', status: 'active'});
    await store.addMember({subject: sub('viewer'), role: 'viewer', status: 'active'});
  });

  const app = () =>
    createApp(store, undefined, new PageHub(), {identity: new IdentityService(store), roster: syncer()});

  const post = (a: ReturnType<typeof app>, jws?: string) =>
    a.request('/api/workspace/sync', {method: 'POST', headers: jws ? {[IDENTITY_HEADER]: jws} : {}});

  it('an admin triggers an on-demand reconcile; a viewer/guest is forbidden', async () => {
    next = {workspaceId: 'ws1', members: [{subject: sub('zara'), role: 'viewer'}]};
    const res = await post(app(), await idFor('admin'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({added: 1});
    expect(bySubject(await store.listMembers(), sub('zara'))).toMatchObject({source: 'managed'});

    expect((await post(app(), await idFor('viewer'))).status).toBe(403);
    expect((await post(app())).status).toBe(403); // anonymous guest
  });

  it('surfaces a fetch failure as 502 without dropping the roster', async () => {
    await store.addMember({subject: sub('kept'), role: 'viewer', status: 'active', source: 'managed'});
    next = new Error('upstream down');
    const res = await post(app(), await idFor('admin'));
    expect(res.status).toBe(502);
    expect(bySubject(await store.listMembers(), sub('kept'))).toBeTruthy(); // intact
  });
});
