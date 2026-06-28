/**
 * CAS owner-claim + the exposure boot backstop (OB-191; contract
 * `docs/sharing-access-contract-spike-OB-182.md` §2.6 B2).
 *
 *  - `claimOwnership` binds `ownerSubject` via an atomic compare-and-set, so two
 *    concurrent claims can never both win (the TOCTOU close).
 *  - `PUT /api/instance` routes the claim through that CAS, binding the *verified*
 *    claimer's subject; a second claim 409s; a guest can't claim; back-compat for
 *    the unclaimed loopback path is preserved.
 *  - `assertExposureSafe` (the boot backstop) refuses an unclaimed + ungated
 *    non-loopback bind, and `startServer` enforces it.
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
import {assertExposureSafe, isLoopbackHost, startServer} from './server';

const ISS = 'https://account.book.pub';
let store: PageStore;
let dir: string;
let seq = 0;
let kp: IdentityKeypair;
let jwks: Jwks;

const idFor = (sub: string, over: Partial<IdentityClaims> = {}): Promise<string> =>
  signIdentity(
    kp.privateKey,
    {iss: ISS, sub, name: sub, iat: Math.floor(Date.now() / 1000) - 30, exp: Math.floor(Date.now() / 1000) + 3600, jti: `jti-${sub}-${Math.random()}`, ...over},
    kp.publicJwk.kid,
  );

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-claim-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  kp = await mintIdentityKeypair('k1');
  jwks = {keys: [kp.publicJwk]};
  // Trust the dev issuer so the route can verify a claimer's jws.
  await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}]});
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

const app = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});

const putInstance = (a: ReturnType<typeof app>, body: unknown, jws?: string) =>
  a.request('/api/instance', {
    method: 'PUT',
    headers: {'Content-Type': 'application/json', ...(jws ? {[IDENTITY_HEADER]: jws} : {})},
    body: JSON.stringify(body),
  });

describe('claimOwnership CAS (store, §2.6 B2)', () => {
  it('two concurrent claims → exactly one wins; the loser observes the winner', async () => {
    const [a, b] = await Promise.all([
      store.claimOwnership(`${ISS}#alice`),
      store.claimOwnership(`${ISS}#bob`),
    ]);
    const winners = [a, b].filter((r) => r.claimed);
    expect(winners).toHaveLength(1);
    const owner = winners[0].config.ownerSubject;
    expect(owner === `${ISS}#alice` || owner === `${ISS}#bob`).toBe(true);
    // Both calls now agree on the persisted owner.
    expect((await store.getInstanceConfig()).ownerSubject).toBe(owner);
    expect(a.config.ownerSubject).toBe(owner);
    expect(b.config.ownerSubject).toBe(owner);
  });

  it('the claim atomically applies the §2.6 bootstrap (members + write→read downgrade)', async () => {
    await store.updateInstanceConfig({guestAccess: 'write'});
    const {config, claimed} = await store.claimOwnership(`${ISS}#alice`);
    expect(claimed).toBe(true);
    expect(config.defaultVisibility).toBe('members');
    expect(config.guestAccess).toBe('read'); // downgraded from 'write'
    const persisted = await store.getInstanceConfig();
    expect(persisted.ownerSubject).toBe(`${ISS}#alice`);
    expect(persisted.guestAccess).toBe('read');
  });

  it('a re-claim is a no-op (claim-once), and existing policy is preserved', async () => {
    await store.updateInstanceConfig({guestAccess: 'off', audience: 'https://h.test'});
    await store.claimOwnership(`${ISS}#alice`);
    const second = await store.claimOwnership(`${ISS}#mallory`);
    expect(second.claimed).toBe(false);
    expect(second.config.ownerSubject).toBe(`${ISS}#alice`);
    const cfg = await store.getInstanceConfig();
    expect(cfg.guestAccess).toBe('off'); // 'off' is NOT loosened by the claim
    expect(cfg.audience).toBe('https://h.test'); // unrelated policy preserved
  });
});

describe('PUT /api/instance owner-claim (route)', () => {
  it('binds the verified claimer’s subject (not the request body)', async () => {
    const a = app();
    const first = await putInstance(a, {ownerSubject: 'ignored-by-server'}, await idFor('alice'));
    expect(first.status).toBe(200);
    expect((await first.json()).ownerSubject).toBe(`${ISS}#alice`); // bound to the verified subject, not the body

    // Once claimed, a later claim by a different identity is rejected (not owner).
    const second = await putInstance(a, {ownerSubject: 'whatever'}, await idFor('bob'));
    expect(second.status).toBe(403);
    expect((await store.getInstanceConfig()).ownerSubject).toBe(`${ISS}#alice`);
  });

  it('two concurrent route claims → exactly one wins; the loser is rejected', async () => {
    const a = app();
    const [r1, r2] = await Promise.all([
      putInstance(a, {ownerSubject: 'x'}, await idFor('alice')),
      putInstance(a, {ownerSubject: 'x'}, await idFor('bob')),
    ]);
    const statuses = [r1.status, r2.status].sort();
    // One 200 (the winner); the loser is rejected (409 if it raced past the read,
    // 403 if it observed the claim first). Never two successful claims.
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.some((s) => s === 409 || s === 403)).toBe(true);
    const owner = (await store.getInstanceConfig()).ownerSubject;
    expect(owner === `${ISS}#alice` || owner === `${ISS}#bob`).toBe(true);
  });

  it('a guest cannot claim ownership (403)', async () => {
    const res = await putInstance(app(), {ownerSubject: 'x'});
    expect(res.status).toBe(403);
    expect((await store.getInstanceConfig()).ownerSubject).toBeUndefined();
  });

  it('a non-claim policy update on an unclaimed instance still works (back-compat)', async () => {
    const res = await putInstance(app(), {guestAccess: 'read'});
    expect(res.status).toBe(200);
    expect((await res.json()).guestAccess).toBe('read');
    expect((await store.getInstanceConfig()).ownerSubject).toBeUndefined(); // still unclaimed
  });

  it('a claim may carry extra policy fields, applied after the CAS', async () => {
    const res = await putInstance(app(), {ownerSubject: 'x', guestAccess: 'off'}, await idFor('alice'));
    expect(res.status).toBe(200);
    const cfg = await store.getInstanceConfig();
    expect(cfg.ownerSubject).toBe(`${ISS}#alice`);
    expect(cfg.guestAccess).toBe('off');
  });
});

describe('exposure boot backstop (assertExposureSafe, §2.6)', () => {
  it('classifies loopback hosts', () => {
    for (const h of ['127.0.0.1', '127.0.0.5', 'localhost', '::1', '[::1]', 'LOCALHOST']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    for (const h of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  it('refuses an unclaimed + ungated non-loopback bind, and allows the safe variants', () => {
    // The forbidden state: public bind, unclaimed, no token.
    expect(() => assertExposureSafe({host: '0.0.0.0', hasAccessToken: false, ownerSubject: undefined})).toThrow(/non-loopback/);
    // Any one of: loopback host / an access token / a claimed owner makes it safe.
    expect(() => assertExposureSafe({host: '127.0.0.1', hasAccessToken: false, ownerSubject: undefined})).not.toThrow();
    expect(() => assertExposureSafe({host: '0.0.0.0', hasAccessToken: true, ownerSubject: undefined})).not.toThrow();
    expect(() => assertExposureSafe({host: '0.0.0.0', hasAccessToken: false, ownerSubject: `${ISS}#owner`})).not.toThrow();
    // The override downgrades the refusal to a warning (spike: "or loudly warn").
    expect(() => assertExposureSafe({host: '0.0.0.0', hasAccessToken: false, ownerSubject: undefined, allowOverride: true})).not.toThrow();
  });

  it('startServer rejects an unclaimed public bind (no listener is opened)', async () => {
    const bootDir = join(tmpdir(), `ob-boot-${process.pid}-${seq}`);
    rmSync(bootDir, {recursive: true, force: true});
    await expect(startServer({dataDir: bootDir, host: '0.0.0.0', port: 0})).rejects.toThrow(/non-loopback/);
    rmSync(bootDir, {recursive: true, force: true});
  });

  it('startServer allows an unclaimed loopback bind (back-compat) and closes cleanly', async () => {
    const bootDir = join(tmpdir(), `ob-boot-ok-${process.pid}-${seq}`);
    rmSync(bootDir, {recursive: true, force: true});
    const server = await startServer({dataDir: bootDir, host: '127.0.0.1', port: 0});
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    await server.close();
    rmSync(bootDir, {recursive: true, force: true});
  });
});
