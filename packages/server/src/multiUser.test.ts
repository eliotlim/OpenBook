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

const ISS = 'https://account.book.pub';
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
      jti: `jti-${sub}`,
      ...over,
    },
    kp.publicJwk.kid,
  );

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-mu-test-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  kp = await mintIdentityKeypair('k1');
  jwks = {keys: [kp.publicJwk]};
  // Trust the dev issuer (inline JWKS → offline-capable).
  await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}]});
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

const appWithIdentity = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});

describe('guest-access gate', () => {
  it('allows guest reads + writes by default (guestAccess=write)', async () => {
    const app = appWithIdentity();
    expect((await app.request('/api/pages')).status).toBe(200);
    const res = await app.request('/api/pages', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: pageBody(`g-write-${seq}`),
    });
    expect(res.status).toBe(201);
  });

  it('read-only blocks guest writes but allows reads', async () => {
    await store.updateInstanceConfig({guestAccess: 'read'});
    const app = appWithIdentity();
    expect((await app.request('/api/pages')).status).toBe(200);
    const res = await app.request('/api/pages', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: pageBody(`g-ro-${seq}`),
    });
    expect(res.status).toBe(403);
  });

  it('off blocks guest reads entirely', async () => {
    await store.updateInstanceConfig({guestAccess: 'off'});
    const app = appWithIdentity();
    expect((await app.request('/api/pages')).status).toBe(401);
  });

  it('a verified user may write even when guest access is off', async () => {
    await store.updateInstanceConfig({guestAccess: 'off'});
    const app = appWithIdentity();
    const jws = await idFor('alice');
    const res = await app.request('/api/pages', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', [IDENTITY_HEADER]: jws},
      body: pageBody(`u-write-${seq}`),
    });
    expect(res.status).toBe(201);
  });
});

describe('identity verification', () => {
  it('rejects an expired assertion with 401', async () => {
    const app = appWithIdentity();
    const jws = await idFor('bob', {exp: Math.floor(Date.now() / 1000) - 3600});
    const res = await app.request('/api/pages', {headers: {[IDENTITY_HEADER]: jws}});
    expect(res.status).toBe(401);
  });

  it('rejects an assertion from an untrusted issuer', async () => {
    const app = appWithIdentity();
    const jws = await idFor('mallory', {iss: 'https://evil.example'});
    const res = await app.request('/api/pages', {headers: {[IDENTITY_HEADER]: jws}});
    expect(res.status).toBe(401);
  });

  it('GET /api/instance reports who you are', async () => {
    const app = appWithIdentity();
    const jws = await idFor('carol');
    const asUser = await (await app.request('/api/instance', {headers: {[IDENTITY_HEADER]: jws}})).json();
    expect(asUser.you).toMatchObject({kind: 'user', subject: `${ISS}#carol`, verifiedVia: 'jws'});
    expect(asUser.trustedIssuers).toContain(ISS);
    const asGuest = await (await app.request('/api/instance')).json();
    expect(asGuest.you).toMatchObject({kind: 'guest', verifiedVia: 'guest'});
  });
});

describe('change provenance (edit log)', () => {
  it('attributes a guest write to a guest in the edit log', async () => {
    const app = appWithIdentity();
    const created = await (
      await app.request('/api/pages', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-OpenBook-Guest-Name': 'Caryl'},
        body: pageBody(`prov-guest-${seq}`),
      })
    ).json();
    const edits = await store.listEdits(created.id);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({kind: 'page.create', verifiedVia: 'guest', authorName: 'Caryl'});
  });

  it('attributes a verified write to the user + records the credential', async () => {
    const app = appWithIdentity();
    const jws = await idFor('dana');
    const created = await (
      await app.request('/api/pages', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', [IDENTITY_HEADER]: jws},
        body: pageBody(`prov-user-${seq}`),
      })
    ).json();
    // Edit-log write is fire-after-commit; give the microtask a tick to land.
    await new Promise((r) => setTimeout(r, 25));
    const edits = await store.listEdits(created.id);
    expect(edits[0]).toMatchObject({
      kind: 'page.create',
      verifiedVia: 'jws',
      authorSubject: `${ISS}#dana`,
      authorIssuer: ISS,
      assertionKid: 'k1',
      assertionJti: 'jti-dana',
    });
  });

  it('exposes the edit log over GET /api/pages/:id/edits', async () => {
    const app = appWithIdentity();
    const created = await (
      await app.request('/api/pages', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: pageBody(`prov-http-${seq}`),
      })
    ).json();
    await app.request(`/api/pages/${created.id}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id: created.id, name: `prov-http-${seq}`, data: {editorjs: {blocks: [{type: 'paragraph', data: {text: 'hi'}}]}, values: [], names: []}}),
    });
    await new Promise((r) => setTimeout(r, 25));
    const res = await app.request(`/api/pages/${created.id}/edits`);
    expect(res.status).toBe(200);
    const edits = await res.json();
    expect(edits.map((e: {kind: string}) => e.kind)).toEqual(expect.arrayContaining(['page.create', 'page.save']));
  });
});

describe('review-layer author identity', () => {
  const createPage = async (app: ReturnType<typeof appWithIdentity>, headers: Record<string, string>) =>
    (await app.request('/api/pages', {method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: pageBody(`rev-${seq}`)})).json();

  it('stamps the verified principal on a suggestion', async () => {
    const app = appWithIdentity();
    const jws = await idFor('iris');
    const page = await createPage(app, {[IDENTITY_HEADER]: jws});
    const sug = await (
      await app.request(`/api/pages/${page.id}/suggestions`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', [IDENTITY_HEADER]: jws},
        body: JSON.stringify({
          pageId: page.id,
          authorKind: 'human',
          authorName: 'Iris',
          kind: 'replace-text',
          target: {blockId: 'b1'},
          before: 'a',
          after: 'b',
          payload: {},
        }),
      })
    ).json();
    expect(sug).toMatchObject({authorName: 'Iris', authorSubject: `${ISS}#iris`, authorVerified: 'jws'});
  });

  it('stamps a guest on a comment', async () => {
    const app = appWithIdentity();
    const page = await createPage(app, {'X-OpenBook-Guest-Name': 'Caryl'});
    const com = await (
      await app.request(`/api/pages/${page.id}/comments`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-OpenBook-Guest-Name': 'Caryl'},
        body: JSON.stringify({pageId: page.id, authorName: 'Caryl', body: [{t: 'hi'}], blockId: 'b1'}),
      })
    ).json();
    expect(com).toMatchObject({authorName: 'Caryl', authorVerified: 'guest'});
  });
});

describe('audience binding (OB-177)', () => {
  it('rejects a token scoped to a different server and accepts a matching one', async () => {
    await store.updateInstanceConfig({audience: 'https://this-server.example'});
    const app = appWithIdentity();
    const wrong = await idFor('alice', {aud: 'https://other.example'});
    expect((await app.request('/api/pages', {headers: {[IDENTITY_HEADER]: wrong}})).status).toBe(401);
    const right = await idFor('alice', {aud: 'https://this-server.example'});
    expect((await app.request('/api/pages', {headers: {[IDENTITY_HEADER]: right}})).status).toBe(200);
  });

  it('advertises its audience via GET /api/instance', async () => {
    await store.updateInstanceConfig({audience: 'https://this-server.example'});
    const info = await (await appWithIdentity().request('/api/instance')).json();
    expect(info.audience).toBe('https://this-server.example');
  });
});

describe('instance policy ownership', () => {
  it('locks policy changes to the owner once claimed', async () => {
    await store.updateInstanceConfig({ownerSubject: `${ISS}#owner`});
    const app = appWithIdentity();
    // A guest cannot change policy now.
    const guestPut = await app.request('/api/instance', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({guestAccess: 'off'}),
    });
    expect(guestPut.status).toBe(403);
    // The owner can.
    const ownerJws = await idFor('owner');
    const ownerPut = await app.request('/api/instance', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', [IDENTITY_HEADER]: ownerJws},
      body: JSON.stringify({guestAccess: 'read'}),
    });
    expect(ownerPut.status).toBe(200);
    expect((await ownerPut.json()).guestAccess).toBe('read');
  });
});
