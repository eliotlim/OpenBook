import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {Principal} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';

// Storage-layer suite for the OB-189 sharing CRUD: roster, per-page visibility +
// ACL, role resolution (S3), the issuer-pin (B1), explicit invited status (N1),
// and the §4.3 invite-claim rewrite. No routes/streams (that is OB-190).

const ISS = 'https://account.book.pub'; // the default emailAuthority
const FEDERATED = 'https://self.host.test';

let store: PageStore;
let dir: string;
let seq = 0;

const jws = (sub: string, email?: string, issuer = ISS): Principal => ({
  kind: 'user',
  subject: `${issuer}#${sub}`,
  issuer,
  name: sub,
  ...(email ? {email} : {}),
  verifiedVia: 'jws',
});

const snapshot = () => ({editorjs: {blocks: []}, values: [], names: []});
const newPage = (name: string) => store.upsertPage({name, data: snapshot()});

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-sharing-test-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  // Trust a federated issuer too, so emailAuthority∈trustedIssuers stays valid
  // while we exercise federated subjects.
  await store.updateInstanceConfig({
    trustedIssuers: [{issuer: ISS}, {issuer: FEDERATED}],
  });
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

describe('member roster CRUD', () => {
  it('adds, lists, updates, and removes members', async () => {
    const m = await store.addMember({subject: jws('bob').subject, role: 'admin', status: 'active'});
    expect(m.role).toBe('admin');
    expect(m.status).toBe('active');
    expect(m.subject).toBe(`${ISS}#bob`);

    const all = await store.listMembers();
    expect(all).toHaveLength(1);

    const updated = await store.updateMember(m.id, {role: 'viewer', status: 'suspended'});
    expect(updated?.role).toBe('viewer');
    expect(updated?.status).toBe('suspended');

    expect(await store.removeMember(m.id)).toBe(true);
    expect(await store.listMembers()).toHaveLength(0);
  });

  it('an email invite is stored status=invited explicitly and pins the issuer (N1, B1)', async () => {
    const m = await store.addMember({email: 'Alice@X.test', role: 'viewer', status: 'invited'});
    expect(m.status).toBe('invited');
    expect(m.subject).toBeNull();
    expect(m.email).toBe('alice@x.test'); // lowercased
    expect(m.issuer).toBe(ISS); // defaulted to emailAuthority
  });

  it('rejects a member with neither subject nor email', async () => {
    await expect(store.addMember({status: 'active'})).rejects.toThrow();
  });
});

describe('resolveMemberRole (S3 + B1)', () => {
  it('resolves the role of an active, subject-bound member', async () => {
    await store.addMember({subject: jws('bob').subject, role: 'admin', status: 'active'});
    expect(await store.resolveMemberRole(jws('bob'))).toBe('admin');
  });

  it('grants nothing for an invited (unclaimed) row', async () => {
    await store.addMember({email: 'alice@x.test', role: 'admin', status: 'invited'});
    // Even once signed in, an unbound invited row resolves to null (no subject).
    expect(await store.resolveMemberRole(jws('alice', 'alice@x.test'))).toBeNull();
  });

  it('grants nothing for a suspended row', async () => {
    await store.addMember({subject: jws('bob').subject, role: 'admin', status: 'suspended'});
    expect(await store.resolveMemberRole(jws('bob'))).toBeNull();
  });

  it('never grants a role to a non-jws principal', async () => {
    await store.addMember({subject: 'guest:bob', role: 'admin', status: 'active'});
    const guest: Principal = {kind: 'guest', subject: 'guest:bob', issuer: '', name: 'bob', verifiedVia: 'guest'};
    expect(await store.resolveMemberRole(guest)).toBeNull();
  });

  it('matches an active persona row only under the pinned authority (B1)', async () => {
    // A persona row bound to a subject, but pinned to a FEDERATED issuer — a token
    // from the email-authority must NOT satisfy it, and vice-versa.
    await store.addMember({
      subject: jws('p').subject,
      email: 'p@x.test',
      issuer: FEDERATED,
      role: 'admin',
      status: 'active',
    });
    // authoritative token (issuer == emailAuthority) → issuer pin mismatch → null
    expect(await store.resolveMemberRole(jws('p', 'p@x.test'))).toBeNull();

    // A persona row pinned to the email-authority, claimed by the authoritative token → admin
    await store.addMember({
      subject: jws('q').subject,
      email: 'q@x.test',
      issuer: ISS,
      role: 'admin',
      status: 'active',
    });
    expect(await store.resolveMemberRole(jws('q', 'q@x.test'))).toBe('admin');
    // Same subject, but a different active persona email → that persona row doesn't apply
    expect(await store.resolveMemberRole(jws('q', 'other@x.test'))).toBeNull();
  });

  it('returns the highest role across a subject + persona rows', async () => {
    await store.addMember({subject: jws('r').subject, role: 'viewer', status: 'active'});
    await store.addMember({subject: jws('r').subject, email: 'r@x.test', issuer: ISS, role: 'admin', status: 'active'});
    expect(await store.resolveMemberRole(jws('r', 'r@x.test'))).toBe('admin');
  });
});

describe('per-page visibility', () => {
  it('defaults to inherit and round-trips a set', async () => {
    const p = await newPage('vis');
    expect(await store.getPageVisibility(p.id)).toBe('inherit');
    expect(await store.setPageVisibility(p.id, 'members')).toBe(true);
    expect(await store.getPageVisibility(p.id)).toBe('members');
  });

  it('returns null / false for a missing page', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    expect(await store.getPageVisibility(missing)).toBeNull();
    expect(await store.setPageVisibility(missing, 'public')).toBe(false);
  });
});

describe('per-page ACL CRUD (PK-less, keyed on subject / lower(email))', () => {
  it('upserts a subject grant, replacing on the same key', async () => {
    const p = await newPage('acl-sub');
    await store.setPageAcl(p.id, {subject: jws('bob').subject, level: 'read'});
    let acl = await store.getPageAcl(p.id);
    expect(acl).toHaveLength(1);
    expect(acl[0].level).toBe('read');

    // Same (page_id, subject) key → replace, not duplicate.
    await store.setPageAcl(p.id, {subject: jws('bob').subject, level: 'write'});
    acl = await store.getPageAcl(p.id);
    expect(acl).toHaveLength(1);
    expect(acl[0].level).toBe('write');
  });

  it('upserts an email grant (lowercased, issuer pinned) and removes it', async () => {
    const p = await newPage('acl-email');
    const grant = await store.setPageAcl(p.id, {email: 'Carol@X.test', level: 'read'});
    expect(grant.email).toBe('carol@x.test');
    expect(grant.issuer).toBe(ISS); // defaulted to emailAuthority
    expect(grant.subject).toBeNull();

    // Case-insensitive replace on lower(email).
    await store.setPageAcl(p.id, {email: 'carol@x.test', level: 'write'});
    expect(await store.getPageAcl(p.id)).toHaveLength(1);

    expect(await store.removePageAcl(p.id, {email: 'CAROL@x.test'})).toBe(true);
    expect(await store.getPageAcl(p.id)).toHaveLength(0);
  });

  it('rejects a grant that is neither (or both) subject and email', async () => {
    const p = await newPage('acl-bad');
    await expect(store.setPageAcl(p.id, {level: 'read'})).rejects.toThrow();
    await expect(store.setPageAcl(p.id, {subject: 's', email: 'e@x.test', level: 'read'})).rejects.toThrow();
  });

  it('cascade-deletes ACL rows with their page', async () => {
    const p = await newPage('acl-cascade');
    await store.setPageAcl(p.id, {subject: jws('bob').subject, level: 'read'});
    await store.deletePage(p.id); // soft-delete, then hard-delete from trash
    await store.purgePage(p.id);
    expect(await store.getPageAcl(p.id)).toHaveLength(0);
  });
});

describe('invite-claim rewrite (§4.3)', () => {
  it('binds an invited persona and rewrites email ACLs to subject-keyed (N10)', async () => {
    const p = await newPage('claim');
    await store.addMember({email: 'dora@x.test', role: 'viewer', status: 'invited'});
    await store.setPageAcl(p.id, {email: 'dora@x.test', level: 'write'});

    const claimer = jws('dora', 'dora@x.test');
    const res = await store.claimMemberships(claimer);
    expect(res).toEqual({members: 1, acls: 1});

    // Roster row is now active + bound; role resolves.
    expect(await store.resolveMemberRole(claimer)).toBe('viewer');

    // ACL row is now subject-keyed; email/issuer cleared.
    const acl = await store.getPageAcl(p.id);
    expect(acl).toHaveLength(1);
    expect(acl[0].subject).toBe(claimer.subject);
    expect(acl[0].email).toBeNull();
    expect(acl[0].issuer).toBeNull();
  });

  it('is a no-op for a non-authoritative (federated) principal (B1)', async () => {
    const p = await newPage('claim-fed');
    await store.addMember({email: 'eve@x.test', role: 'viewer', status: 'invited'});
    await store.setPageAcl(p.id, {email: 'eve@x.test', level: 'read'});

    const res = await store.claimMemberships(jws('eve', 'eve@x.test', FEDERATED));
    expect(res).toEqual({members: 0, acls: 0});
  });

  it('does not double up when an email grant collides with an existing subject grant', async () => {
    const p = await newPage('claim-collide');
    const claimer = jws('fred', 'fred@x.test');
    await store.setPageAcl(p.id, {subject: claimer.subject, level: 'write'}); // already shared by subject
    await store.setPageAcl(p.id, {email: 'fred@x.test', level: 'read'}); // also by email

    await store.claimMemberships(claimer);
    const acl = await store.getPageAcl(p.id);
    // The colliding email grant is dropped; the subject grant survives intact.
    expect(acl).toHaveLength(1);
    expect(acl[0].subject).toBe(claimer.subject);
    expect(acl[0].level).toBe('write');
  });
});

describe('instance config validation (Sasha N2)', () => {
  it('rejects an emailAuthority that is not a trusted issuer', async () => {
    await expect(store.updateInstanceConfig({emailAuthority: 'https://untrusted.test'})).rejects.toThrow(
      /trustedIssuers/,
    );
  });

  it('rejects dropping the trusted issuer that emailAuthority points at', async () => {
    // emailAuthority defaults to account.book.pub; removing it from trustedIssuers
    // would silently break every email grant — the writer must refuse.
    await expect(store.updateInstanceConfig({trustedIssuers: [{issuer: FEDERATED}]})).rejects.toThrow(/trustedIssuers/);
  });

  it('accepts a consistent emailAuthority/trustedIssuers pair', async () => {
    const next = await store.updateInstanceConfig({
      emailAuthority: FEDERATED,
      trustedIssuers: [{issuer: ISS}, {issuer: FEDERATED}],
    });
    expect(next.emailAuthority).toBe(FEDERATED);
  });
});
