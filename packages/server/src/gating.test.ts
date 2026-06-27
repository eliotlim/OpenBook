/**
 * OB-190 follow-up: gate the content routes the enforcement pass missed
 * (contract `docs/sharing-access-contract-spike-OB-182.md` §1.4 — every content
 * route goes through the default-deny gate).
 *
 * Exercises the HTTP wiring of: whole-instance export/import (instance-writer
 * only), maintenance/compact (instance-writer only), suggestion accept/reject +
 * delete and comment delete (parent-page write), database-row read/write gating
 * on a restricted/members database, and the un-claim guard surfacing as 409.
 */

import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mintIdentityKeypair, signIdentity, type IdentityKeypair, type Jwks} from '@book.dev/sdk';
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

const idFor = (sub: string): Promise<string> =>
  signIdentity(
    kp.privateKey,
    {iss: ISS, sub, name: sub, iat: Math.floor(Date.now() / 1000) - 30, exp: Math.floor(Date.now() / 1000) + 3600, jti: `jti-${sub}-${Math.random()}`},
    kp.publicJwk.kid,
  );

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-gating-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  kp = await mintIdentityKeypair('k1');
  jwks = {keys: [kp.publicJwk]};
  await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], ownerSubject: `${ISS}#owner`});
  await store.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

const app = (embedded = false) => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store), embedded});

const req = (a: ReturnType<typeof app>, method: string, path: string, jws?: string, body?: unknown) =>
  a.request(path, {
    method,
    headers: {...(body !== undefined ? {'Content-Type': 'application/json'} : {}), ...(jws ? {[IDENTITY_HEADER]: jws} : {})},
    ...(body !== undefined ? {body: JSON.stringify(body)} : {}),
  });

describe('whole-instance export/import (instance-writer only)', () => {
  it('GET /api/export: owner 200, viewer 403, guest 403', async () => {
    const a = app();
    expect((await req(a, 'GET', '/api/export', await idFor('owner'))).status).toBe(200);
    expect((await req(a, 'GET', '/api/export', await idFor('viewer'))).status).toBe(403);
    expect((await req(a, 'GET', '/api/export')).status).toBe(403); // anon guest
  });

  it('a viewer cannot exfiltrate restricted content via export', async () => {
    const restr = (await store.upsertPage({name: `secret-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(restr, 'restricted');
    const a = app();
    // The owner sees it in the dump; a viewer is refused the whole route.
    const dump = await (await req(a, 'GET', '/api/export', await idFor('owner'))).json();
    expect(dump.pages.map((p: {id: string}) => p.id)).toContain(restr);
    expect((await req(a, 'GET', '/api/export', await idFor('viewer'))).status).toBe(403);
  });

  it('POST /api/import: owner ok, viewer 403', async () => {
    const a = app();
    const bundle = {mode: 'copy', pages: [], databases: []};
    expect((await req(a, 'POST', '/api/import', await idFor('viewer'), bundle)).status).toBe(403);
    expect((await req(a, 'POST', '/api/import', await idFor('owner'), bundle)).status).toBe(200);
  });
});

describe('maintenance/compact (instance-writer only, DoS shield)', () => {
  it('viewer 403; owner runs (embedded)', async () => {
    expect((await req(app(), 'POST', '/api/maintenance/compact', await idFor('viewer'))).status).toBe(403);
    expect((await req(app(true), 'POST', '/api/maintenance/compact', await idFor('owner'))).status).toBe(200);
  });
});

describe('suggestion + comment routes gate on parent-page write', () => {
  let mem: string;
  let suggestionId: string;
  let commentId: string;

  beforeEach(async () => {
    mem = (await store.upsertPage({name: `mem-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(mem, 'members');
    suggestionId = (
      await store.createSuggestion({pageId: mem, authorKind: 'human', authorName: 'a', kind: 'replace-text', target: {}, before: '', after: '', payload: {}})
    ).id;
    commentId = (await store.createComment({pageId: mem, authorName: 'a', body: []})).id;
  });

  it('PATCH /api/suggestions/:id — stranger 404, viewer 403, owner 200', async () => {
    const a = app();
    expect((await req(a, 'PATCH', `/api/suggestions/${suggestionId}`, await idFor('stranger'), {status: 'accepted'})).status).toBe(404);
    expect((await req(a, 'PATCH', `/api/suggestions/${suggestionId}`, await idFor('viewer'), {status: 'accepted'})).status).toBe(403);
    expect((await req(a, 'PATCH', `/api/suggestions/${suggestionId}`, await idFor('owner'), {status: 'accepted'})).status).toBe(200);
  });

  it('DELETE /api/suggestions/:id — viewer 403, owner 204; a missing id 404', async () => {
    const a = app();
    expect((await req(a, 'DELETE', `/api/suggestions/${suggestionId}`, await idFor('viewer'))).status).toBe(403);
    expect((await req(a, 'DELETE', `/api/suggestions/${suggestionId}`, await idFor('owner'))).status).toBe(204);
    const missing = '00000000-0000-0000-0000-000000000000';
    expect((await req(a, 'DELETE', `/api/suggestions/${missing}`, await idFor('owner'))).status).toBe(404);
  });

  it('DELETE /api/comments/:id — stranger 404, viewer 403, owner 204', async () => {
    const a = app();
    expect((await req(a, 'DELETE', `/api/comments/${commentId}`, await idFor('stranger'))).status).toBe(404);
    expect((await req(a, 'DELETE', `/api/comments/${commentId}`, await idFor('viewer'))).status).toBe(403);
    expect((await req(a, 'DELETE', `/api/comments/${commentId}`, await idFor('owner'))).status).toBe(204);
  });
});

describe('database-row read/write gating (inherits the host page)', () => {
  let dbId: string;
  let rowId: string;

  beforeEach(async () => {
    const host = (await store.upsertPage({name: `db-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(host, 'members');
    dbId = (await store.createDatabase({pageId: host})).id;
    rowId = (await store.createRow(dbId, {name: `row-${seq}`})).id;
  });

  it('GET rows: member 200, non-member 404, owner 200', async () => {
    const a = app();
    expect((await req(a, 'GET', `/api/databases/${dbId}/rows`, await idFor('viewer'))).status).toBe(200);
    expect((await req(a, 'GET', `/api/databases/${dbId}/rows`, await idFor('stranger'))).status).toBe(404);
    expect((await req(a, 'GET', `/api/databases/${dbId}/rows`, await idFor('owner'))).status).toBe(200);
  });

  it('POST row: viewer 403, owner 201; PATCH row: viewer 403, owner 200', async () => {
    const a = app();
    expect((await req(a, 'POST', `/api/databases/${dbId}/rows`, await idFor('viewer'), {})).status).toBe(403);
    expect((await req(a, 'POST', `/api/databases/${dbId}/rows`, await idFor('owner'), {})).status).toBe(201);
    expect((await req(a, 'PATCH', `/api/databases/${dbId}/rows/${rowId}`, await idFor('viewer'), {name: 'x'})).status).toBe(403);
    expect((await req(a, 'PATCH', `/api/databases/${dbId}/rows/${rowId}`, await idFor('owner'), {name: 'x'})).status).toBe(200);
  });
});

describe('un-claim guard surfaces as 409 (not 500)', () => {
  it('PUT /api/instance {ownerSubject:null} by the owner → 409', async () => {
    const res = await req(app(), 'PUT', '/api/instance', await idFor('owner'), {ownerSubject: null});
    expect(res.status).toBe(409);
    expect((await store.getInstanceConfig()).ownerSubject).toBe(`${ISS}#owner`); // unchanged
  });
});
