/**
 * Agent-edits policy contract suite (AGED-1). Exercises the CONTRACT surface only —
 * defaults, the migration, the store accessors, `PUT/GET /api/pages/:id/agent-edits`
 * (jws-only write, read-gated read, enum validation, edit-log), the instance-level
 * `PUT /api/instance {agentEdits}` (enum-validated, owner-only), and that
 * `GET /api/instance` exposes the mode. No enforcement / no agent behaviour (AGED-2/3/4).
 */

import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  signIdentity,
  mintIdentityKeypair,
  type AgentTokenScope,
  type IdentityKeypair,
  type Jwks,
} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';
import {AGENT_API_SETTING_KEY} from './agentTokens';

const ISS = 'https://account.book.pub';
const OWNER = `${ISS}#owner`;
let store: PageStore;
let dir: string;
let seq = 0;
let kp: IdentityKeypair;
let jwks: Jwks;

const snapshot = () => ({editorjs: {blocks: []}, values: [], names: []});

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

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-aged-${process.pid}-${seq}`);
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

const app = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});
const bearer = (token: string) => ({Authorization: `Bearer ${token}`});
const owner = async () => ({'Content-Type': 'application/json', [IDENTITY_HEADER]: await idFor('owner')});
const claim = () => store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], ownerSubject: OWNER});
const enableAgentApi = () => store.setSetting(AGENT_API_SETTING_KEY, {enabled: true});

async function mintPat(scope: AgentTokenScope): Promise<string> {
  const {generateAgentToken} = await import('./agentTokens');
  const {token, hash, preview} = generateAgentToken();
  await store.createAgentToken({
    name: 'test',
    tokenHash: hash,
    preview,
    subject: OWNER,
    issuer: ISS,
    scope,
    createdBy: 'test',
    expiresAt: null,
  });
  return token;
}

const tick = () => new Promise((r) => setTimeout(r, 25));

// ── Defaults + migration ──────────────────────────────────────────────────────────

describe('agent-edits defaults + migration (AGED-1)', () => {
  it('a fresh instance defaults agentEdits to "suggest"', async () => {
    expect((await store.getInstanceConfig()).agentEdits).toBe('suggest');
    const info = await (await app().request('/api/instance')).json();
    expect(info.agentEdits).toBe('suggest');
  });

  it('a new page defaults its policy to "inherit"', async () => {
    const {id} = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    expect(await store.getPageAgentEdits(id)).toBe('inherit');
    const res = await app().request(`/api/pages/${id}/agent-edits`);
    expect(res.status).toBe(200);
    expect((await res.json()).agentEdits).toBe('inherit');
  });

  it('the migration is idempotent + safe on a DB that already holds page rows', async () => {
    const {id} = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    await store.setPageAgentEdits(id, 'direct');
    // Re-running migrations must not throw or reset the column default / existing rows.
    await expect(store.migrate()).resolves.toBeUndefined();
    expect(await store.getPageAgentEdits(id)).toBe('direct');
    const {id: fresh} = await store.upsertPage({name: `p2-${seq}`, data: snapshot()});
    expect(await store.getPageAgentEdits(fresh)).toBe('inherit');
  });

  it('getPageAgentEdits returns null for a missing page', async () => {
    expect(await store.getPageAgentEdits('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

// ── PUT/GET /api/pages/:id/agent-edits ──────────────────────────────────────────────

describe('PUT /api/pages/:id/agent-edits (AGED-1)', () => {
  it('refuses a PAT principal (jws-only policy write) with 403', async () => {
    await claim();
    await enableAgentApi();
    const {id} = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const token = await mintPat('write');
    const res = await app().request(`/api/pages/${id}/agent-edits`, {
      method: 'PUT',
      headers: {...bearer(token), 'Content-Type': 'application/json'},
      body: JSON.stringify({agentEdits: 'direct'}),
    });
    expect(res.status).toBe(403);
    expect(await store.getPageAgentEdits(id)).toBe('inherit'); // unchanged
  });

  it('lets a read PAT GET the policy (readable by any reader — the carve-out allows GET)', async () => {
    await claim();
    await enableAgentApi();
    const {id} = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    await store.setPageVisibility(id, 'public'); // any reader may read this page
    const token = await mintPat('read');
    const res = await app().request(`/api/pages/${id}/agent-edits`, {headers: bearer(token)});
    expect(res.status).toBe(200);
    expect((await res.json()).agentEdits).toBe('inherit');
  });

  it('accepts a jws owner write, persists it, and round-trips via GET', async () => {
    await claim();
    const {id} = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const res = await app().request(`/api/pages/${id}/agent-edits`, {
      method: 'PUT',
      headers: await owner(),
      body: JSON.stringify({agentEdits: 'direct'}),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).agentEdits).toBe('direct');
    expect(await store.getPageAgentEdits(id)).toBe('direct');
    const get = await app().request(`/api/pages/${id}/agent-edits`, {headers: {[IDENTITY_HEADER]: await idFor('owner')}});
    expect((await get.json()).agentEdits).toBe('direct');
  });

  it('rejects an invalid policy value with 400', async () => {
    await claim();
    const {id} = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const res = await app().request(`/api/pages/${id}/agent-edits`, {
      method: 'PUT',
      headers: await owner(),
      body: JSON.stringify({agentEdits: 'nonsense'}),
    });
    expect(res.status).toBe(400);
    expect(await store.getPageAgentEdits(id)).toBe('inherit'); // unchanged
  });

  it('writes a page.agentEdits entry to the edit log', async () => {
    await claim();
    const {id} = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    await app().request(`/api/pages/${id}/agent-edits`, {
      method: 'PUT',
      headers: await owner(),
      body: JSON.stringify({agentEdits: 'suggest'}),
    });
    await tick(); // edit-log write is fire-after-commit
    const edits = await store.listEdits(id);
    expect(edits[0]).toMatchObject({kind: 'page.agentEdits', summary: 'suggest', authorSubject: OWNER});
  });
});

// ── PUT /api/instance {agentEdits} + GET exposure ──────────────────────────────────

describe('PUT /api/instance agentEdits (AGED-1)', () => {
  it('accepts + persists agentEdits for the owner and exposes it on GET', async () => {
    await claim();
    const res = await app().request('/api/instance', {
      method: 'PUT',
      headers: await owner(),
      body: JSON.stringify({agentEdits: 'direct'}),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).agentEdits).toBe('direct');
    expect((await store.getInstanceConfig()).agentEdits).toBe('direct');
    const info = await (await app().request('/api/instance', {headers: {[IDENTITY_HEADER]: await idFor('owner')}})).json();
    expect(info.agentEdits).toBe('direct');
  });

  it('enum-validates agentEdits (400 on an unknown value, nothing persisted)', async () => {
    await claim();
    const res = await app().request('/api/instance', {
      method: 'PUT',
      headers: await owner(),
      body: JSON.stringify({agentEdits: 'bogus'}),
    });
    expect(res.status).toBe(400);
    expect((await store.getInstanceConfig()).agentEdits).toBe('suggest'); // unchanged
  });

  it('rejects "inherit" at the instance level (page-only value)', async () => {
    await claim();
    const res = await app().request('/api/instance', {
      method: 'PUT',
      headers: await owner(),
      body: JSON.stringify({agentEdits: 'inherit'}),
    });
    expect(res.status).toBe(400);
  });

  it('stays owner-only: a guest cannot change agentEdits', async () => {
    await claim();
    const res = await app().request('/api/instance', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({agentEdits: 'direct'}),
    });
    expect(res.status).toBe(403);
    expect((await store.getInstanceConfig()).agentEdits).toBe('suggest');
  });
});
