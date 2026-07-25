/**
 * Forwarded per-page exposure through the tunnel (OB-202; contract
 * `docs/sharing-access-contract-spike-OB-182.md` §3.2–3.4).
 *
 * The D2 edge (OB-201) mints an `aud`-scoped identity JWS (`aud = <prefix>.book.cloud`,
 * `iss = account.book.pub`) and injects it as `X-OpenBook-Identity` on every forwarded
 * request. The origin already verifies that header (OB-177) and enforces per page
 * (OB-190). This suite proves the two halves meet: a forwarded instance binds its
 * audience to the canonical host (`audience` + `requireAudience`), and a forwarded
 * viewer carrying a valid edge JWS then gets per-page-correct access — while an
 * audience mismatch (wrong/absent `aud`) and an untrusted issuer fail **closed** (401),
 * never a silent downgrade to an over-granted guest.
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

const ISS = 'https://account.book.pub'; // the default emailAuthority + trusted issuer
const SITE_HOST = 'demo-xyz.book.cloud'; // this instance's canonical forwarded host (= aud)
const OTHER_HOST = 'evil-abc.book.cloud'; // a *different* forwarded site's host

let store: PageStore;
let dir: string;
let seq = 0;
let kp: IdentityKeypair;
let jwks: Jwks;
let otherKp: IdentityKeypair; // an untrusted federated issuer's key

const snapshot = () => ({editorjs: {blocks: []}, values: [], names: []});

/** An edge-shaped forwarded token: `aud` defaults to THIS site's host (override per case). */
const fwd = (sub: string, over: Partial<IdentityClaims> = {}): Promise<string> =>
  signIdentity(
    kp.privateKey,
    {
      iss: ISS,
      sub,
      name: sub,
      aud: SITE_HOST,
      iat: Math.floor(Date.now() / 1000) - 30,
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: `jti-${sub}-${Math.random()}`,
      ...over,
    },
    kp.publicJwk.kid,
  );

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-fwd-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  kp = await mintIdentityKeypair('k1');
  jwks = {keys: [kp.publicJwk]};
  otherKp = await mintIdentityKeypair('other');
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

const app = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});

/**
 * Claim + bind the instance exactly as `enable forwarding` does: trust the issuer,
 * own it under `${ISS}#owner`, and scope identity to the canonical host with
 * `requireAudience` (so an unscoped/wrong-aud token is rejected — OB-177).
 */
const claimAndBind = () =>
  store.updateInstanceConfig({
    trustedIssuers: [{issuer: ISS, jwks}],
    ownerSubject: `${ISS}#owner`,
    audience: SITE_HOST,
    requireAudience: true,
  });

const get = (a: ReturnType<typeof app>, path: string, jws?: string) =>
  a.request(path, {headers: {'X-OpenBook-Client': '1', ...(jws ? {[IDENTITY_HEADER]: jws} : {})}});

const put = (a: ReturnType<typeof app>, id: string, jws?: string) =>
  a.request(`/api/pages/${id}`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1', ...(jws ? {[IDENTITY_HEADER]: jws} : {})},
    body: JSON.stringify({id, name: `p-${seq}`, data: snapshot()}),
  });

describe('forwarded per-page enforcement (valid edge JWS, aud bound to the site host)', () => {
  let pub: string;
  let auth: string;
  let mem: string;
  let restr: string;

  beforeEach(async () => {
    await claimAndBind();
    await store.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
    pub = (await store.upsertPage({name: `pub-${seq}`, data: snapshot()})).id;
    auth = (await store.upsertPage({name: `auth-${seq}`, data: snapshot()})).id;
    mem = (await store.upsertPage({name: `mem-${seq}`, data: snapshot()})).id;
    restr = (await store.upsertPage({name: `restr-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(pub, 'public');
    await store.setPageVisibility(auth, 'authenticated');
    await store.setPageVisibility(mem, 'members');
    await store.setPageVisibility(restr, 'restricted');
    await store.setPageAcl(restr, {subject: `${ISS}#granted`, level: 'read'});
    await store.setPageAcl(restr, {subject: `${ISS}#editor`, level: 'write'});
    await store.setPageAcl(restr, {email: 'dora@x.test', level: 'read'});
  });

  it('public: served to a forwarded viewer AND to an anonymous (no-JWS) guest', async () => {
    const a = app();
    expect((await get(a, `/api/pages/${pub}`, await fwd('stranger'))).status).toBe(200);
    expect((await get(a, `/api/pages/${pub}`)).status).toBe(200); // pseudonymous public browse
  });

  it('authenticated: any forwarded JWS reads; an anonymous guest is hidden (404)', async () => {
    const a = app();
    expect((await get(a, `/api/pages/${auth}`, await fwd('stranger'))).status).toBe(200);
    expect((await get(a, `/api/pages/${auth}`)).status).toBe(404);
  });

  it('members: a member reads; a forwarded non-member + anon guest are hidden (404)', async () => {
    const a = app();
    expect((await get(a, `/api/pages/${mem}`, await fwd('viewer'))).status).toBe(200);
    expect((await get(a, `/api/pages/${mem}`, await fwd('stranger'))).status).toBe(404);
    expect((await get(a, `/api/pages/${mem}`)).status).toBe(404);
  });

  it('restricted: hidden from non-grantees (404), served to the ACL grantee + owner', async () => {
    const a = app();
    expect((await get(a, `/api/pages/${restr}`, await fwd('stranger'))).status).toBe(404);
    expect((await get(a, `/api/pages/${restr}`, await fwd('viewer'))).status).toBe(404); // member, not on ACL
    expect((await get(a, `/api/pages/${restr}`)).status).toBe(404); // anonymous
    expect((await get(a, `/api/pages/${restr}`, await fwd('granted'))).status).toBe(200);
    expect((await get(a, `/api/pages/${restr}`, await fwd('owner'))).status).toBe(200);
  });

  it('restricted write: a read-grantee is 403, a write-grantee + owner write (200)', async () => {
    const a = app();
    expect((await put(a, restr, await fwd('granted'))).status).toBe(403); // acl read-only
    expect((await put(a, restr, await fwd('editor'))).status).toBe(200); // acl write
    expect((await put(a, restr, await fwd('owner'))).status).toBe(200);
    expect((await put(a, restr, await fwd('stranger'))).status).toBe(404); // existence hidden, not 403
  });

  it('restricted email ACL: a forwarded persona-email token unlocks via claim-on-sign-in', async () => {
    const a = app();
    // The edge token carries the single active-persona email; iss === emailAuthority,
    // so the email ACL matches once the first request binds the persona (§3.3, S6).
    const jws = await fwd('dora', {email: 'dora@x.test'});
    expect((await get(a, `/api/pages/${restr}`, jws)).status).toBe(200);
  });

  it('the forwarded page list is filtered per principal', async () => {
    const a = app();
    const ids = async (jws?: string) =>
      ((await (await get(a, '/api/pages', jws)).json()) as Array<{id: string}>).map((p) => p.id);
    const strangerIds = await ids(await fwd('stranger'));
    expect(strangerIds).toEqual(expect.arrayContaining([pub, auth]));
    expect(strangerIds).not.toContain(mem);
    expect(strangerIds).not.toContain(restr);
    const guestIds = await ids();
    expect(guestIds).toEqual([pub]); // public only, anonymous
  });
});

describe('audience mismatch fails closed (no silent over-granting downgrade)', () => {
  let pub: string;

  beforeEach(async () => {
    await claimAndBind();
    pub = (await store.upsertPage({name: `pub-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(pub, 'public');
  });

  it('a token minted for a DIFFERENT site (wrong aud) is 401 — even on a public page', async () => {
    const a = app();
    const wrong = await fwd('attacker', {aud: OTHER_HOST});
    // NOT 200-as-guest: a present-but-wrong-audience credential is an error, closing
    // the confused-deputy replay hole (a token for site B can't be replayed to A).
    expect((await get(a, `/api/pages/${pub}`, wrong)).status).toBe(401);
  });

  it('an UNSCOPED token (no aud) is rejected while requireAudience is set (401)', async () => {
    const a = app();
    const unscoped = await fwd('drifter', {aud: undefined});
    expect((await get(a, `/api/pages/${pub}`, unscoped)).status).toBe(401);
  });

  it('a token from an untrusted issuer is 401 (not a guest downgrade)', async () => {
    const a = app();
    const foreign = await signIdentity(
      otherKp.privateKey,
      {
        iss: 'https://evil.example',
        sub: 'mallory',
        name: 'mallory',
        aud: SITE_HOST,
        iat: Math.floor(Date.now() / 1000) - 30,
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: `jti-foreign-${Math.random()}`,
      },
      otherKp.publicJwk.kid,
    );
    expect((await get(a, `/api/pages/${pub}`, foreign)).status).toBe(401);
  });

  it('a correctly-scoped token still verifies (control) — the gate is the aud, not the JWS', async () => {
    const a = app();
    expect((await get(a, `/api/pages/${pub}`, await fwd('ok'))).status).toBe(200);
  });
});

/**
 * The forwarding-enable flow flips the audience binding in a seamless 3-phase
 * switch so the local owner — who reaches the same server over loopback with their
 * OWN token — is never locked out (the one-audience unification; the simultaneous
 * direct-LAN multi-audience case is deferred). These are the two server-side
 * acceptances that make the switch safe (proved end-to-end through the app).
 */
describe('audience-bind transition keeps the loopback owner verified', () => {
  let page: string;

  beforeEach(async () => {
    await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], ownerSubject: `${ISS}#owner`});
    page = (await store.upsertPage({name: `p-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(page, 'members'); // owner-only via rule 2
  });

  it('phase 1 — audience set but not required: an UNSCOPED owner token still verifies', async () => {
    // The first PUT of the switch rides the owner's still-unscoped token, so it must
    // verify while `audience` is adopted but `requireAudience` is not yet on.
    await store.updateInstanceConfig({audience: SITE_HOST, requireAudience: false});
    const a = app();
    expect((await get(a, `/api/pages/${page}`, await fwd('owner', {aud: undefined}))).status).toBe(200);
  });

  it('phase 3 — audience required: the re-minted aud-scoped owner token verifies, unscoped is out', async () => {
    await store.updateInstanceConfig({audience: SITE_HOST, requireAudience: true});
    const a = app();
    expect((await get(a, `/api/pages/${page}`, await fwd('owner'))).status).toBe(200); // aud=SITE_HOST
    expect((await get(a, `/api/pages/${page}`, await fwd('owner', {aud: undefined}))).status).toBe(401);
  });
});

/**
 * The always-available escape hatch (OB-202, Sasha #2): even if the instance ever
 * ends up `requireAudience:true` while the owner's own loopback token is unscoped
 * (or scoped elsewhere) — a state the enable/disable flow is written to avoid — the
 * owner must be able to RELAX the audience requirement. A token rejected SOLELY for
 * its audience is a signature-verified owner, not a forgery, so `PUT /api/instance`
 * with `requireAudience:false` is reachable; everything else stays fail-closed.
 */
describe('loopback-owner recovery from an audience lockout (relax only)', () => {
  let page: string;

  const putInstance = (a: ReturnType<typeof app>, patch: Record<string, unknown>, jws?: string) =>
    a.request('/api/instance', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1', ...(jws ? {[IDENTITY_HEADER]: jws} : {})},
      body: JSON.stringify(patch),
    });

  beforeEach(async () => {
    await claimAndBind(); // owner=`${ISS}#owner`, audience=SITE_HOST, requireAudience:true
    page = (await store.upsertPage({name: `p-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(page, 'members'); // owner-only
  });

  it('GET /api/instance reports requireAudience (so a client can short-circuit on relaunch)', async () => {
    const a = app();
    const info = (await (await get(a, '/api/instance', await fwd('owner'))).json()) as {requireAudience?: boolean};
    expect(info.requireAudience).toBe(true);
  });

  it('an unscoped owner token is locked out of pages, but can relax requireAudience and recover', async () => {
    const a = app();
    const lockedOwner = await fwd('owner', {aud: undefined});
    // The lockout: an unscoped owner token is 401 everywhere while requireAudience is on.
    expect((await get(a, `/api/pages/${page}`, lockedOwner)).status).toBe(401);
    // Recovery: the SAME token may relax the audience requirement (de-escalation).
    const relax = await putInstance(a, {requireAudience: false}, lockedOwner);
    expect(relax.status).toBe(200);
    expect(((await relax.json()) as {requireAudience?: boolean}).requireAudience).toBe(false);
    // Recovered: the unscoped owner token now reads its own page again.
    expect((await get(a, `/api/pages/${page}`, lockedOwner)).status).toBe(200);
  });

  it('a wrong-audience owner token (scoped to another site) recovers the relax too', async () => {
    const a = app();
    const wrongAud = await fwd('owner', {aud: OTHER_HOST});
    expect((await putInstance(a, {requireAudience: false}, wrongAud)).status).toBe(200);
  });

  it('recovery is relax-ONLY: an audience-locked owner cannot make any other policy change', async () => {
    const a = app();
    const lockedOwner = await fwd('owner', {aud: undefined});
    // A non-relax patch falls through recovery → the original audience 401 stands.
    expect((await putInstance(a, {guestAccess: 'read'}, lockedOwner)).status).toBe(401);
    // …and a relax BUNDLED with any other field is rejected too: recovery accepts only
    // a patch whose SOLE key is `requireAudience:false`, so a locked owner can't smuggle
    // a `guestAccess` (or any) change through the relax escape hatch (Sasha #3 / Quinn #1).
    expect((await putInstance(a, {requireAudience: false, guestAccess: 'off'}, lockedOwner)).status).toBe(401);
  });

  it('a NON-owner audience-mismatched token cannot relax (the owner-check still gates who)', async () => {
    const a = app();
    const stranger = await fwd('stranger', {aud: undefined}); // valid sig, trusted issuer, not the owner
    expect((await putInstance(a, {requireAudience: false}, stranger)).status).toBe(403);
  });

  it('an untrusted-issuer token cannot recover (no signature to trust)', async () => {
    const a = app();
    const foreign = await signIdentity(
      otherKp.privateKey,
      {
        iss: 'https://evil.example',
        sub: 'owner',
        name: 'owner',
        iat: Math.floor(Date.now() / 1000) - 30,
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: `jti-evil-${Math.random()}`,
      },
      otherKp.publicJwk.kid,
    );
    expect((await putInstance(a, {requireAudience: false}, foreign)).status).toBe(401);
  });

  it('a trusted-issuer token with a BAD signature cannot recover (signature still enforced)', async () => {
    const a = app();
    // The header names the TRUSTED issuer and its real key id, but the token is signed
    // with a DIFFERENT private key — so the signature fails. Recovery neutralizes only
    // the audience, never the signature: a forgery that merely *claims* the owner stays
    // 401, so the escape hatch can't be used to mint authority (Sasha #2).
    const forged = await signIdentity(
      otherKp.privateKey,
      {
        iss: ISS, // trusted issuer…
        sub: 'owner',
        name: 'owner',
        aud: undefined, // …and audience-shaped like a lockout, so only the bad sig stops it
        iat: Math.floor(Date.now() / 1000) - 30,
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: `jti-badsig-${Math.random()}`,
      },
      kp.publicJwk.kid, // the trusted key's id, but the wrong signing key
    );
    expect((await putInstance(a, {requireAudience: false}, forged)).status).toBe(401);
  });

  it('an EXPIRED owner token cannot recover (time window still enforced)', async () => {
    const a = app();
    // A genuinely signed owner token, unscoped like a lockout — but past its `exp`.
    // Recovery must not resurrect it: it relaxes ONLY the audience, never the clock.
    const expired = await fwd('owner', {
      aud: undefined,
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    expect((await putInstance(a, {requireAudience: false}, expired)).status).toBe(401);
  });
});
