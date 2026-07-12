/**
 * The loopback-owner hatch + ownership repair + the instance-admin export gate.
 *
 * The desktop reaches its local server over IPC, where principal resolution can
 * only yield `guest | jws` — so on a CLAIMED instance the machine owner is only
 * "the owner" while their account JWS verifies AND matches the pinned
 * `ownerSubject`. A lapsed/stale identity used to demote them to a guest on their
 * own data ("Export failed: you do not have write access", "only the instance
 * owner can change multi-user"). The hatch restores the local-owner rung: the
 * host mints a per-run secret, its IPC bridge stamps `LOCAL_OWNER_HEADER` on
 * webview-originated requests only, and a matching non-forwarded request holds
 * machine-owner authority. Tunnel-forwarded traffic (FORWARDED_HEADER) can never
 * use it, whatever it presents.
 */

import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  FORWARDED_HEADER,
  LOCAL_OWNER_HEADER,
  mintIdentityKeypair,
  signIdentity,
  type IdentityKeypair,
  type InstanceInfo,
  type Jwks,
} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';

const ISS = 'https://account.book.pub';
const SECRET = 'per-run-secret-abc123';

let store: PageStore;
let dir: string;
let seq = 0;
let kp: IdentityKeypair;
let jwks: Jwks;

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-localowner-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  kp = await mintIdentityKeypair('k1');
  jwks = {keys: [kp.publicJwk]};
  await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}]});
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

const appWithHatch = () =>
  createApp(store, undefined, new PageHub(), {identity: new IdentityService(store), localOwnerSecret: SECRET});

const jws = (sub: string, opts: {expired?: boolean} = {}) =>
  signIdentity(
    kp.privateKey,
    {
      iss: ISS,
      sub,
      name: sub,
      iat: Math.floor(Date.now() / 1000) - (opts.expired ? 7200 : 30),
      exp: Math.floor(Date.now() / 1000) + (opts.expired ? -3600 : 3600),
      jti: `jti-${sub}-${Math.random()}`,
    },
    kp.publicJwk.kid,
  );

const local = (extra: Record<string, string> = {}) => ({[LOCAL_OWNER_HEADER]: SECRET, ...extra});

const instanceInfo = async (a: ReturnType<typeof appWithHatch>, headers: Record<string, string> = {}) => {
  const res = await a.request('/api/instance', {headers});
  expect(res.status).toBe(200);
  return (await res.json()) as InstanceInfo;
};

const putInstance = (a: ReturnType<typeof appWithHatch>, body: unknown, headers: Record<string, string> = {}) =>
  a.request('/api/instance', {
    method: 'PUT',
    headers: {'Content-Type': 'application/json', ...headers},
    body: JSON.stringify(body),
  });

describe('the hatch resolves the machine owner', () => {
  beforeEach(async () => {
    await store.claimOwnership(`${ISS}#owner`); // also downgrades guestAccess write → read
  });

  it('a signed-out request with the secret is the local owner, not a guest', async () => {
    const a = appWithHatch();
    const info = await instanceInfo(a, local());
    expect(info.you.verifiedVia).toBe('local');
    expect(info.localOwner).toBe(true);
  });

  it('without the secret the same request is a guest (and localOwner is false)', async () => {
    const a = appWithHatch();
    const info = await instanceInfo(a);
    expect(info.you.kind).toBe('guest');
    expect(info.localOwner).toBe(false);
  });

  it('a wrong secret does not match (still a guest)', async () => {
    const a = appWithHatch();
    const info = await instanceInfo(a, {[LOCAL_OWNER_HEADER]: 'not-the-secret'});
    expect(info.you.kind).toBe('guest');
    expect(info.localOwner).toBe(false);
  });

  it('a FORWARDED request can never use the secret, whatever it presents', async () => {
    const a = appWithHatch();
    const info = await instanceInfo(a, local({[FORWARDED_HEADER]: '1'}));
    expect(info.you.kind).toBe('guest');
    expect(info.localOwner).toBe(false);
  });

  it('with no secret configured the hatch is inert (header alone mints nothing)', async () => {
    const a = createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});
    const res = await a.request('/api/instance', {headers: local()});
    const info = (await res.json()) as InstanceInfo;
    expect(info.you.kind).toBe('guest');
    expect(info.localOwner).toBe(false);
  });

  it('a valid (non-owner) JWS still wins for attribution; the hatch flag stays', async () => {
    const a = appWithHatch();
    const info = await instanceInfo(a, local({[IDENTITY_HEADER]: await jws('somebody')}));
    expect(info.you.verifiedVia).toBe('jws');
    expect(info.you.subject).toBe(`${ISS}#somebody`);
    expect(info.localOwner).toBe(true);
  });

  it('a BAD credential over the hatch degrades to the local owner instead of 401', async () => {
    const a = appWithHatch();
    // Expired token: normally a hard 401 (a bad credential is an error) — but the
    // machine owner must never be locked out of their own instance by it.
    const expired = await jws('owner', {expired: true});
    const info = await instanceInfo(a, local({[IDENTITY_HEADER]: expired}));
    expect(info.you.verifiedVia).toBe('local');
    // Control: the same bad credential without the secret stays a 401.
    const res = await a.request('/api/instance', {headers: {[IDENTITY_HEADER]: expired}});
    expect(res.status).toBe(401);
  });
});

describe('owner-gated policy writes accept the hatch', () => {
  beforeEach(async () => {
    await store.claimOwnership(`${ISS}#owner`);
  });

  it('a signed-out machine owner can change multi-user policy', async () => {
    const a = appWithHatch();
    const res = await putInstance(a, {guestAccess: 'off'}, local());
    expect(res.status).toBe(200);
    expect((await store.getInstanceConfig()).guestAccess).toBe('off');
  });

  it('a signed-in-but-drifted identity can too (the hatch carries the authority)', async () => {
    const a = appWithHatch();
    const res = await putInstance(a, {guestAccess: 'off'}, local({[IDENTITY_HEADER]: await jws('drifted')}));
    expect(res.status).toBe(200);
  });

  it('without the hatch a non-owner still 403s (the gate is not weakened)', async () => {
    const a = appWithHatch();
    const res = await putInstance(a, {guestAccess: 'off'}, {[IDENTITY_HEADER]: await jws('drifted')});
    expect(res.status).toBe(403);
  });
});

describe('ownership repair (claim-once escape hatch)', () => {
  beforeEach(async () => {
    await store.claimOwnership(`${ISS}#old-owner`);
  });

  it('the machine owner re-points ownerSubject to their OWN verified subject', async () => {
    const a = appWithHatch();
    const res = await putInstance(a, {ownerSubject: `${ISS}#new-owner`}, local({[IDENTITY_HEADER]: await jws('new-owner')}));
    expect(res.status).toBe(200);
    expect((await store.getInstanceConfig()).ownerSubject).toBe(`${ISS}#new-owner`);
    // The repaired owner is a full owner: policy writes pass WITHOUT the hatch now.
    const after = await putInstance(a, {guestAccess: 'off'}, {[IDENTITY_HEADER]: await jws('new-owner')});
    expect(after.status).toBe(200);
  });

  it('repair is refused without the hatch (a remote caller cannot re-point)', async () => {
    const a = appWithHatch();
    const res = await putInstance(a, {ownerSubject: `${ISS}#new-owner`}, {[IDENTITY_HEADER]: await jws('new-owner')});
    expect(res.status).toBe(403);
    expect((await store.getInstanceConfig()).ownerSubject).toBe(`${ISS}#old-owner`);
  });

  it('repair only to your OWN subject — never a chosen value', async () => {
    const a = appWithHatch();
    const res = await putInstance(a, {ownerSubject: `${ISS}#someone-else`}, local({[IDENTITY_HEADER]: await jws('new-owner')}));
    expect(res.status).toBe(403);
  });

  it('repair needs a verified identity (signed-out local cannot re-point)', async () => {
    const a = appWithHatch();
    const res = await putInstance(a, {ownerSubject: `${ISS}#new-owner`}, local());
    expect(res.status).toBe(403);
  });

  it('ownerSubject can never be cleared, hatch or not', async () => {
    const a = appWithHatch();
    const res = await putInstance(a, {ownerSubject: null}, local({[IDENTITY_HEADER]: await jws('new-owner')}));
    expect([403, 409]).toContain(res.status);
    expect((await store.getInstanceConfig()).ownerSubject).toBe(`${ISS}#old-owner`);
  });
});

describe('whole-workspace export/import is instance administration', () => {
  const exportLibrary = (a: ReturnType<typeof appWithHatch>, headers: Record<string, string> = {}) =>
    a.request('/api/export', {headers});

  it('unclaimed: the legacy floor applies (anonymous local export still works)', async () => {
    const a = appWithHatch();
    expect((await exportLibrary(a)).status).toBe(200);
  });

  describe('claimed', () => {
    beforeEach(async () => {
      await store.claimOwnership(`${ISS}#owner`);
    });

    it('the machine owner exports even signed-out (the post-upgrade lockout fix)', async () => {
      const a = appWithHatch();
      expect((await exportLibrary(a, local())).status).toBe(200);
    });

    it('the owner JWS exports', async () => {
      const a = appWithHatch();
      expect((await exportLibrary(a, {[IDENTITY_HEADER]: await jws('owner')})).status).toBe(200);
    });

    it('an admin exports', async () => {
      await store.addMember({subject: `${ISS}#adm`, role: 'admin', status: 'active'});
      const a = appWithHatch();
      expect((await exportLibrary(a, {[IDENTITY_HEADER]: await jws('adm')})).status).toBe(200);
    });

    it('a viewer must NOT export the whole workspace', async () => {
      await store.addMember({subject: `${ISS}#view`, role: 'viewer', status: 'active'});
      const a = appWithHatch();
      expect((await exportLibrary(a, {[IDENTITY_HEADER]: await jws('view')})).status).toBe(403);
    });

    it('a guest must NOT export', async () => {
      const a = appWithHatch();
      expect((await exportLibrary(a)).status).toBe(403);
    });

    it('import rides the same gate (viewer 403, machine owner 200)', async () => {
      await store.addMember({subject: `${ISS}#view`, role: 'viewer', status: 'active'});
      const a = appWithHatch();
      const bundle = JSON.stringify({pages: [], databases: []});
      const post = (headers: Record<string, string>) =>
        a.request('/api/import', {method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: bundle});
      expect((await post({[IDENTITY_HEADER]: await jws('view')})).status).toBe(403);
      expect((await post(local())).status).toBe(200);
    });
  });
});
