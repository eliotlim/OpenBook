/**
 * Route-level gating for the external-tools (MCP client) admin surface
 * (`/api/ai/mcp`). The manager's own logic is unit-tested in
 * `ai/mcpClients.test.ts`; here we assert the HTTP contract:
 *  - GET/PUT/test require `requireInstanceAdmin` (a claimed-instance non-admin 403s);
 *  - GET redacts (no token, `authTokenSet` flag) and reports `stdioAllowed`;
 *  - PUT validates (bad slug → 400) and enforces the trust-level stdio gate
 *    (stdio on a claimed instance → 400);
 *  - the test route refuses a stdio dry-run on a claimed instance without a network hop.
 */

import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mintIdentityKeypair, signIdentity, type IdentityKeypair, type Jwks, type McpConfigResponse} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {AiService} from './ai/service';
import {McpClientManager} from './ai/mcpClients';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';

const ISS = 'https://account.book.pub';
let store: PageStore;
let db: PgliteDb;
let dir: string;
let seq = 0;
let kp: IdentityKeypair;
let jwks: Jwks;

const ownerJws = (): Promise<string> =>
  signIdentity(
    kp.privateKey,
    {iss: ISS, sub: 'owner', name: 'owner', iat: Math.floor(Date.now() / 1000) - 30, exp: Math.floor(Date.now() / 1000) + 3600, jti: `jti-${Math.random()}`},
    kp.publicJwk.kid,
  );

const appWith = (mcp: McpClientManager) =>
  createApp(store, new AiService(db, join(dir, 'models')), new PageHub(), {identity: new IdentityService(store), mcp});

const req = (app: ReturnType<typeof appWith>, method: string, path: string, body?: unknown, jws?: string) =>
  app.request(path, {
    method,
    headers: {'Content-Type': 'application/json', ...(jws ? {[IDENTITY_HEADER]: jws} : {})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });

/** Claim the instance under `${ISS}#owner` (⇒ multi-user; stdio not allowed). */
const claim = () => store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], ownerSubject: `${ISS}#owner`});

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-mcproutes-${process.pid}-${seq}`);
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

describe('GET /api/ai/mcp', () => {
  it('a claimed-instance non-admin (guest) is refused (404/403 — no admin surface)', async () => {
    await claim();
    const app = appWith(new McpClientManager(store));
    const res = await req(app, 'GET', '/api/ai/mcp'); // no identity → guest
    expect([401, 403]).toContain(res.status);
  });

  it('the owner reads a redacted config + stdioAllowed (false once claimed)', async () => {
    await claim();
    const mcp = new McpClientManager(store);
    await mcp.setConfig({enabled: true, servers: [{id: 'srv', transport: 'http', url: 'http://127.0.0.1:9/mcp', enabled: false, authToken: 'secret'}]});
    const app = appWith(mcp);
    const res = await req(app, 'GET', '/api/ai/mcp', undefined, await ownerJws());
    expect(res.status).toBe(200);
    const body = (await res.json()) as McpConfigResponse;
    expect(body.stdioAllowed).toBe(false);
    expect(body.config.servers[0].authToken).toBeUndefined();
    expect(body.config.servers[0].authTokenSet).toBe(true);
  });
});

describe('PUT /api/ai/mcp (admin, validated)', () => {
  it('saves a valid HTTP server (redacted echo)', async () => {
    await claim();
    const app = appWith(new McpClientManager(store));
    const res = await req(app, 'PUT', '/api/ai/mcp', {enabled: true, servers: [{id: 'srv', transport: 'http', url: 'http://127.0.0.1:9/mcp', enabled: true, authToken: 'k'}]}, await ownerJws());
    expect(res.status).toBe(200);
    const body = (await res.json()) as McpConfigResponse;
    expect(body.config.servers[0].authTokenSet).toBe(true);
    expect(body.config.servers[0].authToken).toBeUndefined();
  });

  it('rejects an invalid slug with a 400', async () => {
    await claim();
    const app = appWith(new McpClientManager(store));
    const res = await req(app, 'PUT', '/api/ai/mcp', {enabled: true, servers: [{id: 'bad_id', transport: 'http', url: 'http://x/mcp', enabled: false}]}, await ownerJws());
    expect(res.status).toBe(400);
  });

  it('rejects a stdio server on a claimed instance with a 400 (trust-level gate)', async () => {
    await claim();
    const app = appWith(new McpClientManager(store));
    const res = await req(app, 'PUT', '/api/ai/mcp', {enabled: true, servers: [{id: 'srv', transport: 'stdio', command: 'echo', enabled: false}]}, await ownerJws());
    expect(res.status).toBe(400);
  });

  it('a non-admin cannot PUT', async () => {
    await claim();
    const app = appWith(new McpClientManager(store));
    const res = await req(app, 'PUT', '/api/ai/mcp', {enabled: true, servers: []}); // guest
    expect([401, 403]).toContain(res.status);
  });
});

describe('POST /api/ai/mcp/test', () => {
  it('refuses a stdio dry-run on a claimed instance (no network hop)', async () => {
    await claim();
    const app = appWith(new McpClientManager(store));
    const res = await req(app, 'POST', '/api/ai/mcp/test', {id: 'srv', transport: 'stdio', command: 'echo', enabled: false}, await ownerJws());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {ok: boolean; error?: string};
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not allowed/i);
  });
});
