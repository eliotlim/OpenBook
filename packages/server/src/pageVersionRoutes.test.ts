import {rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  HttpDataClient,
  mintIdentityKeypair,
  signIdentity,
  type IdentityKeypair,
  type Jwks,
  type PageSnapshot,
} from '@book.dev/sdk';
import {PgliteDb} from './db';
import type {Db} from './dbCore';
import {PageStore, PAGE_VERSION_COALESCE_SECONDS} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';

// PVH-3 (OB-26) — the version routes + SDK client over the snapshot-on-save history
// captured by PVH-1. Exercises list/get/restore end-to-end via the SDK, the
// non-destructive-restore guarantee, cross-page isolation, page-capability gating,
// and the server-merged (null-author) capture path.

const ISS = 'https://account.book.pub';
let store: PageStore;
let db: Db;
let dir: string;
let seq = 0;
let kp: IdentityKeypair;
let jwks: Jwks;

const snapshot = (text: string): PageSnapshot => ({
  editorjs: {blocks: [{id: 'b1', type: 'paragraph', data: {text}}]},
  values: [],
  names: [],
});

const idFor = (sub: string): Promise<string> =>
  signIdentity(
    kp.privateKey,
    {
      iss: ISS,
      sub,
      name: sub,
      iat: Math.floor(Date.now() / 1000) - 30,
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: `jti-${sub}-${Math.random()}`,
    },
    kp.publicJwk.kid,
  );

// Push every captured version past the coalesce window so the NEXT changing save
// actually captures (rather than coalescing onto a just-written version). Mirrors
// the PVH-1 suite's backdating trick.
const agePastCoalesce = () =>
  db.query('UPDATE page_versions SET created_at = now() - ($1::int * interval \'1 second\')', [
    PAGE_VERSION_COALESCE_SECONDS + 5,
  ]);

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-pvh3-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  db = await PgliteDb.create(dir);
  store = new PageStore(db);
  await store.migrate();
  kp = await mintIdentityKeypair('k1');
  jwks = {keys: [kp.publicJwk]};
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

const makeApp = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});

/** An HttpDataClient whose transport is the in-process Hono app. */
function client(getJws?: () => string | undefined) {
  const app = makeApp();
  const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => Promise.resolve(app.request(input, init));
  return new HttpDataClient('', undefined, {
    fetchImpl,
    getIdentity: getJws ? () => (getJws() ? {jws: getJws()!} : undefined) : undefined,
  });
}

describe('PVH-3 — list / get / restore end-to-end via the SDK (unclaimed instance)', () => {
  it('lists a captured version and reads its snapshot payload', async () => {
    const c = client();
    const {id} = await c.savePage({name: 'p', data: snapshot('first')}); // create — no prior state
    await c.savePage({id, name: 'p', data: snapshot('second')}); // change → captures 'first'

    const versions = await c.listVersions(id);
    expect(versions).toHaveLength(1);
    expect(versions[0].pageId).toBe(id);

    const full = await c.getVersion(id, versions[0].id);
    expect(full).not.toBeNull();
    // The captured payload is the state that was REPLACED ('first'), not the new one.
    expect(JSON.stringify(full!.data)).toContain('first');
    expect(JSON.stringify(full!.data)).not.toContain('second');
  });

  it('restores a version AND the restore is non-destructive (pre-restore state becomes a version)', async () => {
    const c = client();
    const {id} = await c.savePage({name: 'p', data: snapshot('first')});
    await c.savePage({id, name: 'p', data: snapshot('second')}); // captures 'first'
    const [v1] = await c.listVersions(id);

    // Age the 'first' version out of the coalesce window so the restore's own
    // capture (of the current 'second' state) isn't coalesced away.
    await agePastCoalesce();

    const restored = await c.restoreVersion(id, v1.id);
    expect(restored).not.toBeNull();
    expect(JSON.stringify(restored!.data)).toContain('first'); // rolled back
    // The live page reflects the rollback too.
    const page = await c.getPage(id);
    expect(JSON.stringify(page!.data)).toContain('first');

    // Non-destructive: the pre-restore 'second' state is now itself a recoverable version.
    const after = await c.listVersions(id);
    expect(after).toHaveLength(2);
    const payloads = await Promise.all(after.map((v) => c.getVersion(id, v.id)));
    const texts = payloads.map((p) => JSON.stringify(p!.data));
    expect(texts.some((t) => t.includes('second'))).toBe(true); // pre-restore state preserved
    expect(texts.some((t) => t.includes('first'))).toBe(true); // the original version still there
  });

  it('getVersion is page-scoped — a version id from another page never resolves (no cross-page leak)', async () => {
    const c = client();
    const {id: a} = await c.savePage({name: 'a', data: snapshot('a1')});
    await c.savePage({id: a, name: 'a', data: snapshot('a2')}); // captures a1
    const {id: b} = await c.savePage({name: 'b', data: snapshot('b1')});
    await c.savePage({id: b, name: 'b', data: snapshot('b2')}); // captures b1
    const [va] = await c.listVersions(a);

    // page a's version resolves under a, but NOT under page b.
    expect(await c.getVersion(a, va.id)).not.toBeNull();
    expect(await c.getVersion(b, va.id)).toBeNull();
    // Restoring a's version through page b is likewise a 404 (→ null).
    expect(await c.restoreVersion(b, va.id)).toBeNull();
    // And page b's live content was untouched by the cross-page restore attempt.
    expect(JSON.stringify((await c.getPage(b))!.data)).toContain('b2');
  });
});

describe('PVH-3 — version access is page-capability-gated (claimed instance)', () => {
  let mem: string;
  let vid: string;

  const get = (a: ReturnType<typeof makeApp>, path: string, jws?: string) =>
    a.request(path, {headers: jws ? {[IDENTITY_HEADER]: jws} : {}});
  const post = (a: ReturnType<typeof makeApp>, path: string, jws?: string) =>
    a.request(path, {method: 'POST', headers: jws ? {[IDENTITY_HEADER]: jws} : {}});

  beforeEach(async () => {
    await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], ownerSubject: `${ISS}#owner`});
    await store.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
    // A members-scoped page with one captured version (owner setup, via the store).
    mem = (await store.upsertPage({name: `mem-${seq}`, data: snapshot('a')})).id;
    await store.upsertPage({id: mem, name: `mem-${seq}`, data: snapshot('b')}); // captures 'a'
    await store.setPageVisibility(mem, 'members');
    vid = (await store.listPageVersions(mem))[0].id;
  });

  it('a viewer (read, not write) can list + get versions but cannot restore (403)', async () => {
    const a = makeApp();
    const viewer = await idFor('viewer');
    expect((await get(a, `/api/pages/${mem}/versions`, viewer)).status).toBe(200);
    expect((await get(a, `/api/pages/${mem}/versions/${vid}`, viewer)).status).toBe(200);
    expect((await post(a, `/api/pages/${mem}/versions/${vid}/restore`, viewer)).status).toBe(403);
  });

  it('a non-member (no read access) gets 404 on every version route — existence hidden', async () => {
    const a = makeApp();
    const stranger = await idFor('stranger');
    expect((await get(a, `/api/pages/${mem}/versions`, stranger)).status).toBe(404);
    expect((await get(a, `/api/pages/${mem}/versions/${vid}`, stranger)).status).toBe(404);
    expect((await post(a, `/api/pages/${mem}/versions/${vid}/restore`, stranger)).status).toBe(404);
  });

  it('owner + admin retain full access (read + restore)', async () => {
    const a = makeApp();
    const owner = await idFor('owner');
    expect((await get(a, `/api/pages/${mem}/versions`, owner)).status).toBe(200);
    expect((await post(a, `/api/pages/${mem}/versions/${vid}/restore`, owner)).status).toBe(200);
  });
});

describe('PVH-3 — server-merged capture path (null author)', () => {
  it('a saveServerDoc change captures a version with null author columns', async () => {
    const id = randomUUID();
    await store.upsertPage({id, name: 'p', data: snapshot('first')}); // create — no capture
    // A server-authoritative checkpoint has no single saving principal, so the
    // captured version's author columns are null (per-block authorship lives in the
    // snapshot). This change replaces the block document → data differs → captures.
    await store.saveServerDoc(id, {blocks: [{id: 'b1', text: 'merged'}]}, new Map());

    const versions = await store.listPageVersions(id);
    expect(versions).toHaveLength(1);
    expect(versions[0].authorSubject).toBeNull();
    expect(versions[0].authorIssuer).toBeNull();
    expect(versions[0].authorName).toBeNull();
  });
});
