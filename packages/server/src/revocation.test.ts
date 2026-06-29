/**
 * JWS revocation — the data-server (consumer/verifier) side of OB-106.
 *
 * The account issuer publishes an EdDSA-signed revocation document; the data
 * server fetches + signature-verifies it (against the same JWKS as identity
 * tokens), caches it with a last-good offline fallback, and rejects any token
 * whose `sub` was revoked with a `since` newer than the token's `iat`. These
 * tests run against a fixture document — they never touch the live endpoint.
 */

import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  mintIdentityKeypair,
  signIdentity,
  signRevocations,
  verifyIdentity,
  verifyRevocations,
  type IdentityClaims,
  type IdentityKeypair,
  type Jwks,
  type RevocationSet,
} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';

const ISS = 'https://account.book.pub';
const REV_URL = `${ISS}/api/identity/revocations`;
const NOW = 1_750_000_000_000; // fixed epoch ms for deterministic time checks
const NOW_S = Math.floor(NOW / 1000);

const idClaims = (sub: string, over: Partial<IdentityClaims> = {}): IdentityClaims => ({
  iss: ISS,
  sub,
  name: sub,
  iat: NOW_S - 30,
  exp: NOW_S + 3600,
  jti: `j-${sub}`,
  ...over,
});

// ── D1: pure SDK verification (offline, fixture-only) ─────────────────────────

describe('revocation — verifyIdentity (OB-106)', () => {
  let kp: IdentityKeypair;
  let jwks: Jwks;

  beforeEach(async () => {
    kp = await mintIdentityKeypair('k1');
    jwks = {keys: [kp.publicJwk]};
  });

  const verify = (jws: string, revocations?: RevocationSet) =>
    verifyIdentity(jws, jwks, {nowMs: NOW, allowedIssuers: [ISS], revocations});

  it('rejects a token issued before its sub was revoked (iat < since)', async () => {
    const set: RevocationSet = {iss: ISS, iat: NOW_S, ttl: 900, revocations: [{sub: 'u1', since: NOW_S - 1000, reason: 'signed-out'}]};
    const jws = await signIdentity(kp.privateKey, idClaims('u1', {iat: NOW_S - 2000}), 'k1');
    expect(await verify(jws, set)).toMatchObject({ok: false, reason: 'revoked'});
  });

  it('accepts a token re-issued at/after the revocation boundary (iat >= since)', async () => {
    const set: RevocationSet = {iss: ISS, revocations: [{sub: 'u1', since: NOW_S - 1000}]};
    // Exactly at the boundary (strict `<`, so `iat === since` is still valid)…
    const atBoundary = await signIdentity(kp.privateKey, idClaims('u1', {iat: NOW_S - 1000}), 'k1');
    expect((await verify(atBoundary, set)).ok).toBe(true);
    // …and a fresh re-login after it.
    const fresh = await signIdentity(kp.privateKey, idClaims('u1', {iat: NOW_S - 30}), 'k1');
    expect((await verify(fresh, set)).ok).toBe(true);
  });

  it('accepts a token whose sub is not listed in the revocation set', async () => {
    const set: RevocationSet = {iss: ISS, revocations: [{sub: 'someone-else', since: NOW_S}]};
    const jws = await signIdentity(kp.privateKey, idClaims('u1', {iat: NOW_S - 2000}), 'k1');
    expect((await verify(jws, set)).ok).toBe(true);
  });

  it('ignores a revocation set whose issuer differs from the token', async () => {
    // A set for a *different* issuer must never revoke this issuer's tokens.
    const set: RevocationSet = {iss: 'https://other.example', revocations: [{sub: 'u1', since: NOW_S}]};
    const jws = await signIdentity(kp.privateKey, idClaims('u1', {iat: NOW_S - 2000}), 'k1');
    expect((await verify(jws, set)).ok).toBe(true);
  });

  it('does not run when no revocation set is supplied (fail-open)', async () => {
    const jws = await signIdentity(kp.privateKey, idClaims('u1', {iat: NOW_S - 2000}), 'k1');
    expect((await verify(jws, undefined)).ok).toBe(true);
  });
});

// ── D1: the revocation document is itself a signed JWS ─────────────────────────

describe('revocation — document signature (OB-106)', () => {
  let kp: IdentityKeypair;
  let jwks: Jwks;

  beforeEach(async () => {
    kp = await mintIdentityKeypair('k1');
    jwks = {keys: [kp.publicJwk]};
  });

  it('verifies + parses a properly signed document', async () => {
    const jws = await signRevocations(kp.privateKey, {iss: ISS, iat: NOW_S, ttl: 900, revocations: [{sub: 'u1', since: NOW_S}]}, 'k1');
    expect(await verifyRevocations(jws, jwks)).toMatchObject({iss: ISS, revocations: [{sub: 'u1', since: NOW_S}]});
  });

  it('rejects a document signed by a key outside the JWKS (forgery)', async () => {
    const attacker = await mintIdentityKeypair('k2');
    const jws = await signRevocations(attacker.privateKey, {iss: ISS, revocations: [{sub: 'u1', since: NOW_S}]}, 'k2');
    expect(await verifyRevocations(jws, jwks)).toBeNull();
  });

  it('rejects a tampered payload (good key, swapped body)', async () => {
    const benign = await signRevocations(kp.privateKey, {iss: ISS, revocations: []}, 'k1');
    const malicious = await signRevocations(kp.privateKey, {iss: ISS, revocations: [{sub: 'u1', since: NOW_S}]}, 'k1');
    const [h, , s] = benign.split('.');
    const tampered = `${h}.${malicious.split('.')[1]}.${s}`; // malicious payload, benign signature
    expect(await verifyRevocations(tampered, jwks)).toBeNull();
  });

  it('rejects a malformed / unsigned document', async () => {
    expect(await verifyRevocations('not-a-jws', jwks)).toBeNull();
    expect(await verifyRevocations('', jwks)).toBeNull();
  });
});

// ── D2: server integration (IdentityService cache + resolvePrincipal → 401) ───

describe('revocation — server integration (OB-106)', () => {
  let store: PageStore;
  let dir: string;
  let seq = 0;
  let kp: IdentityKeypair;
  let jwks: Jwks;

  const snapshot = () => ({editorjs: {blocks: []}, values: [], names: []});

  const tokenFor = (sub: string, iat: number): Promise<string> =>
    signIdentity(kp.privateKey, {iss: ISS, sub, name: sub, iat, exp: NOW_S + 3600, jti: `j-${sub}-${iat}`}, 'k1');

  const revDoc = (entries: RevocationSet['revocations']): Promise<string> =>
    signRevocations(kp.privateKey, {iss: ISS, iat: NOW_S, ttl: 900, revocations: entries}, 'k1');

  const serveDoc = (doc: string) => async (url: string) =>
    url === REV_URL ? new Response(doc, {status: 200}) : new Response('', {status: 404});

  beforeEach(async () => {
    seq += 1;
    dir = join(tmpdir(), `ob-rev-test-${process.pid}-${seq}`);
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

  it('rejects a revoked token with 401 via the app (never a guest downgrade)', async () => {
    await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks, revocationsUrl: REV_URL}]});
    const identity = new IdentityService(store, {fetchImpl: serveDoc(await revDoc([{sub: 'u1', since: NOW_S - 1000, reason: 'deleted'}])), now: () => NOW});
    const app = createApp(store, undefined, new PageHub(), {identity});
    const jws = await tokenFor('u1', NOW_S - 2000);
    // A revoked token is a 401 even on a GET (which a guest could otherwise read).
    expect((await app.request('/api/pages', {headers: {[IDENTITY_HEADER]: jws}})).status).toBe(401);
    // And it is rejected on writes too — not silently treated as a guest.
    const write = await app.request('/api/pages', {
      method: 'POST',
      headers: {[IDENTITY_HEADER]: jws, 'Content-Type': 'application/json'},
      body: JSON.stringify({name: `rev-${seq}`, data: snapshot()}),
    });
    expect(write.status).toBe(401);
  });

  it('honours a token re-issued after the revocation boundary', async () => {
    await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks, revocationsUrl: REV_URL}]});
    const identity = new IdentityService(store, {fetchImpl: serveDoc(await revDoc([{sub: 'u1', since: NOW_S - 1000}])), now: () => NOW});
    const app = createApp(store, undefined, new PageHub(), {identity});
    const jws = await tokenFor('u1', NOW_S - 30); // issued after `since`
    expect((await app.request('/api/pages', {headers: {[IDENTITY_HEADER]: jws}})).status).toBe(200);
  });

  it('uses the last-good cached set when a later fetch fails (offline)', async () => {
    await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks, revocationsUrl: REV_URL}]});
    const doc = await revDoc([{sub: 'u1', since: NOW_S - 1000}]);
    let online = true;
    const fetchImpl = async (): Promise<Response> => {
      if (!online) throw new Error('offline');
      return new Response(doc, {status: 200});
    };
    // TTL 0 forces a refetch on every call, so the second call exercises the offline path.
    const identity = new IdentityService(store, {fetchImpl, now: () => NOW, jwksTtlMs: 0});
    expect((await identity.revocations(ISS))?.revocations[0].sub).toBe('u1');
    online = false;
    expect((await identity.revocations(ISS))?.revocations[0].sub).toBe('u1'); // served from last-good cache
  });

  it('fails safe when the document is unreachable cold (no cache, no crash)', async () => {
    await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks, revocationsUrl: REV_URL}]});
    const fetchImpl = async (): Promise<Response> => {
      throw new Error('offline');
    };
    const identity = new IdentityService(store, {fetchImpl, now: () => NOW});
    expect(await identity.revocations(ISS)).toBeNull(); // benign — no crash
    // A token that *would* be revoked is still honoured (short token TTL is the backstop).
    const app = createApp(store, undefined, new PageHub(), {identity});
    const jws = await tokenFor('u1', NOW_S - 2000);
    expect((await app.request('/api/pages', {headers: {[IDENTITY_HEADER]: jws}})).status).toBe(200);
  });

  it('never trusts a forged document fetched from the URL', async () => {
    const attacker = await mintIdentityKeypair('k2'); // not in the trusted JWKS
    const forged = await signRevocations(attacker.privateKey, {iss: ISS, revocations: [{sub: 'u1', since: NOW_S - 1000}]}, 'k2');
    await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks, revocationsUrl: REV_URL}]});
    const identity = new IdentityService(store, {fetchImpl: serveDoc(forged), now: () => NOW});
    expect(await identity.revocations(ISS)).toBeNull(); // bad signature → ignored
    // …so the "revoked" subject's token is still honoured (the forgery can't revoke).
    const app = createApp(store, undefined, new PageHub(), {identity});
    const jws = await tokenFor('u1', NOW_S - 2000);
    expect((await app.request('/api/pages', {headers: {[IDENTITY_HEADER]: jws}})).status).toBe(200);
  });

  it('applies an inline (config-trusted) revocation set without any fetch', async () => {
    const inline: RevocationSet = {iss: ISS, revocations: [{sub: 'u1', since: NOW_S - 1000}]};
    await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks, revocations: inline}]});
    let fetched = 0;
    const fetchImpl = async (): Promise<Response> => {
      fetched += 1;
      return new Response('', {status: 500});
    };
    const identity = new IdentityService(store, {fetchImpl, now: () => NOW});
    const app = createApp(store, undefined, new PageHub(), {identity});
    const jws = await tokenFor('u1', NOW_S - 2000);
    expect((await app.request('/api/pages', {headers: {[IDENTITY_HEADER]: jws}})).status).toBe(401);
    expect(fetched).toBe(0); // inline set is config-trusted — no network
  });
});
