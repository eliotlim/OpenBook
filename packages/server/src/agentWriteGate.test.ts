/**
 * Agent-PAT write-gate enforcement suite (AGED-2). Server-side teeth for the AGED-1
 * agent-edits policy: an agent PAT may edit a page's CONTENT directly only when the
 * page's resolved mode is exactly `'direct'`; otherwise the direct write 403s with an
 * actionable steer toward the suggestion route. Covers both resolution shapes
 * (instance mode + per-page override), the direct-write provenance path (edit_log +
 * per-block authorship), the always-open suggestion route, the untouched jws path,
 * and the load-bearing fail-safe (any non-`'direct'` value → suggest-mode).
 */

import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  signIdentity,
  mintIdentityKeypair,
  type AgentEditsPolicy,
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
const snapWith = (blockId: string, text: string) => ({
  editorjs: {blocks: [{id: blockId, type: 'paragraph', data: {text}}]},
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

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-aged2-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  kp = await mintIdentityKeypair('k1');
  jwks = {keys: [kp.publicJwk]};
  // Claim the instance to OWNER so a PAT bound to OWNER carries owner-level write
  // access (authorize()), and enable the agent API so a PAT resolves at all.
  await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], ownerSubject: OWNER});
  await store.setSetting(AGENT_API_SETTING_KEY, {enabled: true});
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

const app = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});
const bearer = (token: string) => ({Authorization: `Bearer ${token}`});
const ownerHeaders = async () => ({'Content-Type': 'application/json', [IDENTITY_HEADER]: await idFor('owner')});
const tick = () => new Promise((r) => setTimeout(r, 25));

async function mintPat(scope: AgentTokenScope = 'write'): Promise<string> {
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

const putPage = (token: string, id: string, data: unknown = snapshot()) =>
  app().request(`/api/pages/${id}`, {
    method: 'PUT',
    headers: {...bearer(token), 'Content-Type': 'application/json'},
    body: JSON.stringify({name: 'edited', data}),
  });

// ── Resolved suggest-mode → 403 (the two shapes) ────────────────────────────────────

describe('agent-PAT write gate — 403 under resolved suggest (AGED-2)', () => {
  it('instance=suggest (default) + page=inherit → PAT PUT 403s with the suggestion steer', async () => {
    const {id} = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const token = await mintPat();
    const res = await putPage(token, id);
    expect(res.status).toBe(403);
    const body = (await res.json()) as {error: string};
    expect(body.error).toContain(`POST /api/pages/${id}/suggestions`);
    expect(body.error).toMatch(/direct edits are disabled/i);
  });

  it('page override=suggest on an instance=direct server → PAT PUT 403s', async () => {
    await store.updateInstanceConfig({agentEdits: 'direct'});
    const {id} = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    await store.setPageAgentEdits(id, 'suggest'); // per-page override beats the instance mode
    const token = await mintPat();
    const res = await putPage(token, id);
    expect(res.status).toBe(403);
  });

  it('gates the block-level CRDT save (/updates), the rename (PATCH), properties, upsert POST, and row edit', async () => {
    const {id} = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const token = await mintPat();
    const h = {...bearer(token), 'Content-Type': 'application/json'};
    const updates = await app().request(`/api/pages/${id}/updates`, {method: 'POST', headers: h, body: JSON.stringify({update: 'AA==', clientId: 1})});
    expect(updates.status).toBe(403);
    const rename = await app().request(`/api/pages/${id}`, {method: 'PATCH', headers: h, body: JSON.stringify({name: 'x'})});
    expect(rename.status).toBe(403);
    const props = await app().request(`/api/pages/${id}/properties`, {method: 'PATCH', headers: h, body: JSON.stringify({properties: {sys_icon: '📄'}})});
    expect(props.status).toBe(403);
    const upsert = await app().request('/api/pages', {method: 'POST', headers: h, body: JSON.stringify({id, name: 'y', data: snapshot()})});
    expect(upsert.status).toBe(403);

    // A row is a page; editing an existing row obeys the row page's mode.
    const dbPage = await store.upsertPage({name: `db-${seq}`, data: snapshot()});
    const db = await store.createDatabase({pageId: dbPage.id, name: 'D'});
    const row = await store.createRow(db.id, {}, undefined);
    const rowEdit = await app().request(`/api/databases/${db.id}/rows/${row.id}`, {method: 'PATCH', headers: h, body: JSON.stringify({name: 'z'})});
    expect(rowEdit.status).toBe(403);
  });

  it('gates the version-restore route — a restore is a direct content rollback (AGED-2 review)', async () => {
    // Two distinct saves so the pre-save state is captured as a version to target.
    const {id} = await store.upsertPage({name: `p-${seq}`, data: snapWith('blk1', 'v1')});
    await store.upsertPage({id, name: `p-${seq}`, data: snapWith('blk1', 'v2')});
    const [version] = await store.listPageVersions(id);
    expect(version).toBeDefined();

    // instance default suggest + page inherit → a write-PAT must NOT roll the page back directly.
    const token = await mintPat();
    const res = await app().request(`/api/pages/${id}/versions/${version.id}/restore`, {
      method: 'POST',
      headers: bearer(token),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {error: string};
    expect(body.error).toContain(`POST /api/pages/${id}/suggestions`);
    expect(body.error).toMatch(/direct edits are disabled/i);
  });
});

// ── Resolved direct-mode → allowed + provenance ─────────────────────────────────────

describe('agent-PAT write gate — allowed under resolved direct (AGED-2)', () => {
  it('instance=direct + page=inherit → PAT PUT succeeds', async () => {
    await store.updateInstanceConfig({agentEdits: 'direct'});
    const {id} = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const token = await mintPat();
    const res = await putPage(token, id);
    expect(res.status).toBe(200);
  });

  it('page override=direct on an instance=suggest server → PAT PUT succeeds', async () => {
    const {id} = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    await store.setPageAgentEdits(id, 'direct'); // per-page opt-in on a suggest instance
    const token = await mintPat();
    const res = await putPage(token, id);
    expect(res.status).toBe(200);
  });

  it('instance=direct → a PAT may restore a prior version (AGED-2 review)', async () => {
    await store.updateInstanceConfig({agentEdits: 'direct'});
    const {id} = await store.upsertPage({name: `p-${seq}`, data: snapWith('blk1', 'v1')});
    await store.upsertPage({id, name: `p-${seq}`, data: snapWith('blk1', 'v2')});
    const [version] = await store.listPageVersions(id);
    const res = await app().request(`/api/pages/${id}/versions/${version.id}/restore`, {
      method: 'POST',
      headers: bearer(await mintPat()),
    });
    expect(res.status).toBe(200);
  });

  it('a direct PAT write lands the PAT subject in the edit log AND per-block authors', async () => {
    await store.updateInstanceConfig({agentEdits: 'direct'});
    const {id} = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const token = await mintPat();
    const res = await putPage(token, id, snapWith('blk1', 'agent wrote this'));
    expect(res.status).toBe(200);

    // Per-block authorship (pages.data.authors): the changed block credits the PAT's
    // bound subject (OWNER) — NOT '' (which is what verifiedSubject would stamp).
    const page = await store.getPage(id);
    const authors = new Map((page?.data as {authors?: Array<[string, string]>}).authors ?? []);
    expect(authors.get('blk1')).toBe(OWNER);

    // Edit log: a page.save entry attributed to the PAT subject, recorded verified_via='pat'.
    await tick(); // logEdit is fire-after-commit
    const edits = await store.listEdits(id);
    expect(edits.some((e) => e.kind === 'page.save' && e.authorSubject === OWNER)).toBe(true);
  });
});

// ── Suggestion route stays open in BOTH modes ───────────────────────────────────────

describe('suggestion route is never gated for a PAT (AGED-2)', () => {
  const createSuggestion = (token: string, id: string) =>
    app().request(`/api/pages/${id}/suggestions`, {
      method: 'POST',
      headers: {...bearer(token), 'Content-Type': 'application/json'},
      body: JSON.stringify({
        authorKind: 'ai',
        authorName: 'agent',
        kind: 'replace-text',
        target: {blockId: 'blk1'},
        before: 'old',
        after: 'new',
        payload: {},
      }),
    });

  it('a PAT may create a suggestion under resolved suggest-mode', async () => {
    const {id} = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const res = await createSuggestion(await mintPat(), id);
    expect(res.status).toBe(201);
  });

  it('a PAT may create a suggestion under resolved direct-mode too', async () => {
    await store.updateInstanceConfig({agentEdits: 'direct'});
    const {id} = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const res = await createSuggestion(await mintPat(), id);
    expect(res.status).toBe(201);
  });
});

// ── The gate never touches a human (jws) principal ──────────────────────────────────

describe('jws writes are NEVER gated by the agent-edits policy (AGED-2)', () => {
  it('a jws owner PUT succeeds even on a suggest-mode page', async () => {
    const {id} = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    // instance default suggest + page inherit → a PAT would 403 here; a human must not.
    const res = await app().request(`/api/pages/${id}`, {
      method: 'PUT',
      headers: await ownerHeaders(),
      body: JSON.stringify({name: 'human edit', data: snapshot()}),
    });
    expect(res.status).toBe(200);
  });
});

// ── Load-bearing fail-safe: only EXACT 'direct' permits a direct write ───────────────

describe('fail-safe — any non-"direct" resolved value denies (AGED-2)', () => {
  it('a corrupted/garbage page policy value falls to suggest-mode (403), never direct', async () => {
    const {id} = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    // Simulate a corrupted row / an unexpected enum value the resolver can't map.
    await store.setPageAgentEdits(id, 'garbage' as AgentEditsPolicy);
    const token = await mintPat();
    const res = await putPage(token, id);
    expect(res.status).toBe(403);
  });

  it('an explicit inherit policy with a suggest instance stays suggest-mode (403)', async () => {
    const {id} = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    await store.setPageAgentEdits(id, 'inherit'); // the resolver must not treat inherit as direct
    const res = await putPage(await mintPat(), id);
    expect(res.status).toBe(403);
  });
});
