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
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  emptyPageSnapshot,
  signIdentity,
  mintIdentityKeypair,
  type AiPricingTable,
  type IdentityClaims,
  type IdentityKeypair,
  type ImportRequest,
  type Jwks,
  type Principal,
  type StoredDatabase,
  type StoredPage,
} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {AiService} from './ai/service';
import {AgentRunner} from './ai/agent';
import {AiUsageLog, DEFAULT_PRICING} from './ai/usage';
import {AnthropicEngine, LlamaEngine, MockEngine, OpenAiCompatEngine, estimateTokens, type AiEngine, type TokenUsage} from './ai/providers';
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

// ── Admin usage viewer (GET /api/ai/usage) ───────────────────────────────────

describe('GET /api/ai/usage reports the usage view to admins only', () => {
  beforeEach(async () => {
    await claim();
    await store.addMember({subject: `${ISS}#admin`, role: 'admin', status: 'active'});
    await store.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
  });

  it('a viewer and an anonymous guest are 403 (no leak of usage/cost)', async () => {
    const usage = await seededUsage();
    const app = appWith({ai: new AiService(db, join(dir, 'models')), aiUsage: usage});
    expect((await get(app, '/api/ai/usage', await idFor('viewer'))).status).toBe(403);
    expect((await get(app, '/api/ai/usage')).status).toBe(403);
  });

  it('reports exists:false WITHOUT seeding when the workspace has never used AI', async () => {
    // A non-seeded log (startup adopt found nothing) must not be created by a read.
    const usage = new AiUsageLog(store);
    await usage.load();
    const app = appWith({ai: new AiService(db, join(dir, 'models')), aiUsage: usage});

    const res = await get(app, '/api/ai/usage', await idFor('owner'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({exists: false, databaseId: null, hostPageId: null, retentionDays: null});
    // The read created no phantom database/page.
    expect((await db.query('SELECT id FROM databases')).length).toBe(0);
  });

  it('an admin gets rows (newest first) + totals + the retention window', async () => {
    const usage = await seededUsage();
    await usage.log({provider: 'claude', model: 'claude-opus-4-8', kind: 'generate', usage: {inputTokens: 1_000_000, outputTokens: 0}, principal: principal('owner')});
    await usage.log({provider: 'mock', model: 'm', kind: 'agent', usage: {inputTokens: 10, outputTokens: 5}, principal: principal('admin')});
    const app = appWith({ai: new AiService(db, join(dir, 'models')), aiUsage: usage});

    // Owner and admin both read it.
    for (const who of ['owner', 'admin']) {
      const res = await get(app, '/api/ai/usage', await idFor(who));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        exists: boolean;
        retentionDays: number;
        rows: Array<{provider: string; model: string; inputTokens: number; cost: number | null}>;
        totals: {rows: number; inputTokens: number; outputTokens: number; cost: number};
      };
      expect(body.exists).toBe(true);
      expect(body.retentionDays).toBe(30);
      expect(body.rows).toHaveLength(2);
      // Totals fold both rows; the claude row prices 1e6 input tokens at $5/Mtok.
      expect(body.totals).toEqual({rows: 2, inputTokens: 1_000_010, outputTokens: 5, cost: 5});
      // The claude row carries its priced cost; the local mock row is free.
      const claudeRow = body.rows.find((r) => r.provider === 'claude');
      expect(claudeRow?.model).toBe('claude-opus-4-8');
      expect(claudeRow?.cost).toBe(5);
      // No raw property ids leak — the projection is by named field.
      expect(JSON.stringify(body.rows)).not.toContain('p_input');
    }
  });

  it('caps the returned rows at the limit while totals still count EVERY row', async () => {
    const usage = await seededUsage();
    await usage.log({provider: 'mock', model: 'm', kind: 'generate', usage: {inputTokens: 1, outputTokens: 1}, principal: principal('owner')});
    await usage.log({provider: 'mock', model: 'm', kind: 'generate', usage: {inputTokens: 2, outputTokens: 3}, principal: principal('admin')});
    // A tiny page (limit 1) still folds totals over both rows — the viewer's
    // "Showing N of M" hint relies on totals.rows being the TRUE call count.
    const view = await usage.report(1);
    expect(view.rows).toHaveLength(1); // page capped
    expect(view.totals?.rows).toBe(2); // …but totals count all rows
    expect(view.totals?.inputTokens).toBe(3);
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

// ── Lazy seeding (no phantom page in a fresh workspace) ───────────────────────

describe('the usage DB is created lazily, only on first AI use', () => {
  it('a workspace that never uses AI has NO usage database or page (stays empty)', async () => {
    // Startup wiring only RE-ADOPTS an already-created DB; it must never create one,
    // so a workspace that never uses AI stays empty (lands on Home in the app).
    const usage = new AiUsageLog(store);
    await usage.load();
    expect(usage.databaseId).toBeNull();
    expect(usage.hostPage).toBeNull();
    // Nothing is managed until the DB exists ⇒ the write-gate guards are inert.
    expect(usage.isManagedDatabase('any-id')).toBe(false);
    expect(await usage.isManagedPage('any-id')).toBe(false);
    // The store is genuinely empty: no database and no "AI usage" page.
    expect((await db.query('SELECT id FROM databases')).length).toBe(0);
    expect((await db.query('SELECT id FROM pages')).length).toBe(0);
  });

  it('the FIRST log() lazily creates the managed DB; a restart re-adopts it (no duplicate)', async () => {
    const usage = new AiUsageLog(store);
    await usage.load();
    expect(usage.databaseId).toBeNull(); // nothing yet

    await usage.log({provider: 'mock', model: 'm', kind: 'generate', usage: {inputTokens: 1, outputTokens: 1}, principal: principal('owner')});
    const created = usage.databaseId;
    expect(created).not.toBeNull(); // created on first write
    expect((await rowsOf(usage)).length).toBe(1);
    // Now that it exists, the guards protect it.
    expect(usage.isManagedDatabase(created!)).toBe(true);
    expect(await usage.isManagedPage(usage.hostPage!)).toBe(true);
    expect((await db.query('SELECT id FROM databases')).length).toBe(1);

    // A restart (fresh log on the same store) re-adopts the recorded DB — no second one.
    const restarted = new AiUsageLog(store);
    await restarted.load();
    expect(restarted.databaseId).toBe(created);
    expect(restarted.hostPage).toBe(usage.hostPage);
    expect((await db.query('SELECT id FROM databases')).length).toBe(1);
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
    expect(u2.hostPage).toBe(u1.hostPage); // the host page id survives the restart too

    // Exactly one database exists in the store.
    expect((await db.query('SELECT id FROM databases')).length).toBe(1);
  });
});

// ── Host restricted from creation (Fix 2 — no non-restricted window) ──────────

describe('the usage DB host page is restricted from creation', () => {
  it('records the host page id and seeds it restricted (before the DB is linked)', async () => {
    const usage = await seededUsage();
    expect(usage.hostPage).not.toBeNull();
    expect(await store.getPageVisibility(usage.hostPage!)).toBe('restricted');
    // The recorded host page really hosts the usage DB.
    const hostDb = await store.getDatabaseByPage(usage.hostPage!);
    expect(hostDb?.id).toBe(usage.databaseId);
  });
});

// ── Managed page-route lockout (Fix 1 — the generic /api/pages/* guard) ───────

describe('the managed usage DB is locked against the generic page routes', () => {
  beforeEach(async () => {
    await claim();
    await store.addMember({subject: `${ISS}#admin`, role: 'admin', status: 'active'});
    await store.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
  });

  it('an owner/admin cannot delete rows, trash/move/patch the host, un-restrict it, or grant an ACL (all 403); a viewer/guest stays existence-hidden (404)', async () => {
    const usage = await seededUsage();
    await usage.log({provider: 'mock', model: 'm', kind: 'generate', usage: {inputTokens: 1, outputTokens: 1}, principal: principal('owner')});
    const rowId = (await rowsOf(usage))[0].id;
    const hostId = usage.hostPage!;
    const app = appWith({ai: new AiService(db, join(dir, 'models')), aiUsage: usage});
    const owner = await idFor('owner');

    // owner: every mutation on a managed page (a row or the host) is a managed 403.
    expect((await del(app, `/api/pages/${rowId}`, owner)).status).toBe(403); // delete an attribution row
    expect((await patch(app, `/api/pages/${rowId}/properties`, {properties: {p_cost: 0}}, owner)).status).toBe(403);
    expect((await del(app, `/api/pages/${hostId}`, owner)).status).toBe(403); // trash the usage DB
    expect((await patch(app, `/api/pages/${hostId}`, {name: 'pwn'}, owner)).status).toBe(403);
    expect((await put(app, `/api/pages/${hostId}/move`, {parentId: null, orderedIds: []}, owner)).status).toBe(403);
    expect((await put(app, `/api/pages/${hostId}/visibility`, {visibility: 'public'}, owner)).status).toBe(403); // un-restrict
    expect((await post(app, `/api/pages/${hostId}/acl`, {invitee: 'e@x.com', level: 'read'}, owner)).status).toBe(403);
    expect((await del(app, `/api/pages/${hostId}/acl?email=e@x.com`, owner)).status).toBe(403);
    // admin is likewise locked out.
    expect((await del(app, `/api/pages/${rowId}`, await idFor('admin'))).status).toBe(403);

    // a non-reader (viewer / guest) is existence-hidden — the guard runs AFTER the access gate.
    expect((await del(app, `/api/pages/${rowId}`, await idFor('viewer'))).status).toBe(404);
    expect((await put(app, `/api/pages/${hostId}/visibility`, {visibility: 'public'}, await idFor('viewer'))).status).toBe(404);
    expect((await del(app, `/api/pages/${rowId}`)).status).toBe(404); // guest

    // Nothing above mutated the DB: the host stays restricted and the row survives.
    expect(await store.getPageVisibility(hostId)).toBe('restricted');
    expect((await rowsOf(usage)).length).toBe(1);
  });

  it('the server-internal auto-expiry sweep + attribution writes stay ungated', async () => {
    const usage = await seededUsage();
    await usage.log({provider: 'mock', model: 'm', kind: 'generate', usage: {inputTokens: 1, outputTokens: 1}, principal: principal('owner')});
    expect((await rowsOf(usage)).length).toBe(1);

    // The 30-day auto-expiry sweep runs at the STORE level (never the guarded page
    // route), so it still soft-deletes expired rows — unaffected by the lockout.
    const future = new Date(Date.now() + 100 * 86_400_000);
    expect(await store.sweepExpiredRows({now: future})).toBeGreaterThanOrEqual(1);
    expect((await rowsOf(usage)).length).toBe(0); // swept to the trash

    // …and a fresh attribution write still lands (bypasses the page routes).
    await usage.log({provider: 'mock', model: 'm', kind: 'generate', usage: {inputTokens: 2, outputTokens: 2}, principal: principal('owner')});
    expect((await rowsOf(usage)).length).toBe(1);
  });
});

describe('the managed usage DB is locked against the content-body page routes', () => {
  beforeEach(async () => {
    await claim();
    await store.addMember({subject: `${ISS}#admin`, role: 'admin', status: 'active'});
    await store.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
  });

  it('PUT/POST /api/pages onto the managed host or a row → 403 (owner/admin); viewer/guest stays 404', async () => {
    const usage = await seededUsage();
    await usage.log({provider: 'mock', model: 'm', kind: 'generate', usage: {inputTokens: 1, outputTokens: 1}, principal: principal('owner')});
    const rowId = (await rowsOf(usage))[0].id;
    const hostId = usage.hostPage!;
    const app = appWith({ai: new AiService(db, join(dir, 'models')), aiUsage: usage});
    const owner = await idFor('owner');

    // A PUT (rename / body-overwrite via upsert) onto the host or a row is a managed 403.
    expect((await put(app, `/api/pages/${hostId}`, {name: 'pwn', data: emptyPageSnapshot()}, owner)).status).toBe(403);
    expect((await put(app, `/api/pages/${rowId}`, {name: 'pwn', data: emptyPageSnapshot()}, owner)).status).toBe(403);
    expect((await put(app, `/api/pages/${hostId}`, {name: 'pwn'}, await idFor('admin'))).status).toBe(403);
    // A POST upsert-by-id onto the managed host (ON CONFLICT name+data overwrite) too.
    expect((await post(app, '/api/pages', {id: hostId, name: 'pwn', data: emptyPageSnapshot()}, owner)).status).toBe(403);
    expect((await post(app, '/api/pages', {id: rowId, name: 'pwn', data: emptyPageSnapshot()}, owner)).status).toBe(403);

    // A non-reader (viewer / guest) is existence-hidden — the access gate 404s first.
    expect((await put(app, `/api/pages/${hostId}`, {name: 'pwn'}, await idFor('viewer'))).status).toBe(404);
    expect((await put(app, `/api/pages/${rowId}`, {name: 'pwn'})).status).toBe(404); // guest

    // Nothing above mutated the page: the host keeps its title + restricted visibility.
    expect(await store.getPageVisibility(hostId)).toBe('restricted');
    expect((await store.getPage(hostId))?.name).toBe('AI usage');
  });
});

// ── Import-overwrite tamper (Fix — hostile restore can't rewrite the usage DB) ─

describe('a hostile import-overwrite bundle cannot rewrite the server-managed usage DB', () => {
  it('strips the host page, its attribution rows, and the DB itself — but still imports an ordinary page', async () => {
    const usage = await seededUsage();
    await usage.log({provider: 'mock', model: 'm', kind: 'generate', usage: {inputTokens: 1, outputTokens: 1}, principal: principal('owner')});
    const realRow = (await rowsOf(usage))[0];
    const rowId = realRow.id;
    const hostId = usage.hostPage!;
    const dbId = usage.databaseId!;
    const now = new Date().toISOString();
    const blankPage = (over: Partial<StoredPage>): StoredPage => ({
      id: '',
      name: null,
      data: emptyPageSnapshot(),
      hostedDatabaseId: null,
      databaseId: null,
      parentId: null,
      properties: {},
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      ...over,
    });

    // A crafted overwrite bundle: forge the row's attribution + DETACH it from the
    // usage DB (databaseId:null exercises the current-state guard, not the claim),
    // rewrite the host page, strip the DB's `managed`/retention schema — plus one
    // ordinary page that MUST still import.
    const NORMAL_ID = '11111111-1111-4111-8111-111111111111';
    const req: ImportRequest = {
      mode: 'overwrite',
      pages: [
        blankPage({id: rowId, name: 'PWNED ROW', databaseId: null, properties: {p_user: `${ISS}#attacker`, p_cost: 999999, p_input: 0, p_output: 0}}),
        blankPage({id: hostId, name: 'PWNED HOST'}),
        blankPage({id: NORMAL_ID, name: 'Legit imported page'}),
      ],
      databases: [{id: dbId, pageId: hostId, name: 'PWNED DB', schema: {properties: [], views: [], managed: false}, createdAt: now, updatedAt: now} as StoredDatabase],
    };
    const result = await store.importBundle(req);

    // Only the ordinary page was written — every managed-targeting entry was stripped.
    expect(result.created).toBe(1);
    expect(result.overwritten).toBe(0);
    expect((await store.getPage(NORMAL_ID))?.name).toBe('Legit imported page');

    // The real attribution row is untouched: still in the usage DB, original cells.
    const rowsAfter = await rowsOf(usage);
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0].id).toBe(rowId);
    expect(String(rowsAfter[0].properties.p_user)).toContain(`${ISS}#owner`);
    expect(String(rowsAfter[0].properties.p_user)).not.toContain('attacker');
    expect(rowsAfter[0].properties.p_input).toBe(1);
    expect(rowsAfter[0].properties.p_cost).not.toBe(999999);

    // The host page survives (name + restricted visibility) and still hosts the DB;
    // the DB keeps its managed marker + 30-day retention (schema NOT overwritten).
    expect((await store.getPage(hostId))?.name).toBe('AI usage');
    expect(await store.getPageVisibility(hostId)).toBe('restricted');
    const dbAfter = await store.getDatabase(dbId);
    expect(dbAfter?.schema.managed).toBe(true);
    expect(dbAfter?.schema.autoExpiry).toEqual({enabled: true, days: 30, basis: 'created'});
    expect(await store.getDatabaseByPage(hostId)).not.toBeNull();
  });

  it('leaves a normal (no usage DB seeded) overwrite import unaffected', async () => {
    // No AiUsageLog seeded → the strip is a no-op; the bundle imports verbatim.
    const now = new Date().toISOString();
    const ID = '22222222-2222-4222-8222-222222222222';
    const page: StoredPage = {
      id: ID,
      name: 'Ordinary',
      data: emptyPageSnapshot(),
      hostedDatabaseId: null,
      databaseId: null,
      parentId: null,
      properties: {},
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const result = await store.importBundle({mode: 'overwrite', pages: [page], databases: []});
    expect(result.created).toBe(1);
    expect((await store.getPage(ID))?.name).toBe('Ordinary');
  });
});

// ── Pricing-override validation (Fix 4 — no NaN/negative cost) ────────────────

describe('a bad admin pricing override is sanitized', () => {
  it('drops non-numeric / negative / malformed entries, keeping only valid finite prices', async () => {
    const usage = await seededUsage();
    const bad = {
      claude: {
        'claude-opus-4-8': {inputPerMtok: 7, outputPerMtok: 3}, // valid → kept
        'claude-bad-neg': {inputPerMtok: -5, outputPerMtok: 1}, // negative → dropped
        'claude-bad-str': {inputPerMtok: 'abc', outputPerMtok: 1}, // non-numeric → dropped
        'claude-bad-nan': {inputPerMtok: Number.NaN, outputPerMtok: 1}, // NaN → dropped
        'claude-bad-shape': 'nope', // not an object → dropped
      },
      openai: {'gpt-x': {inputPerMtok: Infinity, outputPerMtok: 2}}, // non-finite → dropped (empties provider)
    } as unknown as AiPricingTable;

    const res = await usage.setPricingOverride(bad);
    expect(res.override.claude).toEqual({'claude-opus-4-8': {inputPerMtok: 7, outputPerMtok: 3}});
    expect(res.override.openai).toBeUndefined(); // no valid model → provider omitted

    // No NaN/negative leaks into the effective (merged) table used to snapshot cost.
    for (const models of Object.values(res.effective)) {
      for (const price of Object.values(models ?? {})) {
        expect(Number.isFinite(price.inputPerMtok) && price.inputPerMtok >= 0).toBe(true);
        expect(Number.isFinite(price.outputPerMtok) && price.outputPerMtok >= 0).toBe(true);
      }
    }
  });

  it('coerces numeric strings and keeps valid optional cache prices (dropping a bad one)', async () => {
    const usage = await seededUsage();
    const res = await usage.setPricingOverride({
      claude: {'claude-opus-4-8': {inputPerMtok: '9', outputPerMtok: '4', cacheReadPerMtok: '0.5', cacheWritePerMtok: -1}},
    } as unknown as AiPricingTable);
    // strings coerced; the negative cacheWrite dropped rather than snapshotted.
    expect(res.override.claude?.['claude-opus-4-8']).toEqual({inputPerMtok: 9, outputPerMtok: 4, cacheReadPerMtok: 0.5});
  });
});

// ── Provider SSE / usage parsers (Fix 3 — coverage for the bug-prone code) ────

describe('provider usage parsers surface onUsage exactly once', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('AnthropicEngine folds message_start (+cache) and the cumulative message_delta output', async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1,"cache_read_input_tokens":40,"cache_creation_input_tokens":10}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":55}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(sse, {status: 200})));

    const engine = new AnthropicEngine('sk-ant-api-test', 'claude-opus-4-8');
    const usages: TokenUsage[] = [];
    const text = await engine.generate('go', {onToken: () => undefined, onUsage: (u) => usages.push(u)});
    expect(text).toBe('Hi');
    expect(usages).toEqual([{inputTokens: 100, outputTokens: 55, cacheReadTokens: 40, cacheWriteTokens: 10}]);
  });

  it('OpenAiCompatEngine reads the trailing include_usage chunk', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":" world"}}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":22}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(sse, {status: 200})));

    const engine = new OpenAiCompatEngine('http://localhost:11434', 'test-model');
    const usages: TokenUsage[] = [];
    const text = await engine.generate('go', {onToken: () => undefined, onUsage: (u) => usages.push(u)});
    expect(text).toBe('Hello world');
    expect(usages).toEqual([{inputTokens: 11, outputTokens: 22}]);
  });

  it('LlamaEngine counts input/output via the model tokenizer', async () => {
    const engine = new LlamaEngine('/models', 'model.gguf');
    // Inject a fake loaded model + modules so ensureReady() short-circuits and the
    // tokenize path runs without the optional native dependency.
    const fakeModel = {
      createContext: async () => ({getSequence: () => ({}), dispose: async () => undefined}),
      tokenize: (t: string) => ({length: t.trim() ? t.trim().split(/\s+/).length : 0}),
    };
    class FakeSession {
      constructor(_opts: unknown) {
        void _opts;
      }
      async prompt(_text: string, opts: {onTextChunk: (c: string) => void}): Promise<string> {
        const out = 'hello world out';
        opts.onTextChunk(out);
        return out;
      }
    }
    const injected = engine as unknown as {model: unknown; modules: unknown};
    injected.model = fakeModel;
    injected.modules = {LlamaChatSession: FakeSession};

    const usages: TokenUsage[] = [];
    await engine.generate('prompt one two', {system: 'sys a', onToken: () => undefined, onUsage: (u) => usages.push(u)});
    // input = tokenize(prompt=3) + tokenize(system=2) = 5; output = tokenize(out=3) = 3.
    expect(usages).toEqual([{inputTokens: 5, outputTokens: 3}]);
  });
});
