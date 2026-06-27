/**
 * Enforcement integration suite (OB-190; contract
 * `docs/sharing-access-contract-spike-OB-182.md` §1.4 / §2.2 / S4).
 *
 * Exercises the request-path wiring of `authorize()`: the central default-deny
 * gate on every content route, principal-aware stream fan-out, claim-on-sign-in,
 * the guest-floor / un-claim guarantees, and unclaimed-instance back-compat.
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
  type Principal,
} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';
import {streamGates} from './access';
import type {ListEvent} from './hub';

const ISS = 'https://account.book.pub'; // the default emailAuthority
let store: PageStore;
let dir: string;
let seq = 0;
let kp: IdentityKeypair;
let jwks: Jwks;

const snapshot = () => ({editorjs: {blocks: []}, values: [], names: []});
const pageBody = (name: string) => JSON.stringify({name, data: snapshot()});

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

const principal = (sub: string, email?: string): Principal => ({
  kind: 'user',
  subject: `${ISS}#${sub}`,
  issuer: ISS,
  name: sub,
  ...(email ? {email} : {}),
  verifiedVia: 'jws',
});

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-enforce-${process.pid}-${seq}`);
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

const app = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});

/** Trust the dev issuer and claim the instance under `${ISS}#owner`. */
const claim = () => store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], ownerSubject: `${ISS}#owner`});

const get = (a: ReturnType<typeof app>, path: string, jws?: string) =>
  a.request(path, {headers: jws ? {[IDENTITY_HEADER]: jws} : {}});

const put = (a: ReturnType<typeof app>, path: string, body: string, jws?: string) =>
  a.request(path, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json', ...(jws ? {[IDENTITY_HEADER]: jws} : {})},
    body,
  });

describe('claimed-instance content gating', () => {
  let pub: string;
  let mem: string;
  let restr: string;

  beforeEach(async () => {
    await claim();
    await store.addMember({subject: `${ISS}#admin`, role: 'admin', status: 'active'});
    await store.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
    pub = (await store.upsertPage({name: `pub-${seq}`, data: snapshot()})).id;
    mem = (await store.upsertPage({name: `mem-${seq}`, data: snapshot()})).id;
    restr = (await store.upsertPage({name: `restr-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(pub, 'public');
    await store.setPageVisibility(mem, 'members');
    await store.setPageVisibility(restr, 'restricted');
    await store.setPageAcl(restr, {subject: `${ISS}#granted`, level: 'read'});
  });

  it('admin + owner write a members page; a viewer is denied (403)', async () => {
    const a = app();
    const body = JSON.stringify({id: mem, name: `mem-${seq}`, data: snapshot()});
    expect((await put(a, `/api/pages/${mem}`, body, await idFor('owner'))).status).toBe(200);
    expect((await put(a, `/api/pages/${mem}`, body, await idFor('admin'))).status).toBe(200);
    expect((await put(a, `/api/pages/${mem}`, body, await idFor('viewer'))).status).toBe(403);
  });

  it('a viewer reads a members page but cannot create a page (403); an admin can (201)', async () => {
    const a = app();
    expect((await get(a, `/api/pages/${mem}`, await idFor('viewer'))).status).toBe(200);
    expect(
      (await a.request('/api/pages', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', [IDENTITY_HEADER]: await idFor('viewer')},
        body: pageBody(`v-new-${seq}`),
      })).status,
    ).toBe(403);
    expect(
      (await a.request('/api/pages', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', [IDENTITY_HEADER]: await idFor('admin')},
        body: pageBody(`a-new-${seq}`),
      })).status,
    ).toBe(201);
  });

  it('a restricted page is hidden (404) from non-grantees, served to the ACL grantee + owner', async () => {
    const a = app();
    expect((await get(a, `/api/pages/${restr}`, await idFor('viewer'))).status).toBe(404);
    expect((await get(a, `/api/pages/${restr}`, await idFor('stranger'))).status).toBe(404);
    expect((await get(a, `/api/pages/${restr}`)).status).toBe(404); // anonymous guest
    expect((await get(a, `/api/pages/${restr}`, await idFor('granted'))).status).toBe(200);
    expect((await get(a, `/api/pages/${restr}`, await idFor('owner'))).status).toBe(200);
  });

  it('the page list is filtered per principal (restricted hidden from non-grantees)', async () => {
    const a = app();
    const ids = async (jws?: string) =>
      ((await (await get(a, '/api/pages', jws)).json()) as Array<{id: string}>).map((p) => p.id);
    expect(await ids(await idFor('owner'))).toEqual(expect.arrayContaining([pub, mem, restr]));
    const viewerIds = await ids(await idFor('viewer'));
    expect(viewerIds).toEqual(expect.arrayContaining([pub, mem]));
    expect(viewerIds).not.toContain(restr);
    const grantedIds = await ids(await idFor('granted')); // jws non-member with ACL read
    expect(grantedIds).toEqual(expect.arrayContaining([pub, restr]));
    expect(grantedIds).not.toContain(mem); // members scope, not a member
    const guestIds = await ids();
    expect(guestIds).toEqual([pub]); // public only
  });

  it('members scope: a member reads, a jws non-member + guest 404', async () => {
    const a = app();
    expect((await get(a, `/api/pages/${mem}`, await idFor('viewer'))).status).toBe(200);
    expect((await get(a, `/api/pages/${mem}`, await idFor('stranger'))).status).toBe(404);
    expect((await get(a, `/api/pages/${mem}`)).status).toBe(404);
  });

  it('public is served to anon; guestAccess=off blocks even public (401 floor)', async () => {
    const a = app();
    expect((await get(a, `/api/pages/${pub}`)).status).toBe(200);
    await store.updateInstanceConfig({guestAccess: 'off'});
    expect((await get(a, `/api/pages/${pub}`)).status).toBe(401); // guest fully denied
    expect((await get(a, `/api/pages/${pub}`, await idFor('viewer'))).status).toBe(200); // member still reads
  });

  it('writing a page you cannot read 404s (existence hidden), not 403', async () => {
    const a = app();
    const body = JSON.stringify({id: restr, name: `restr-${seq}`, data: snapshot()});
    expect((await put(a, `/api/pages/${restr}`, body, await idFor('stranger'))).status).toBe(404);
  });
});

describe('principal-aware live fan-out (S4)', () => {
  let mem: string;
  let restr: string;

  beforeEach(async () => {
    await claim();
    await store.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
    mem = (await store.upsertPage({name: `mem-${seq}`, data: snapshot()})).id;
    restr = (await store.upsertPage({name: `restr-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(mem, 'members');
    await store.setPageVisibility(restr, 'restricted');
  });

  it('the firehose gate drops a restricted page event + filters it from list frames', async () => {
    const gates = streamGates(store, principal('viewer'));
    const restricted = (await store.getPage(restr))!;
    const member = (await store.getPage(mem))!;

    // A restricted page the viewer can't read → dropped; a members page → passes.
    expect(await gates.live({type: 'page', page: restricted})).toBeNull();
    expect(await gates.live({type: 'page', page: member})).not.toBeNull();

    // The list frame strips the restricted page but keeps the members page.
    const framed = (await gates.live({type: 'list', pages: await store.listPages()})) as ListEvent;
    const ids = framed.pages.map((p) => p.id);
    expect(ids).toContain(mem);
    expect(ids).not.toContain(restr);
  });

  it('the per-page gate drops events for a page that is not readable', async () => {
    const gates = streamGates(store, principal('viewer'));
    const restricted = (await store.getPage(restr))!;
    expect(await gates.page({type: 'page', page: restricted})).toBeNull();
    // A deletion tombstone carries no content, so it always passes through.
    expect(await gates.page({type: 'deleted', id: restr})).toEqual({type: 'deleted', id: restr});
  });

  it('an owner sees everything through the same gate', async () => {
    const gates = streamGates(store, principal('owner'));
    const restricted = (await store.getPage(restr))!;
    expect(await gates.live({type: 'page', page: restricted})).not.toBeNull();
    const framed = (await gates.live({type: 'list', pages: await store.listPages()})) as ListEvent;
    expect(framed.pages.map((p) => p.id)).toEqual(expect.arrayContaining([mem, restr]));
  });
});

describe('claim-on-sign-in (contract §4.3)', () => {
  it('binds an invited persona + email ACL on the invitee’s first request, unlocking the page', async () => {
    await claim();
    const invitee = (await store.upsertPage({name: `inv-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(invitee, 'restricted');
    await store.addMember({email: 'dora@x.test', role: 'viewer', status: 'invited'});
    await store.setPageAcl(invitee, {email: 'dora@x.test', level: 'read'});

    const a = app();
    const jws = await idFor('dora', {email: 'dora@x.test'});
    // First request triggers claimMemberships in middleware, then authorizes with
    // the freshly-bound subject-keyed ACL → readable.
    expect((await get(a, `/api/pages/${invitee}`, jws)).status).toBe(200);

    // The roster row is now active + subject-bound, and the ACL is subject-keyed.
    const members = await store.listMembers();
    expect(members[0]).toMatchObject({subject: `${ISS}#dora`, status: 'active'});
    const acl = await store.getPageAcl(invitee);
    expect(acl[0]).toMatchObject({subject: `${ISS}#dora`, email: null, issuer: null});
  });
});

describe('unclaimed-instance back-compat (rule 0)', () => {
  it('a guest reads + writes + sees the full list, exactly as today', async () => {
    // No claim, no trusted issuers configured → legacy guest-everyone server.
    const legacy = createApp(store, undefined, new PageHub());
    const p = (await store.upsertPage({name: `legacy-${seq}`, data: snapshot()})).id;
    expect((await legacy.request('/api/pages')).status).toBe(200);
    const list = (await (await legacy.request('/api/pages')).json()) as Array<{id: string}>;
    expect(list.map((x) => x.id)).toContain(p);
    const created = await legacy.request('/api/pages', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: pageBody(`legacy-new-${seq}`),
    });
    expect(created.status).toBe(201);
    expect((await get(legacy, `/api/pages/${p}`)).status).toBe(200);
  });
});

describe('claim is one-way (un-claim guard, OB-182 §2.6)', () => {
  beforeEach(async () => {
    await claim();
  });

  it('refuses to clear ownerSubject', async () => {
    await expect(store.updateInstanceConfig({ownerSubject: undefined})).rejects.toThrow(/claim-once/);
  });

  it('refuses to re-point ownerSubject to a different subject', async () => {
    await expect(store.updateInstanceConfig({ownerSubject: `${ISS}#someone-else`})).rejects.toThrow(/claim-once/);
  });

  it('allows an idempotent re-set of the same owner', async () => {
    const next = await store.updateInstanceConfig({ownerSubject: `${ISS}#owner`});
    expect(next.ownerSubject).toBe(`${ISS}#owner`);
  });
});
