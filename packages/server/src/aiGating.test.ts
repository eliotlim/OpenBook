/**
 * Per-principal gating of the AI + maintenance subsystems (OB-190 follow-up,
 * Sasha's security review). These routes live OUTSIDE the core content-route
 * gate, but on a shared instance with AI enabled they could still leak across
 * the per-page access model:
 *
 *  - `POST /api/ai/search` ranks across EVERY indexed page → results must be
 *    filtered to the pages the caller may read (no restricted/members snippets).
 *  - `POST /api/agent/chat` injects the viewed page as ambient context → that
 *    fetch must be access-gated (`getPageFor`), not raw.
 *  - `POST /api/ai/index` rebuilds the whole-workspace index → owner/admin only.
 *  - `GET/POST /api/backups*` expose the backup folder/counts and trigger
 *    snapshot work → owner/admin only.
 *
 * Scope assumption: AI is off/mock by default and, when enabled, is normally an
 * operator feature; we still default to GATING (the safe posture) so a shared
 * instance can't be turned into a cross-page read oracle.
 */

import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  signIdentity,
  mintIdentityKeypair,
  type IdentityClaims,
  type IdentityKeypair,
  type Jwks,
  type Principal,
} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {AiService} from './ai/service';
import {BackupScheduler} from './backups';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';

const ISS = 'https://account.book.pub';
let store: PageStore;
let db: PgliteDb;
let dir: string;
let backupDir: string;
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

const principal = (sub: string): Principal => ({
  kind: 'user',
  subject: `${ISS}#${sub}`,
  issuer: ISS,
  name: sub,
  verifiedVia: 'jws',
});

const aiService = () => new AiService(db, join(dir, 'models'));

const appWith = (opts: {ai?: AiService; backups?: BackupScheduler} = {}) =>
  createApp(store, opts.ai, new PageHub(), {identity: new IdentityService(store), backups: opts.backups});

/** Trust the dev issuer + claim the instance under `${ISS}#owner` (no claimOwnership
 *  downgrade — guestAccess stays at the default so public pages stay guest-readable). */
const claim = () => store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], ownerSubject: `${ISS}#owner`});

const post = (app: ReturnType<typeof appWith>, path: string, body: unknown, jws?: string) =>
  app.request(path, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...(jws ? {[IDENTITY_HEADER]: jws} : {})},
    body: JSON.stringify(body),
  });

const get = (app: ReturnType<typeof appWith>, path: string, jws?: string) =>
  app.request(path, {headers: jws ? {[IDENTITY_HEADER]: jws} : {}});

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-aigate-${process.pid}-${seq}`);
  backupDir = join(tmpdir(), `ob-aigate-backups-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  rmSync(backupDir, {recursive: true, force: true});
  db = await PgliteDb.create(dir);
  store = new PageStore(db);
  await store.migrate();
  kp = await mintIdentityKeypair('k1');
  jwks = {keys: [kp.publicJwk]};
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
  rmSync(backupDir, {recursive: true, force: true});
});

describe('ai/search results are filtered per principal', () => {
  // A shared, distinctive token in every page TITLE so one query matches them all;
  // visibility/ACL then decides who actually gets each snippet back.
  const TOKEN = 'zebraql';
  let pub: string;
  let mem: string;
  let restr: string;

  beforeEach(async () => {
    await claim();
    await store.addMember({subject: `${ISS}#admin`, role: 'admin', status: 'active'});
    await store.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
    pub = (await store.upsertPage({name: `${TOKEN}-public-${seq}`, data: snapshot()})).id;
    mem = (await store.upsertPage({name: `${TOKEN}-members-${seq}`, data: snapshot()})).id;
    restr = (await store.upsertPage({name: `${TOKEN}-restricted-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(pub, 'public');
    await store.setPageVisibility(mem, 'members');
    await store.setPageVisibility(restr, 'restricted');
    await store.setPageAcl(restr, {subject: `${ISS}#granted`, level: 'read'});
  });

  const searchIds = async (app: ReturnType<typeof appWith>, jws?: string): Promise<string[]> => {
    const res = await post(app, '/api/ai/search', {query: TOKEN, limit: 25}, jws);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {results: Array<{pageId: string}>};
    return body.results.map((r) => r.pageId);
  };

  it('the owner sees every matching page', async () => {
    const app = appWith({ai: aiService()});
    const ids = await searchIds(app, await idFor('owner'));
    expect(new Set(ids)).toEqual(new Set([pub, mem, restr]));
  });

  it('a member viewer sees public + members but NOT the restricted page', async () => {
    const app = appWith({ai: aiService()});
    const ids = await searchIds(app, await idFor('viewer'));
    expect(ids).toContain(pub);
    expect(ids).toContain(mem);
    expect(ids).not.toContain(restr);
  });

  it('a jws non-member sees only the public page (no members/restricted snippets)', async () => {
    const app = appWith({ai: aiService()});
    const ids = await searchIds(app, await idFor('stranger'));
    expect(ids).toEqual([pub]);
  });

  it('an ACL grantee sees the restricted page it was shared, but not the members page', async () => {
    const app = appWith({ai: aiService()});
    const ids = await searchIds(app, await idFor('granted'));
    expect(ids).toContain(pub);
    expect(ids).toContain(restr);
    expect(ids).not.toContain(mem);
  });

  it('an anonymous guest sees only the public page', async () => {
    const app = appWith({ai: aiService()});
    const ids = await searchIds(app); // no identity → guest
    expect(ids).toEqual([pub]);
  });
});

describe('ai/index (global rebuild) is owner/admin-gated', () => {
  beforeEach(async () => {
    await claim();
    await store.addMember({subject: `${ISS}#admin`, role: 'admin', status: 'active'});
    await store.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
    await store.upsertPage({name: `idx-${seq}`, data: snapshot()});
  });

  it('owner + admin may rebuild; a viewer, non-member, and guest are denied (403)', async () => {
    const app = appWith({ai: aiService()});
    expect((await post(app, '/api/ai/index', {}, await idFor('owner'))).status).toBe(200);
    expect((await post(app, '/api/ai/index', {}, await idFor('admin'))).status).toBe(200);
    expect((await post(app, '/api/ai/index', {}, await idFor('viewer'))).status).toBe(403);
    expect((await post(app, '/api/ai/index', {}, await idFor('stranger'))).status).toBe(403);
    expect((await post(app, '/api/ai/index', {})).status).toBe(403); // guest
  });
});

describe('agent/chat ambient page context is access-gated', () => {
  let restr: string;

  beforeEach(async () => {
    await claim();
    await store.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
    restr = (await store.upsertPage({name: `secret-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(restr, 'restricted');
  });

  it('getPageFor — the accessor the route now uses — hides the page from a non-member', async () => {
    // The raw store still has the page; the access-aware accessor gates it. This is
    // exactly the swap the route makes when building the agent's ambient context.
    expect(await store.getPage(restr)).not.toBeNull();
    expect(await store.getPageFor(principal('owner'), restr)).not.toBeNull();
    expect(await store.getPageFor(principal('stranger'), restr)).toBeNull();
    expect(await store.getPageFor(principal('viewer'), restr)).toBeNull(); // member, but not a grantee
  });

  it('a non-member can still call agent/chat with a restricted pageId — it just gets no page context', async () => {
    // provider 'off' → the run exercises the (now access-gated) context build, then
    // streams a clean error+done frame. The request must not 404 or surface the page.
    const app = appWith({ai: aiService()});
    const res = await post(
      app,
      '/api/agent/chat',
      {messages: [{role: 'user', content: 'summarise this'}], pageId: restr},
      await idFor('stranger'),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"done":true');
  });
});

describe('backup routes are owner/admin-gated', () => {
  let app: ReturnType<typeof appWith>;

  beforeEach(async () => {
    await claim();
    await store.addMember({subject: `${ISS}#admin`, role: 'admin', status: 'active'});
    await store.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
    await store.upsertPage({name: `bk-${seq}`, data: snapshot()});
    app = appWith({backups: new BackupScheduler(store, {defaultDir: backupDir})});
  });

  it('GET status is served to owner/admin and withheld (403) from viewer/non-member/guest', async () => {
    expect((await get(app, '/api/backups', await idFor('owner'))).status).toBe(200);
    expect((await get(app, '/api/backups', await idFor('admin'))).status).toBe(200);
    expect((await get(app, '/api/backups', await idFor('viewer'))).status).toBe(403);
    expect((await get(app, '/api/backups', await idFor('stranger'))).status).toBe(403);
    expect((await get(app, '/api/backups')).status).toBe(403); // guest
  });

  it('POST run is owner/admin-gated (no unauthorized snapshot DoS)', async () => {
    expect((await post(app, '/api/backups/run', {cadence: 'daily'}, await idFor('owner'))).status).toBe(200);
    expect((await post(app, '/api/backups/run', {cadence: 'daily'}, await idFor('admin'))).status).toBe(200);
    expect((await post(app, '/api/backups/run', {cadence: 'daily'}, await idFor('viewer'))).status).toBe(403);
    expect((await post(app, '/api/backups/run', {cadence: 'daily'}, await idFor('stranger'))).status).toBe(403);
    expect((await post(app, '/api/backups/run', {cadence: 'daily'})).status).toBe(403); // guest
  });
});

describe('POST /api/pages closes the existence oracle (N6)', () => {
  let restr: string;

  beforeEach(async () => {
    await claim();
    await store.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
    restr = (await store.upsertPage({name: `oracle-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(restr, 'restricted');
  });

  it('a non-creator gets the SAME 403 for an existing-private id and a nonexistent id', async () => {
    const app = appWith();
    const existing = await post(app, '/api/pages', {id: restr, name: 'x', data: snapshot()}, await idFor('viewer'));
    const missing = await post(app, '/api/pages', {id: crypto.randomUUID(), name: 'x', data: snapshot()}, await idFor('viewer'));
    expect(existing.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(existing.status).toBe(missing.status); // indistinguishable → no oracle
  });

  it('the owner still updates an existing page and creates a new one', async () => {
    const app = appWith();
    expect((await post(app, '/api/pages', {id: restr, name: 'renamed', data: snapshot()}, await idFor('owner'))).status).toBe(201);
    expect((await post(app, '/api/pages', {name: `fresh-${seq}`, data: snapshot()}, await idFor('owner'))).status).toBe(201);
  });
});
