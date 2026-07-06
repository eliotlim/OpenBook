/**
 * AI usage attribution (C1) — the server-managed, admin-only usage database plus
 * admin-editable pricing.
 *
 * These tests pin the acceptance surface:
 *  - each model request (generate / one agent turn) logs EXACTLY ONE usage row
 *    attributed to the SERVER-resolved principal, with provider/model/tokens and a
 *    `cost_usd` snapshotted from the effective pricing (populated for a known model
 *    via DEFAULT_PRICING; null for an unknown model);
 *  - the usage DB host page is `restricted` (owner/admin read; viewer/guest 404);
 *  - the managed DB rejects end-user writes/edits while server writes still land;
 *  - an admin `PUT /api/ai/pricing` changes the effective price for the next row,
 *    and a non-admin PUT is 403;
 *  - the seeded DB carries `autoExpiry {enabled, days:30, basis:'created'}` and an
 *    admin retention edit updates `days`;
 *  - seeding is idempotent (no duplicate DB); the provider API key never lands in
 *    a row.
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
import {AgentRunner} from './ai/agent';
import {AiUsageLog, DEFAULT_PRICING} from './ai/usage';
import {MockEngine, estimateTokens, type AiEngine, type TokenUsage} from './ai/providers';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';

const ISS = 'https://account.book.pub';
let store: PageStore;
let db: PgliteDb;
let dir: string;
let seq = 0;
let kp: IdentityKeypair;
let jwks: Jwks;

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

/** Trust the dev issuer + claim the instance under `${ISS}#owner`. */
const claim = () => store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], ownerSubject: `${ISS}#owner`});

const appWith = (opts: {ai?: AiService; aiUsage?: AiUsageLog}) =>
  createApp(store, opts.ai, new PageHub(), {identity: new IdentityService(store), aiUsage: opts.aiUsage});

const post = (app: ReturnType<typeof appWith>, path: string, body: unknown, jws?: string) =>
  app.request(path, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...(jws ? {[IDENTITY_HEADER]: jws} : {})},
    body: JSON.stringify(body),
  });

const get = (app: ReturnType<typeof appWith>, path: string, jws?: string) =>
  app.request(path, {headers: jws ? {[IDENTITY_HEADER]: jws} : {}});

const put = (app: ReturnType<typeof appWith>, path: string, body: unknown, jws?: string) =>
  app.request(path, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json', ...(jws ? {[IDENTITY_HEADER]: jws} : {})},
    body: JSON.stringify(body),
  });

const patch = (app: ReturnType<typeof appWith>, path: string, body: unknown, jws?: string) =>
  app.request(path, {
    method: 'PATCH',
    headers: {'Content-Type': 'application/json', ...(jws ? {[IDENTITY_HEADER]: jws} : {})},
    body: JSON.stringify(body),
  });

const del = (app: ReturnType<typeof appWith>, path: string, jws?: string) =>
  app.request(path, {method: 'DELETE', headers: jws ? {[IDENTITY_HEADER]: jws} : {}});

/** A scripted engine that answers in one turn and emits the given usage. */
const usageEngine = (usage: TokenUsage): AiEngine => ({
  kind: 'mock',
  async ensureReady() {
    /* always ready */
  },
  async generate(_prompt, opts) {
    const out = JSON.stringify({final: 'done'});
    opts.onToken(out);
    opts.onUsage?.(usage);
    return out;
  },
  async dispose() {
    /* nothing to release */
  },
});

/** An AiService whose AGENT engine is scripted (the real config still drives the
 *  logged provider/model). */
class UsageAi extends AiService {
  constructor(
    d: PgliteDb,
    modelsDir: string,
    private readonly scripted: AiEngine,
  ) {
    super(d, modelsDir);
  }

  async engineForRequest(): Promise<{engine: AiEngine; transient: boolean}> {
    return {engine: this.scripted, transient: false};
  }
}

const seededUsage = async (): Promise<AiUsageLog> => {
  const usage = new AiUsageLog(store);
  await usage.ensureSeeded();
  return usage;
};

const rowsOf = (usage: AiUsageLog) => store.listRows(usage.databaseId!);

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-aiusage-${process.pid}-${seq}`);
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

// ── Engine usage capture ─────────────────────────────────────────────────────

describe('MockEngine surfaces deterministic token usage', () => {
  it('reports whitespace-token counts of prompt+system (input) and output', async () => {
    const engine = new MockEngine();
    let usage: TokenUsage | undefined;
    await engine.generate('one two three', {system: 'a b', onToken: () => undefined, onUsage: (u) => (usage = u)});
    expect(usage).toEqual({
      inputTokens: estimateTokens('one two three') + estimateTokens('a b'), // 3 + 2
      outputTokens: estimateTokens('Mock response to: one two three'), // 6
    });
  });
});

// ── Attribution write path ───────────────────────────────────────────────────

describe('an agent turn logs exactly one attributed usage row', () => {
  it('a KNOWN model gets provider/model/tokens + cost from DEFAULT_PRICING; the key never lands', async () => {
    await claim();
    const usage = await seededUsage();
    const ai = new UsageAi(db, join(dir, 'models'), usageEngine({inputTokens: 1000, outputTokens: 500}));
    await ai.setConfig({provider: 'claude', providers: {claude: {apiKey: 'sk-ant-verysecret', model: 'claude-opus-4-8'}}});

    const runner = new AgentRunner(ai, store, {principal: principal('owner'), thinking: false, usage});
    await runner.run([{role: 'user', content: 'go'}], () => undefined);

    const rows = await rowsOf(usage);
    expect(rows).toHaveLength(1);
    const p = rows[0].properties;
    expect(p.p_provider).toBe('claude');
    expect(p.p_model).toBe('claude-opus-4-8');
    expect(p.p_input).toBe(1000);
    expect(p.p_output).toBe(500);
    expect(p.p_kind).toBe('agent');
    // 1000/1e6*5 + 500/1e6*25 = 0.005 + 0.0125
    expect(p.p_cost).toBeCloseTo(0.0175, 9);
    expect(String(p.p_user)).toContain(`${ISS}#owner`); // subject-attributed
    expect(JSON.stringify(rows[0])).not.toContain('sk-ant-verysecret'); // no key in the row
  });

  it('an UNKNOWN model logs the tokens but leaves cost null', async () => {
    await claim();
    const usage = await seededUsage();
    const ai = new UsageAi(db, join(dir, 'models'), usageEngine({inputTokens: 42, outputTokens: 7}));
    await ai.setConfig({provider: 'claude', providers: {claude: {apiKey: 'k', model: 'totally-made-up-model'}}});

    await new AgentRunner(ai, store, {principal: principal('owner'), thinking: false, usage}).run([{role: 'user', content: 'go'}], () => undefined);

    const [row] = await rowsOf(usage);
    expect(row.properties.p_input).toBe(42);
    expect(row.properties.p_output).toBe(7);
    expect(row.properties.p_cost).toBeUndefined(); // unknown model → cost null (unset)
  });
});

describe('the generate route logs one row and ignores any client-supplied user id', () => {
  it('logs kind=generate for the SERVER principal (a spoofed `user` body field is ignored); local cost 0', async () => {
    await claim();
    const ai = new AiService(db, join(dir, 'models'));
    await ai.setConfig({provider: 'mock', providers: {mock: {model: 'mock-1'}}});
    const usage = await seededUsage();
    const app = appWith({ai, aiUsage: usage});

    // The body carries a bogus user id — it must be ignored; attribution uses the JWS principal.
    const res = await post(app, '/api/ai/generate', {prompt: 'hello world', user: 'attacker', userId: 'attacker'}, await idFor('owner'));
    expect(res.status).toBe(200);
    await res.text(); // drain the SSE body (the row is logged before it closes)

    const rows = await rowsOf(usage);
    expect(rows).toHaveLength(1);
    const p = rows[0].properties;
    expect(p.p_kind).toBe('generate');
    expect(p.p_provider).toBe('mock');
    expect(p.p_model).toBe('mock-1');
    expect(p.p_cost).toBe(0); // local provider → free
    expect(String(p.p_user)).toContain(`${ISS}#owner`);
    expect(String(p.p_user)).not.toContain('attacker');
  });
});

// ── Restricted host + managed write-gate ─────────────────────────────────────

describe('the usage DB host page is restricted (admin-only read)', () => {
  beforeEach(async () => {
    await claim();
    await store.addMember({subject: `${ISS}#admin`, role: 'admin', status: 'active'});
    await store.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
  });

  it('owner + admin read the rows; a viewer and an anonymous guest get a 404', async () => {
    const usage = await seededUsage();
    // A server-written row so the readers see content.
    await usage.log({provider: 'mock', model: 'm', kind: 'generate', usage: {inputTokens: 1, outputTokens: 1}, principal: principal('owner')});
    const app = appWith({ai: new AiService(db, join(dir, 'models')), aiUsage: usage});
    const path = `/api/databases/${usage.databaseId}/rows`;

    const owner = await get(app, path, await idFor('owner'));
    expect(owner.status).toBe(200);
    expect(((await owner.json()) as unknown[]).length).toBe(1);
    expect((await get(app, path, await idFor('admin'))).status).toBe(200);
    expect((await get(app, path, await idFor('viewer'))).status).toBe(404); // member, but restricted
    expect((await get(app, path)).status).toBe(404); // guest
  });
});

describe('the managed usage DB rejects end-user writes; server writes still land', () => {
  beforeEach(async () => {
    await claim();
    await store.addMember({subject: `${ISS}#admin`, role: 'admin', status: 'active'});
  });

  it('create-row / update-row / patch / delete by owner/admin → 403; guest → existence-hiding 404', async () => {
    const usage = await seededUsage();
    // Server attribution write bypasses the routes (goes straight through the store).
    await usage.log({provider: 'mock', model: 'm', kind: 'generate', usage: {inputTokens: 1, outputTokens: 1}, principal: principal('owner')});
    const rowId = (await rowsOf(usage))[0].id;
    const dbId = usage.databaseId!;
    const app = appWith({ai: new AiService(db, join(dir, 'models')), aiUsage: usage});

    // owner + admin can READ but every write is managed-rejected (403).
    expect((await post(app, `/api/databases/${dbId}/rows`, {name: 'x'}, await idFor('owner'))).status).toBe(403);
    expect((await post(app, `/api/databases/${dbId}/rows`, {name: 'x'}, await idFor('admin'))).status).toBe(403);
    expect((await patch(app, `/api/databases/${dbId}/rows/${rowId}`, {name: 'pwn'}, await idFor('owner'))).status).toBe(403);
    expect((await patch(app, `/api/databases/${dbId}`, {name: 'hacked'}, await idFor('owner'))).status).toBe(403);
    expect((await del(app, `/api/databases/${dbId}`, await idFor('owner'))).status).toBe(403);
    // a non-reader (guest) gets the same existence-hiding 404 as any restricted DB.
    expect((await post(app, `/api/databases/${dbId}/rows`, {name: 'x'})).status).toBe(404);

    // …and the server's own attribution write still works (the row count grew via log()).
    await usage.log({provider: 'mock', model: 'm', kind: 'generate', usage: {inputTokens: 2, outputTokens: 2}, principal: principal('owner')});
    expect((await rowsOf(usage)).length).toBe(2);
  });
});

// ── Admin pricing + retention ────────────────────────────────────────────────

describe('admin-editable pricing changes the effective cost snapshot', () => {
  beforeEach(async () => {
    await claim();
    await store.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
  });

  it('a non-admin PUT is 403; an admin PUT repricing a model is used by the next row', async () => {
    const usage = await seededUsage();
    const ai = new UsageAi(db, join(dir, 'models'), usageEngine({inputTokens: 1_000_000, outputTokens: 0}));
    await ai.setConfig({provider: 'claude', providers: {claude: {apiKey: 'k', model: 'claude-opus-4-8'}}});
    const app = appWith({ai, aiUsage: usage});
    const override = {claude: {'claude-opus-4-8': {inputPerMtok: 99, outputPerMtok: 0}}};

    // non-admin (viewer role + anonymous guest) cannot reprice.
    expect((await put(app, '/api/ai/pricing', override, await idFor('viewer'))).status).toBe(403);
    expect((await put(app, '/api/ai/pricing', override)).status).toBe(403);

    // admin (owner) sets the override, then a run prices 1e6 input tokens at $99/Mtok = $99.
    const set = await put(app, '/api/ai/pricing', override, await idFor('owner'));
    expect(set.status).toBe(200);
    const body = (await set.json()) as {effective: {claude?: Record<string, {inputPerMtok: number}>}};
    expect(body.effective.claude?.['claude-opus-4-8']?.inputPerMtok).toBe(99);

    await new AgentRunner(ai, store, {principal: principal('owner'), thinking: false, usage}).run([{role: 'user', content: 'go'}], () => undefined);
    const rows = await rowsOf(usage);
    expect(rows).toHaveLength(1);
    expect(rows[0].properties.p_cost).toBeCloseTo(99, 6);
  });

  it('GET /api/ai/pricing returns the shipped defaults merged with the override (admin only)', async () => {
    const usage = await seededUsage();
    const app = appWith({ai: new AiService(db, join(dir, 'models')), aiUsage: usage});
    expect((await get(app, '/api/ai/pricing', await idFor('viewer'))).status).toBe(403); // non-admin
    const res = await get(app, '/api/ai/pricing', await idFor('owner'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {default: typeof DEFAULT_PRICING; effective: typeof DEFAULT_PRICING};
    expect(body.default.claude?.['claude-opus-4-8']).toEqual(DEFAULT_PRICING.claude!['claude-opus-4-8']);
    expect(body.effective.claude?.['claude-opus-4-8']?.outputPerMtok).toBe(25);
  });
});

describe('seeded auto-expiry + admin retention', () => {
  it('the seeded DB carries autoExpiry {enabled, days:30, basis:created} + managed marker', async () => {
    const usage = await seededUsage();
    const seeded = await store.getDatabase(usage.databaseId!);
    expect(seeded!.schema.autoExpiry).toEqual({enabled: true, days: 30, basis: 'created'});
    expect(seeded!.schema.managed).toBe(true);
  });

  it('an admin retention edit updates the days (non-admin denied)', async () => {
    await claim();
    const usage = await seededUsage();
    const app = appWith({ai: new AiService(db, join(dir, 'models')), aiUsage: usage});

    expect((await put(app, '/api/ai/usage/retention', {days: 7}, await idFor('stranger'))).status).toBe(403);
    const res = await put(app, '/api/ai/usage/retention', {days: 7}, await idFor('owner'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({days: 7});

    const after = await store.getDatabase(usage.databaseId!);
    expect(after!.schema.autoExpiry).toEqual({enabled: true, days: 7, basis: 'created'});
  });
});

// ── Idempotent seed ──────────────────────────────────────────────────────────

describe('seeding is idempotent', () => {
  it('a fresh AiUsageLog on the same store reuses the DB — no duplicate is created', async () => {
    const u1 = await seededUsage();
    const first = u1.databaseId;
    expect(first).not.toBeNull();

    // A second log (simulating a process restart) reads the recorded id back.
    const u2 = new AiUsageLog(store);
    await u2.ensureSeeded();
    expect(u2.databaseId).toBe(first);

    // Exactly one database exists in the store.
    expect((await db.query('SELECT id FROM databases')).length).toBe(1);
  });
});
