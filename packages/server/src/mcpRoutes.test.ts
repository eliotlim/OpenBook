/**
 * Route-level gating for the external-tools (MCP client) owner surface
 * (`/api/ai/mcp`). The manager's own logic is unit-tested in
 * `ai/mcpClients.test.ts`; here we assert the HTTP contract:
 *  - GET/PUT/test require `requireInstanceOwner` (including while unclaimed);
 *  - GET redacts (no token, `authTokenSet` flag) and reports `stdioAllowed`;
 *  - stdio additionally requires the trusted local-owner transport capability;
 *  - the test route refuses a remote-owner stdio dry-run without a network hop.
 */

import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {LOCAL_OWNER_HEADER, mintIdentityKeypair, signIdentity, type IdentityKeypair, type Jwks, type McpConfigResponse} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {AiService} from './ai/service';
import {McpClientManager} from './ai/mcpClients';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';

const ISS = 'https://account.book.pub';
const LOCAL_OWNER_SECRET = 'mcp-routes-local-owner-secret';
const LOCAL_OWNER_HEADERS = {[LOCAL_OWNER_HEADER]: LOCAL_OWNER_SECRET};
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

const appWith = (mcp: McpClientManager, localOwnerSecret?: string) =>
  createApp(store, new AiService(db, join(dir, 'models')), new PageHub(), {
    identity: new IdentityService(store),
    mcp,
    localOwnerSecret,
  });

const req = (
  app: ReturnType<typeof appWith>,
  method: string,
  path: string,
  body?: unknown,
  jws?: string,
  extraHeaders: Record<string, string> = {},
) =>
  app.request(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-OpenBook-Client': '1',
      ...(jws ? {[IDENTITY_HEADER]: jws} : {}),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });

/** Claim the instance under `${ISS}#owner` (remote JWS owner still cannot use stdio). */
const claim = () => store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], ownerSubject: `${ISS}#owner`});

/** Spawn-boundary probe: any attempted connection increments `builds`. */
class SpawnProbeManager extends McpClientManager {
  builds = 0;
  protected buildTransport(): Transport {
    this.builds += 1;
    throw new Error('transport construction should not be reached');
  }
}

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

  it('a remote JWS owner reads a redacted config but is not granted stdio capability', async () => {
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

describe('PUT /api/ai/mcp (owner, validated)', () => {
  it('rejects an unclaimed anonymous guest but preserves local-owner stdio configuration', async () => {
    const mcp = new McpClientManager(store);
    const app = appWith(mcp, LOCAL_OWNER_SECRET);
    const config = {enabled: true, servers: [{id: 'srv', transport: 'stdio' as const, command: 'echo', enabled: false}]};

    const guest = await req(app, 'PUT', '/api/ai/mcp', config);
    expect(guest.status).toBe(403);
    expect((await mcp.getConfig()).servers).toEqual([]);

    const localOwner = await req(app, 'PUT', '/api/ai/mcp', config, undefined, LOCAL_OWNER_HEADERS);
    expect(localOwner.status).toBe(200);
    const body = (await localOwner.json()) as McpConfigResponse;
    expect(body.stdioAllowed).toBe(true);
    expect(body.config.servers[0]).toMatchObject({id: 'srv', transport: 'stdio', command: 'echo'});
  });

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

  it('rejects stdio from a claimed JWS owner without the local-owner transport capability', async () => {
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
  it('refuses a remote-owner stdio dry-run without a network hop', async () => {
    await claim();
    const app = appWith(new McpClientManager(store));
    const res = await req(app, 'POST', '/api/ai/mcp/test', {id: 'srv', transport: 'stdio', command: 'echo', enabled: false}, await ownerJws());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {ok: boolean; error?: string};
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/trusted local-owner/i);
  });
});

describe('POST /api/agent/chat stdio spawn authorization', () => {
  it('an unclaimed guest run cannot reach transport construction for an owner-stored stdio server', async () => {
    const mcp = new SpawnProbeManager(store);
    await mcp.setConfig(
      {enabled: true, servers: [{id: 'srv', transport: 'stdio', command: 'echo', enabled: true}]},
      {allowStdio: true},
    );
    const app = appWith(mcp);

    const res = await req(app, 'POST', '/api/agent/chat', {messages: [{role: 'user', content: 'hello'}]});
    expect(res.status).toBe(200);
    expect(mcp.builds).toBe(0);
    await res.text();
  });
});
