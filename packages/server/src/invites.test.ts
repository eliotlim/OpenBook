/**
 * Invite / accept by email-or-handle (OB-191; contract
 * `docs/sharing-access-contract-spike-OB-182.md` §4.3 / §4.4).
 *
 * Covers the invite-CREATION side: resolution (email | subject | handle-seam),
 * the roster + per-page ACL routes (create / list / revoke + authorization), and
 * the end-to-end invite → first-sign-in → bound → role-active flow through the
 * existing claim-on-sign-in middleware.
 */

import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  mintIdentityKeypair,
  signIdentity,
  type IdentityClaims,
  type IdentityKeypair,
  type Jwks,
} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';
import {resolveInvitee, InviteResolutionError, type HandleResolver} from './invites';

const ISS = 'https://account.book.pub'; // the default emailAuthority
let store: PageStore;
let dir: string;
let seq = 0;
let kp: IdentityKeypair;
let jwks: Jwks;

const snapshot = () => ({editorjs: {blocks: []}, values: [], names: []});

const idFor = (sub: string, over: Partial<IdentityClaims> = {}): Promise<string> =>
  signIdentity(
    kp.privateKey,
    {
      iss: ISS,
      sub,
      name: sub,
      iat: Math.floor(Date.now() / 1000) - 30,
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: `jti-${sub}-${Math.random()}`,
      ...over,
    },
    kp.publicJwk.kid,
  );

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-invite-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  kp = await mintIdentityKeypair('k1');
  jwks = {keys: [kp.publicJwk]};
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

const app = (handleResolver?: HandleResolver) =>
  createApp(store, undefined, new PageHub(), {identity: new IdentityService(store), handleResolver});

/** Trust the dev issuer and claim the instance under `${ISS}#owner` + an admin. */
const claim = async (): Promise<void> => {
  await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], ownerSubject: `${ISS}#owner`});
  await store.addMember({subject: `${ISS}#admin`, role: 'admin', status: 'active'});
};

const post = (a: ReturnType<typeof app>, path: string, body: unknown, jws?: string) =>
  a.request(path, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...(jws ? {[IDENTITY_HEADER]: jws} : {})},
    body: JSON.stringify(body),
  });

const get = (a: ReturnType<typeof app>, path: string, jws?: string) =>
  a.request(path, {headers: jws ? {[IDENTITY_HEADER]: jws} : {}});

describe('resolveInvitee (§4.3 / §4.4)', () => {
  it('resolves an email to a lowercased persona', async () => {
    expect(await resolveInvitee('Alice@X.test')).toEqual({email: 'alice@x.test'});
  });

  it('resolves an iss#sub to a subject grant (the resolved-handle / roster-pick shape)', async () => {
    expect(await resolveInvitee(`${ISS}#bob`)).toEqual({subject: `${ISS}#bob`});
  });

  it('rejects an empty input (400) and a malformed email (400)', async () => {
    await expect(resolveInvitee('   ')).rejects.toMatchObject({status: 400});
    await expect(resolveInvitee('not-an-email@nope')).rejects.toBeInstanceOf(InviteResolutionError);
  });

  it('rejects a bare handle when no OB-195 resolver is wired (422 stub)', async () => {
    await expect(resolveInvitee('alice')).rejects.toMatchObject({status: 422});
  });

  it('resolves a bare handle through the OB-195 resolver seam when present', async () => {
    const resolver: HandleResolver = {resolve: async (h) => (h === 'alice' ? {subject: `${ISS}#alice`} : null)};
    expect(await resolveInvitee('@alice', resolver)).toEqual({subject: `${ISS}#alice`});
    await expect(resolveInvitee('nobody', resolver)).rejects.toMatchObject({status: 422});
  });
});

describe('roster invite routes (create / list / revoke)', () => {
  beforeEach(claim);

  it('an admin invites by email → a status=invited persona; lists + revokes it', async () => {
    const a = app();
    const res = await post(a, '/api/members', {invitee: 'Dora@X.test', role: 'viewer'}, await idFor('admin'));
    expect(res.status).toBe(201);
    const member = await res.json();
    expect(member).toMatchObject({email: 'dora@x.test', subject: null, status: 'invited', role: 'viewer', issuer: ISS});
    expect(member.invitedBy).toBe(`${ISS}#admin`);

    const list = await (await get(a, '/api/members', await idFor('admin'))).json();
    expect(list.map((m: {email: string | null}) => m.email)).toContain('dora@x.test');

    expect((await a.request(`/api/members/${member.id}`, {
      method: 'DELETE',
      headers: {[IDENTITY_HEADER]: await idFor('admin')},
    })).status).toBe(204);
    const after = await (await get(a, '/api/members', await idFor('admin'))).json();
    expect(after.map((m: {id: string}) => m.id)).not.toContain(member.id);
  });

  it('invites by subject → an immediately-active member', async () => {
    const a = app();
    const member = await (await post(a, '/api/members', {invitee: `${ISS}#sam`, role: 'admin'}, await idFor('owner'))).json();
    expect(member).toMatchObject({subject: `${ISS}#sam`, email: null, status: 'active', role: 'admin'});
  });

  it('PATCH suspends a member (role no longer resolves)', async () => {
    const a = app();
    const member = await (await post(a, '/api/members', {invitee: `${ISS}#sue`, role: 'admin'}, await idFor('owner'))).json();
    expect(await store.resolveMemberRole({kind: 'user', subject: `${ISS}#sue`, issuer: ISS, name: 'sue', verifiedVia: 'jws'})).toBe('admin');
    const patched = await a.request(`/api/members/${member.id}`, {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json', [IDENTITY_HEADER]: await idFor('owner')},
      body: JSON.stringify({status: 'suspended'}),
    });
    expect((await patched.json()).status).toBe('suspended');
    expect(await store.resolveMemberRole({kind: 'user', subject: `${ISS}#sue`, issuer: ISS, name: 'sue', verifiedVia: 'jws'})).toBeNull();
  });

  it('a bare handle 422s without an OB-195 resolver, 201s with one', async () => {
    expect((await post(app(), '/api/members', {invitee: 'ziggy'}, await idFor('admin'))).status).toBe(422);
    const resolver: HandleResolver = {resolve: async () => ({subject: `${ISS}#ziggy`})};
    const res = await post(app(resolver), '/api/members', {invitee: 'ziggy'}, await idFor('admin'));
    expect(res.status).toBe(201);
    expect((await res.json()).subject).toBe(`${ISS}#ziggy`);
  });

  it('only an instance writer manages the roster (viewer + guest 403)', async () => {
    await store.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
    const a = app();
    expect((await post(a, '/api/members', {invitee: 'x@y.test'}, await idFor('viewer'))).status).toBe(403);
    expect((await post(a, '/api/members', {invitee: 'x@y.test'})).status).toBe(403); // anonymous guest
    expect((await get(a, '/api/members', await idFor('viewer'))).status).toBe(403);
  });
});

describe('per-page ACL share routes', () => {
  let restricted: string;
  beforeEach(async () => {
    await claim();
    restricted = (await store.upsertPage({name: `acl-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(restricted, 'restricted');
  });

  it('shares a page by email and lists / revokes the grant', async () => {
    const a = app();
    const grant = await (await post(a, `/api/pages/${restricted}/acl`, {invitee: 'Eve@X.test', level: 'read'}, await idFor('admin'))).json();
    expect(grant).toMatchObject({email: 'eve@x.test', level: 'read', issuer: ISS, subject: null});

    const acl = await (await get(a, `/api/pages/${restricted}/acl`, await idFor('admin'))).json();
    expect(acl).toHaveLength(1);

    expect((await a.request(`/api/pages/${restricted}/acl?email=eve@x.test`, {
      method: 'DELETE',
      headers: {[IDENTITY_HEADER]: await idFor('admin')},
    })).status).toBe(204);
    expect(await (await get(a, `/api/pages/${restricted}/acl`, await idFor('admin'))).json()).toHaveLength(0);
  });

  it('a non-writer of the page cannot read or manage its ACL (404 hides existence)', async () => {
    const a = app();
    // A stranger can't even see the restricted page exists → 404 on the ACL route.
    expect((await get(a, `/api/pages/${restricted}/acl`, await idFor('stranger'))).status).toBe(404);
    expect((await post(a, `/api/pages/${restricted}/acl`, {invitee: 'x@y.test'}, await idFor('stranger'))).status).toBe(404);
  });
});

describe('invite → first sign-in → bound → role active (end to end, §4.3)', () => {
  it('an email invitee, once signed in, is bound and reads the page they were shared', async () => {
    await claim();
    const page = (await store.upsertPage({name: `e2e-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(page, 'restricted');
    const a = app();
    const admin = await idFor('admin');

    // Invite by email to the roster AND share the page by email — both via the API.
    await post(a, '/api/members', {invitee: 'dora@x.test', role: 'viewer'}, admin);
    await post(a, `/api/pages/${page}/acl`, {invitee: 'dora@x.test', level: 'read'}, admin);

    // Before sign-in, the page is hidden from Dora's (yet-unbound) identity? She
    // signs in for the first time: the claim-on-sign-in middleware binds the
    // invited persona + the email ACL to her subject, and authorize then grants.
    const dora = await idFor('dora', {email: 'dora@x.test'});
    expect((await get(a, `/api/pages/${page}`, dora)).status).toBe(200);

    // The roster row is now active + subject-bound; the ACL is subject-keyed.
    const members = await (await get(a, '/api/members', admin)).json();
    const bound = members.find((m: {subject: string | null}) => m.subject === `${ISS}#dora`);
    expect(bound).toMatchObject({subject: `${ISS}#dora`, status: 'active', email: 'dora@x.test'});
    const acl = await store.getPageAcl(page);
    expect(acl[0]).toMatchObject({subject: `${ISS}#dora`, email: null, issuer: null});

    // And her role is live this same session.
    expect(await store.resolveMemberRole({kind: 'user', subject: `${ISS}#dora`, issuer: ISS, name: 'dora', email: 'dora@x.test', verifiedVia: 'jws'})).toBe('viewer');
  });
});
