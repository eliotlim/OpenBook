import {describe, expect, it} from 'vitest';
import {
  authorize,
  isEmailAuthoritative,
  type AccessCtx,
  type AccessPage,
  type AclEntry,
  type EffectiveVisibility,
  type InstanceConfig,
  type Principal,
  type Role,
} from '@book.dev/sdk';

// The §1 truth table is exercised here as a pure unit suite — `authorize()` has
// no I/O, so the roster role, the resolved (post-`inherit`) visibility, and the
// email-authority gate are all constructed directly per case.

const ISS = 'https://issuer.test';
const OWNER = `${ISS}#owner`;
const FEDERATED = 'https://federated.test'; // a trusted issuer that is NOT the email-authority

type Cfg = Pick<InstanceConfig, 'guestAccess' | 'ownerSubject' | 'defaultVisibility' | 'emailAuthority'>;
const cfg = (over: Partial<Cfg> = {}): Cfg => ({
  guestAccess: 'read',
  ownerSubject: OWNER,
  defaultVisibility: 'members',
  emailAuthority: ISS,
  ...over,
});

// ── Principal classes ────────────────────────────────────────────────────────
const ownerP: Principal = {kind: 'user', subject: OWNER, issuer: ISS, name: 'Owner', verifiedVia: 'jws'};
const jws = (sub: string, email?: string, issuer = ISS): Principal => ({
  kind: 'user',
  subject: `${issuer}#${sub}`,
  issuer,
  name: sub,
  ...(email ? {email} : {}),
  verifiedVia: 'jws',
});
const localP: Principal = {kind: 'user', subject: 'local:owner', issuer: 'local', name: 'Local', verifiedVia: 'local'};
const guestP: Principal = {kind: 'guest', subject: 'guest:bob', issuer: '', name: 'bob', verifiedVia: 'guest'};
const anonP: Principal = {kind: 'guest', subject: 'guest:anonymous', issuer: '', name: '', verifiedVia: 'guest'};

const SCOPES: EffectiveVisibility[] = ['public', 'authenticated', 'members', 'restricted'];

function ctx(
  principal: Principal,
  opts: {role?: Role | null; scope: EffectiveVisibility; config?: Cfg} = {scope: 'restricted'},
): AccessCtx {
  const config = opts.config ?? cfg();
  return {
    config,
    role: opts.role ?? null,
    effectiveVisibility: opts.scope,
    emailIsAuthoritative: isEmailAuthoritative(principal, config),
  };
}

const page = (acl: AclEntry[] = []): AccessPage => ({visibility: 'restricted', acl});

/** Read a class's read-per-scope as a `public/authenticated/members/restricted` map. */
function readRow(
  principal: Principal,
  opts: {role?: Role | null; config?: Cfg; acl?: AclEntry[]} = {},
): Record<EffectiveVisibility, boolean> {
  const out = {} as Record<EffectiveVisibility, boolean>;
  for (const scope of SCOPES) {
    out[scope] = authorize(principal, page(opts.acl), ctx(principal, {role: opts.role, scope, config: opts.config})).canRead;
  }
  return out;
}

describe('authorize — READ truth table (claimed instance)', () => {
  it('loopback owner (local) reads every scope', () => {
    expect(readRow(localP)).toEqual({public: true, authenticated: true, members: true, restricted: true});
  });

  it('owner (jws, subject==ownerSubject) reads every scope', () => {
    expect(readRow(ownerP)).toEqual({public: true, authenticated: true, members: true, restricted: true});
  });

  it('admin (active roster) reads every scope', () => {
    expect(readRow(jws('a'), {role: 'admin'})).toEqual({
      public: true,
      authenticated: true,
      members: true,
      restricted: true,
    });
  });

  it('viewer (active roster) reads all but restricted (restricted needs an ACL)', () => {
    expect(readRow(jws('v'), {role: 'viewer'})).toEqual({
      public: true,
      authenticated: true,
      members: true,
      restricted: false,
    });
  });

  it('active member reads the members scope (non-null role)', () => {
    expect(readRow(jws('m'), {role: 'viewer'}).members).toBe(true);
  });

  it('granted-via-ACL-only reads members + restricted via the matching entry', () => {
    const acl: AclEntry[] = [{subject: jws('x').subject, level: 'read'}];
    expect(readRow(jws('x'), {role: null, acl})).toEqual({
      public: true,
      authenticated: true,
      members: true,
      restricted: true,
    });
  });

  it('jws non-member reads public + authenticated only (no ACL ⇒ no members/restricted)', () => {
    expect(readRow(jws('n'), {role: null})).toEqual({
      public: true,
      authenticated: true,
      members: false,
      restricted: false,
    });
  });

  it('invited/suspended persona (signed-in jws, dormant row ⇒ role null) reads like a jws non-member', () => {
    // Footnote ³: a signed-in but not-yet-active persona is still a jws user, so
    // it reads `authenticated` via rule 5 — but gets nothing from the dormant row.
    expect(readRow(jws('inv'), {role: null})).toEqual({
      public: true,
      authenticated: true,
      members: false,
      restricted: false,
    });
  });

  it('guest reads public only (guestAccess=read)', () => {
    expect(readRow(guestP)).toEqual({public: true, authenticated: false, members: false, restricted: false});
  });

  it('anonymous reads public only (guestAccess=read)', () => {
    expect(readRow(anonP)).toEqual({public: true, authenticated: false, members: false, restricted: false});
  });
});

describe('authorize — WRITE truth table (claimed instance, scope-independent)', () => {
  const writeAll = (principal: Principal, opts: {role?: Role | null; acl?: AclEntry[]} = {}) =>
    SCOPES.map((scope) => authorize(principal, page(opts.acl), ctx(principal, {role: opts.role, scope})).canWrite);

  it('loopback owner / owner / admin write every scope', () => {
    expect(writeAll(localP)).toEqual([true, true, true, true]);
    expect(writeAll(ownerP)).toEqual([true, true, true, true]);
    expect(writeAll(jws('a'), {role: 'admin'})).toEqual([true, true, true, true]);
  });

  it('viewer never writes (locked read-only)', () => {
    expect(writeAll(jws('v'), {role: 'viewer'})).toEqual([false, false, false, false]);
  });

  it('jws non-member / guest / anonymous never write', () => {
    expect(writeAll(jws('n'))).toEqual([false, false, false, false]);
    expect(writeAll(guestP)).toEqual([false, false, false, false]);
    expect(writeAll(anonP)).toEqual([false, false, false, false]);
  });

  it('an ACL write grant writes (and reads), reason acl-write', () => {
    const p = jws('w');
    const d = authorize(p, page([{subject: p.subject, level: 'write'}]), ctx(p, {scope: 'restricted'}));
    expect(d).toEqual({canRead: true, canWrite: true, reason: 'acl-write'});
  });
});

describe('authorize — reasons per ladder rung', () => {
  it('rule 1 local-owner', () => {
    expect(authorize(localP, page(), ctx(localP, {scope: 'restricted'})).reason).toBe('local-owner');
  });
  it('rule 2 owner', () => {
    expect(authorize(ownerP, page(), ctx(ownerP, {scope: 'restricted'})).reason).toBe('owner');
  });
  it('rule 3 acl-read (read granted, write falls through)', () => {
    const p = jws('r');
    const d = authorize(p, page([{subject: p.subject, level: 'read'}]), ctx(p, {scope: 'restricted'}));
    expect(d).toEqual({canRead: true, canWrite: false, reason: 'acl-read'});
  });
  it('rule 4 admin', () => {
    expect(authorize(jws('a'), page(), ctx(jws('a'), {role: 'admin', scope: 'restricted'})).reason).toBe('admin');
  });
  it('rule 4 viewer-readonly when a viewer can read', () => {
    expect(authorize(jws('v'), page(), ctx(jws('v'), {role: 'viewer', scope: 'members'})).reason).toBe(
      'viewer-readonly',
    );
  });
  it('rule 5 visibility-scope for a jws non-member reading authenticated', () => {
    expect(authorize(jws('n'), page(), ctx(jws('n'), {scope: 'authenticated'})).reason).toBe('visibility-scope');
  });
  it('rule 7 no-grant for a jws non-member on restricted', () => {
    expect(authorize(jws('n'), page(), ctx(jws('n'), {scope: 'restricted'})).reason).toBe('no-grant');
  });
});

describe('authorize — guest gate floor (rule 6)', () => {
  const off = cfg({guestAccess: 'off'});
  it('guestAccess=\'off\' denies a guest even on public (reason guest-disabled)', () => {
    const d = authorize(guestP, page(), ctx(guestP, {scope: 'public', config: off}));
    expect(d).toEqual({canRead: false, canWrite: false, reason: 'guest-disabled'});
  });
  it('guestAccess=\'off\' denies anonymous everywhere', () => {
    for (const scope of SCOPES) {
      expect(authorize(anonP, page(), ctx(anonP, {scope, config: off})).canRead).toBe(false);
    }
  });
  it('guestAccess=\'off\' does NOT lock out a jws non-member on public (gate is guest-only)', () => {
    expect(authorize(jws('n'), page(), ctx(jws('n'), {scope: 'public', config: off})).canRead).toBe(true);
  });
  it('a public page overrides a read/write guest gate (guest still reads public)', () => {
    expect(authorize(guestP, page(), ctx(guestP, {scope: 'public', config: cfg({guestAccess: 'read'})})).canRead).toBe(
      true,
    );
  });
});

describe('authorize — ACL matching (B1 issuer pin, N8 verification)', () => {
  it('subject ACL matches any trusted issuer (a federated jws subject)', () => {
    const p = jws('fed', undefined, FEDERATED);
    const d = authorize(p, page([{subject: p.subject, level: 'write'}]), ctx(p, {scope: 'restricted'}));
    expect(d.canWrite).toBe(true);
  });

  it('subject ACL does NOT match an unverified principal (N8 — never granted)', () => {
    const p: Principal = {...jws('exp'), verifiedVia: 'unverified'};
    const d = authorize(p, page([{subject: p.subject, level: 'write'}]), ctx(p, {scope: 'restricted'}));
    expect(d).toEqual({canRead: false, canWrite: false, reason: 'no-grant'});
  });

  it('email ACL matches an authoritative persona (issuer == emailAuthority)', () => {
    const p = jws('person', 'alice@x.test');
    const acl: AclEntry[] = [{email: 'alice@x.test', issuer: ISS, level: 'write'}];
    const d = authorize(p, page(acl), ctx(p, {scope: 'restricted'}));
    expect(d).toEqual({canRead: true, canWrite: true, reason: 'acl-write'});
  });

  it('email ACL is case-insensitive on the address', () => {
    const p = jws('person', 'alice@x.test');
    const acl: AclEntry[] = [{email: 'ALICE@X.test', issuer: ISS, level: 'read'}];
    expect(authorize(p, page(acl), ctx(p, {scope: 'restricted'})).canRead).toBe(true);
  });

  it('email ACL does NOT fire for a federated issuer asserting the same email (B1)', () => {
    // The persona token is from a federated issuer, not the pinned email-authority,
    // so `emailIsAuthoritative` is false — the email grant can never be satisfied.
    const p = jws('person', 'alice@x.test', FEDERATED);
    const acl: AclEntry[] = [{email: 'alice@x.test', issuer: ISS, level: 'write'}];
    const d = authorize(p, page(acl), ctx(p, {scope: 'restricted'}));
    expect(d).toEqual({canRead: false, canWrite: false, reason: 'no-grant'});
  });

  it('email ACL does NOT fire when the entry issuer is not the email-authority (B1)', () => {
    const p = jws('person', 'alice@x.test');
    const acl: AclEntry[] = [{email: 'alice@x.test', issuer: FEDERATED, level: 'write'}];
    expect(authorize(p, page(acl), ctx(p, {scope: 'restricted'})).canWrite).toBe(false);
  });
});

describe('authorize — owner rule gated on jws (N8)', () => {
  it('an unverified assertion claiming the owner subject is NOT owner', () => {
    const p: Principal = {...ownerP, verifiedVia: 'unverified'};
    const d = authorize(p, page(), ctx(p, {scope: 'restricted'}));
    expect(d.reason).not.toBe('owner');
    expect(d).toEqual({canRead: false, canWrite: false, reason: 'no-grant'});
  });
});

describe('authorize — effective visibility uses ctx, not page.visibility (inherit)', () => {
  it('resolved \'members\' governs even when the page is stored \'inherit\'', () => {
    const member = jws('m');
    const stored: AccessPage = {visibility: 'inherit', acl: []};
    // role null ⇒ non-member ⇒ denied on a members-resolved page.
    expect(authorize(member, stored, ctx(member, {role: null, scope: 'members'})).canRead).toBe(false);
    // active member ⇒ reads it.
    expect(authorize(member, stored, ctx(member, {role: 'viewer', scope: 'members'})).canRead).toBe(true);
  });
});

describe('authorize — rule 0 unclaimed short-circuit (loopback-only)', () => {
  const unclaimed = (guestAccess: Cfg['guestAccess']): Cfg => cfg({guestAccess, ownerSubject: undefined});
  const decide = (principal: Principal, guestAccess: Cfg['guestAccess']) =>
    authorize(principal, page(), {
      config: unclaimed(guestAccess),
      role: null,
      effectiveVisibility: 'members',
      emailIsAuthoritative: false,
    });

  it('guestAccess=\'write\': everyone reads+writes (legacy local workspace)', () => {
    const d = decide(guestP, 'write');
    expect(d).toEqual({canRead: true, canWrite: true, reason: 'legacy-guest-gate'});
  });

  it('guestAccess=\'read\': guests read, only jws/local write', () => {
    expect(decide(guestP, 'read')).toEqual({canRead: true, canWrite: false, reason: 'legacy-guest-gate'});
    expect(decide(jws('u'), 'read')).toEqual({canRead: true, canWrite: true, reason: 'legacy-guest-gate'});
    expect(decide(localP, 'read')).toEqual({canRead: true, canWrite: true, reason: 'legacy-guest-gate'});
  });

  it('guestAccess=\'off\': guests get nothing, jws/local still read+write', () => {
    expect(decide(guestP, 'off')).toEqual({canRead: false, canWrite: false, reason: 'legacy-guest-gate'});
    expect(decide(jws('u'), 'off')).toEqual({canRead: true, canWrite: true, reason: 'legacy-guest-gate'});
    expect(decide(localP, 'off')).toEqual({canRead: true, canWrite: true, reason: 'legacy-guest-gate'});
  });
});
