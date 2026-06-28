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
  guestPrincipal,
  signIdentity,
  mintIdentityKeypair,
  type AiProvider,
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
import type {AiEngine} from './ai/providers';
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

// ── Agent tool surface: per-principal gating (OB-190 follow-up) ───────────────
//
// The AgentRunner's autonomous tools must read/write only what the run's
// principal may — the SAME matrix as ai/search and the content routes above, but
// now driven THROUGH the agent. We script one tool call per run (the JSON
// protocol: emit `{"tool":…}`, then `{"final":…}`) and assert on the tool_result
// frame the model would see. The runner is built with the principal directly (the
// route threads `c.get('principal')` the same way).

/** A 2-turn JSON-protocol engine: call `tool(args)` once, then answer. */
const scriptEngine = (tool: string, args: Record<string, unknown>): AiEngine => ({
  kind: 'mock',
  async ensureReady() {
    /* always ready */
  },
  async generate(prompt, opts) {
    const out = prompt.includes('TOOL RESULT') ? JSON.stringify({final: 'ok'}) : JSON.stringify({tool, args});
    opts.onToken(out);
    return out;
  },
  async dispose() {
    /* nothing to release */
  },
});

/** An AiService whose AGENT engine is scripted; the real `search` is inherited. */
class ScriptedAi extends AiService {
  scripted: AiEngine = scriptEngine('list_pages', {});
  async engineForRequest(): Promise<{engine: AiEngine; transient: boolean}> {
    return {engine: this.scripted, transient: false};
  }
}

/** Run ONE agent tool as `principal` (undefined ⇒ default-deny) and return the
 *  tool_result text the model would see. */
const runToolAs = async (
  principal: Principal | undefined,
  tool: string,
  args: Record<string, unknown>,
  runOpts: {allowDirectEdits?: boolean} = {},
): Promise<string> => {
  const ai = new ScriptedAi(db, join(dir, 'models'));
  ai.scripted = scriptEngine(tool, args);
  const runner = new AgentRunner(ai, store, {principal, thinking: false, ...runOpts});
  let result = '';
  await runner.run([{role: 'user', content: 'go'}], (ev) => {
    if (ev.type === 'tool_result' && ev.name === tool) result = ev.result;
  });
  return result;
};

describe('agent read tools are gated per principal', () => {
  const TOKEN = 'quokkaql';
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

  it('read_page hides a restricted page from a non-grantee but not the owner/grantee', async () => {
    expect(await runToolAs(principal('owner'), 'read_page', {pageId: restr})).toContain(`${TOKEN}-restricted`);
    expect(await runToolAs(principal('granted'), 'read_page', {pageId: restr})).toContain(`${TOKEN}-restricted`);
    expect(await runToolAs(principal('viewer'), 'read_page', {pageId: restr})).toBe('Page not found.');
    expect(await runToolAs(principal('stranger'), 'read_page', {pageId: mem})).toBe('Page not found.');
    expect(await runToolAs(guestPrincipal(), 'read_page', {pageId: mem})).toBe('Page not found.');
  });

  it('inspect_page_structure and get_kit_values are read-gated too', async () => {
    expect(await runToolAs(principal('viewer'), 'inspect_page_structure', {pageId: restr})).toBe('Page not found.');
    expect(await runToolAs(principal('viewer'), 'get_kit_values', {pageId: restr})).toBe('Page not found.');
  });

  it('list_pages returns only the pages the caller may read', async () => {
    const owner = await runToolAs(principal('owner'), 'list_pages', {});
    expect(owner).toContain(pub);
    expect(owner).toContain(mem);
    expect(owner).toContain(restr);
    const viewer = await runToolAs(principal('viewer'), 'list_pages', {});
    expect(viewer).toContain(pub);
    expect(viewer).toContain(mem);
    expect(viewer).not.toContain(restr);
    const stranger = await runToolAs(principal('stranger'), 'list_pages', {});
    expect(stranger).toContain(pub);
    expect(stranger).not.toContain(mem);
    expect(stranger).not.toContain(restr);
  });

  it('search_notes snippets are filtered per principal (canRead threaded through)', async () => {
    const stranger = await runToolAs(principal('stranger'), 'search_notes', {query: TOKEN});
    expect(stranger).toContain(pub);
    expect(stranger).not.toContain(mem);
    expect(stranger).not.toContain(restr);
    const viewer = await runToolAs(principal('viewer'), 'search_notes', {query: TOKEN});
    expect(viewer).toContain(mem);
    expect(viewer).not.toContain(restr);
  });

  it('default-deny: a runner with NO principal reads nothing', async () => {
    expect(await runToolAs(undefined, 'read_page', {pageId: pub})).toBe('Page not found.');
    expect(await runToolAs(undefined, 'list_pages', {})).toBe('No pages.');
    expect(await runToolAs(undefined, 'search_notes', {query: TOKEN})).toBe('No matching notes.');
  });
});

describe('agent database tools are gated per principal', () => {
  let hostPage: string;

  beforeEach(async () => {
    await claim();
    await store.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
    hostPage = (await store.upsertPage({name: `db-host-${seq}`, data: snapshot()})).id;
    await store.createDatabase({pageId: hostPage, name: 'Secret DB', schema: {properties: [], views: []}});
    const dbId = (await store.getDatabaseByPage(hostPage))!.id;
    await store.createRow(dbId, {name: 'row-1', properties: {}});
    await store.setPageVisibility(hostPage, 'restricted');
  });

  it('describe_database / list_db_views hide a restricted db from a non-member (no oracle)', async () => {
    expect(await runToolAs(principal('owner'), 'describe_database', {pageId: hostPage})).toContain('Secret DB');
    expect(await runToolAs(principal('viewer'), 'describe_database', {pageId: hostPage})).toBe('That page hosts no database.');
    expect(await runToolAs(principal('stranger'), 'list_db_views', {pageId: hostPage})).toBe('That page hosts no database.');
    expect(await runToolAs(undefined, 'describe_database', {pageId: hostPage})).toBe('That page hosts no database.');
  });

  it('a structural write tool (create_property) requires write on the host (viewer denied)', async () => {
    expect(await runToolAs(principal('viewer'), 'create_property', {pageId: hostPage, name: 'Notes', type: 'text'})).toBe(
      'That page hosts no database.',
    );
    expect(await runToolAs(principal('owner'), 'create_property', {pageId: hostPage, name: 'Notes', type: 'text'})).toContain(
      'Added column',
    );
  });
});

describe('agent update_row enforces per-row read access (N5)', () => {
  // A database whose HOST page is writable by a NON-ADMIN (an ACL-write grantee,
  // no roster role), with one row the writer may read and one individually
  // read-restricted row it may not. update_row write-gates the host but must read
  // the merge base through the per-row access-aware accessor (mirrors set_db_cell),
  // so the restricted row is neither confirmable, title-leaked, nor writable.
  let hostPage: string;
  let dbId: string;
  let openRow: string;
  let secretRow: string;

  beforeEach(async () => {
    await claim();
    hostPage = (await store.upsertPage({name: `db-rows-${seq}`, data: snapshot()})).id;
    await store.createDatabase({pageId: hostPage, name: 'Roster DB', schema: {properties: [], views: []}});
    dbId = (await store.getDatabaseByPage(hostPage))!.id;
    openRow = (await store.createRow(dbId, {name: 'open-row', properties: {}})).id;
    secretRow = (await store.createRow(dbId, {name: 'secret-row', properties: {}})).id;
    // Non-admin host-writer: ACL write on the host (read+write), no roster role.
    await store.setPageVisibility(hostPage, 'restricted');
    await store.setPageAcl(hostPage, {subject: `${ISS}#editor`, level: 'write'});
    // The writer may read ONE row; the other inherits the host's restricted scope
    // with no grant → invisible to the writer.
    await store.setPageAcl(openRow, {subject: `${ISS}#editor`, level: 'read'});
  });

  it('a non-admin host-writer cannot confirm, title-leak, or write a read-restricted row', async () => {
    const before = (await store.listRows(dbId)).find((r) => r.id === secretRow)!.name;
    const res = await runToolAs(principal('editor'), 'update_row', {pageId: hostPage, rowId: secretRow, name: 'pwned'});
    // Same opaque "not found" the read tools give — no existence oracle, no title echo.
    expect(res).toBe('Row not found in this database.');
    expect(res).not.toContain('secret-row');
    // …and the row is untouched in the store.
    const after = (await store.listRows(dbId)).find((r) => r.id === secretRow)!.name;
    expect(after).toBe(before);
    expect(after).not.toBe('pwned');
  });

  it('the writer still updates a row it CAN read; owner updates the restricted one', async () => {
    expect(await runToolAs(principal('editor'), 'update_row', {pageId: hostPage, rowId: openRow, name: 'edited'})).toContain(
      'Updated row',
    );
    expect((await store.listRows(dbId)).find((r) => r.id === openRow)!.name).toBe('edited');
    expect(await runToolAs(principal('owner'), 'update_row', {pageId: hostPage, rowId: secretRow, name: 'owner-edit'})).toContain(
      'Updated row',
    );
    expect((await store.listRows(dbId)).find((r) => r.id === secretRow)!.name).toBe('owner-edit');
  });
});

describe('agent write/structural tools enforce write access', () => {
  let mem: string;

  beforeEach(async () => {
    await claim();
    await store.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
    mem = (await store.upsertPage({name: `writable-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(mem, 'members');
  });

  it('create_page needs instance write — owner yes; viewer/stranger/guest/no-principal no', async () => {
    expect(await runToolAs(principal('owner'), 'create_page', {title: `agent-made-${seq}`})).toContain('Created page');
    expect(await runToolAs(principal('viewer'), 'create_page', {title: `nope-v-${seq}`})).toContain('do not have permission');
    expect(await runToolAs(principal('stranger'), 'create_page', {title: `nope-s-${seq}`})).toContain('do not have permission');
    expect(await runToolAs(guestPrincipal(), 'create_page', {title: `nope-g-${seq}`})).toContain('do not have permission');
    expect(await runToolAs(undefined, 'create_page', {title: `nope-d-${seq}`})).toContain('do not have permission');
  });

  it('a direct-edit append to a readable-but-not-writable page is write-denied', async () => {
    // The viewer can READ the members page but is read-only → no direct apply.
    const denied = await runToolAs(principal('viewer'), 'append_to_page', {pageId: mem, content: 'hi'}, {allowDirectEdits: true});
    expect(denied).toBe('You do not have write access to that page.');
    // The owner's direct apply is accepted.
    const ok = await runToolAs(principal('owner'), 'append_to_page', {pageId: mem, content: 'hi'}, {allowDirectEdits: true});
    expect(ok).toContain('Applying directly');
  });
});

describe('legacy single-user (unclaimed) agent path is unaffected', () => {
  it('a guest still reads any page, lists everything, and creates pages', async () => {
    // No claim() → unclaimed: `authorize()` grants the guest blanket read/write
    // (guestAccess defaults to 'write'), exactly as the single-user server does today.
    const p = (await store.upsertPage({name: `legacy-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(p, 'members'); // even a members page is readable when unclaimed
    expect(await runToolAs(guestPrincipal(), 'read_page', {pageId: p})).toContain(`legacy-${seq}`);
    expect(await runToolAs(guestPrincipal(), 'list_pages', {})).toContain(p);
    expect(await runToolAs(guestPrincipal(), 'create_page', {title: `legacy-new-${seq}`})).toContain('Created page');
  });
});

// ── Paid-inference gate: a guest must not drive a paid engine (N6) ────────────
//
// On a CLAIMED (multi-user, network-exposable) instance with `guestAccess='write'`,
// an anonymous guest passes the request gate and could otherwise drive a PAID /
// hosted engine (openai/claude — billed per token) → cost / DoS. The generation
// routes must require a verified principal when the configured provider is paid,
// while leaving free/local providers, authenticated users, and the legacy
// (unclaimed, loopback-only) single-user path untouched.

describe('paid-provider inference is gated for guests on a claimed instance (N6)', () => {
  // A scripted agent engine so an ALLOWED run resolves instantly (no network to a
  // hosted provider); the gate keys off the CONFIGURED provider, not the run.
  const aiWith = async (provider: AiProvider): Promise<ScriptedAi> => {
    const ai = new ScriptedAi(db, join(dir, 'models'));
    ai.scripted = scriptEngine('list_pages', {});
    await ai.setConfig({
      provider,
      providers: {claude: {apiKey: 'test-key', model: 'm'}, openai: {baseUrl: 'http://127.0.0.1:9', model: 'm'}},
    });
    return ai;
  };

  const chat = (app: ReturnType<typeof appWith>, jws?: string) =>
    post(app, '/api/agent/chat', {messages: [{role: 'user', content: 'hi'}]}, jws);

  it('an anonymous guest is denied (403) when a paid provider (claude) is configured', async () => {
    await claim();
    const app = appWith({ai: await aiWith('claude')});
    expect((await chat(app)).status).toBe(403);
  });

  it('a paid provider stays open to an authenticated (owner) user', async () => {
    await claim();
    const app = appWith({ai: await aiWith('claude')});
    const res = await chat(app, await idFor('owner'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"done":true');
  });

  it('a free/local provider (mock) stays open to a guest', async () => {
    await claim();
    const app = appWith({ai: await aiWith('mock')});
    const res = await chat(app);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"done":true');
  });

  it('the sibling generation routes (generate/complete/tasks) are paid-gated for guests too', async () => {
    await claim();
    const app = appWith({ai: await aiWith('openai')});
    expect((await post(app, '/api/ai/generate', {prompt: 'x'})).status).toBe(403);
    expect((await post(app, '/api/ai/complete', {text: 'x'})).status).toBe(403);
    expect((await post(app, '/api/ai/tasks', {goal: 'x'})).status).toBe(403);
  });

  it('legacy single-user (unclaimed) is unaffected — a guest may still use a paid provider', async () => {
    // No claim() → ownerSubject undefined → loopback-only by the §2.6 exposure
    // invariant, so the paid gate stays open, preserving today's single-user flow.
    const app = appWith({ai: await aiWith('claude')});
    const res = await chat(app);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"done":true');
  });
});

// ── ai/search is paid-gated too: it embeds the query on a paid engine ─────────
//
// `ai/search` runs hybrid ranking by EMBEDDING the query (+ lexical candidates)
// whenever the engine can embed — for the paid `openai` provider that's a billed
// `/v1/embeddings` call — so an anonymous guest on a claimed instance could drive
// paid embeddings (the same billing-abuse class N6 closed for generation). The
// gate is ADDITIVE to the per-principal read filtering, which must still hold for
// the free path.

describe('paid-provider search is gated for guests on a claimed instance (N6)', () => {
  const TOKEN = 'pangolinql';

  // A free engine is in-process; the paid `openai` engine points at a dead port so
  // an ALLOWED run never makes a real embeddings call (empty index ⇒ no embed) —
  // the gate keys off the CONFIGURED provider, not the run.
  const aiWith = async (provider: AiProvider): Promise<ScriptedAi> => {
    const ai = new ScriptedAi(db, join(dir, 'models'));
    ai.scripted = scriptEngine('list_pages', {});
    await ai.setConfig({
      provider,
      providers: {claude: {apiKey: 'test-key', model: 'm'}, openai: {baseUrl: 'http://127.0.0.1:9', model: 'm'}},
    });
    return ai;
  };

  const search = (app: ReturnType<typeof appWith>, jws?: string) =>
    post(app, '/api/ai/search', {query: TOKEN, limit: 25}, jws);

  it('an anonymous guest is denied (403) when a paid provider (openai) is configured', async () => {
    await claim();
    const app = appWith({ai: await aiWith('openai')});
    expect((await search(app)).status).toBe(403); // claimed + paid + guest → 403
  });

  it('a paid provider stays open to a verified (owner) user', async () => {
    await claim();
    const app = appWith({ai: await aiWith('openai')});
    expect((await search(app, await idFor('owner'))).status).toBe(200);
  });

  it('a free/local provider (mock) stays open to a guest AND is still read-filtered', async () => {
    await claim();
    const pub = (await store.upsertPage({name: `${TOKEN}-public-${seq}`, data: snapshot()})).id;
    const restr = (await store.upsertPage({name: `${TOKEN}-restricted-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(pub, 'public');
    await store.setPageVisibility(restr, 'restricted');
    const app = appWith({ai: await aiWith('mock')});
    const res = await search(app); // guest
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as {results: Array<{pageId: string}>}).results.map((r) => r.pageId);
    // Free provider ⇒ no paid gate; the additive read filter still hides the
    // restricted page from the guest while surfacing the public one.
    expect(ids).toContain(pub);
    expect(ids).not.toContain(restr);
  });

  it('legacy single-user (unclaimed) is unaffected — a guest may still search on a paid provider', async () => {
    // No claim() → ownerSubject undefined → loopback-only, so the paid gate stays open.
    const app = appWith({ai: await aiWith('openai')});
    expect((await search(app)).status).toBe(200);
  });
});
