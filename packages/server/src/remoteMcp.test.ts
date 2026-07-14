/**
 * Remote MCP over the public edge (AGENT-7 / AGENT-10 origin side). Exercises the
 * ORIGIN half of the design: the conjunctive forwarded-guard, the per-token
 * `remote_ok` flag (migration 0017), the `agentApi.remote` setting + kill-switch, the
 * origin early-429 (R2), the `OPENBOOK_REQUIRE_REMOTE_FLAG` self-host hardening (R4),
 * remote-write suggestion confinement (R5), and the stateless transport (R6).
 *
 * The threat frame: a `Bearer obat_` request now arrives at the origin carrying the
 * `X-OpenBook-Forwarded` marker (stamped by the edge/tunnel). It may be admitted ONLY
 * on the exact `/api/mcp` path, ONLY when remote MCP is enabled, and ONLY for a token
 * whose row carries `remote_ok`. Every other forwarded path and every non-remote token
 * 403s exactly as before AGENT-7.
 */

import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  FORWARDED_HEADER,
  mintIdentityKeypair,
  signIdentity,
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
import {AGENT_API_SETTING_KEY, generateAgentToken} from './agentTokens';

const ISS = 'https://account.book.pub';
const OWNER = `${ISS}#owner`;
let store: PageStore;
let dir: string;
let seq = 0;
let kp: IdentityKeypair;
let jwks: Jwks;

const snapshot = () => ({editorjs: {blocks: []}, values: [], names: []});

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-remotemcp-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  kp = await mintIdentityKeypair('k1');
  jwks = {keys: [kp.publicJwk]};
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

const app = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});
const claim = () => store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], ownerSubject: OWNER});
/** Turn the LOCAL PAT feature on (remote still off). */
const enableAgentApi = () => store.setSetting(AGENT_API_SETTING_KEY, {enabled: true});
/** Turn the WHOLE stack on: local PAT + remote MCP. */
const enableRemote = () => store.setSetting(AGENT_API_SETTING_KEY, {enabled: true, remote: true});

const idFor = (sub: string): Promise<string> =>
  signIdentity(
    kp.privateKey,
    {iss: ISS, sub, name: sub, iat: Math.floor(Date.now() / 1000) - 30, exp: Math.floor(Date.now() / 1000) + 3600, jti: `jti-${sub}-${Math.random()}`},
    kp.publicJwk.kid,
  );

/** Mint a PAT directly in the store (returns the plaintext bearer to present). */
async function mintPat(opts: {scope?: AgentTokenScope; subject?: string; remoteOk?: boolean} = {}): Promise<string> {
  const {token, hash, preview} = generateAgentToken();
  await store.createAgentToken({
    name: 'remote-test',
    tokenHash: hash,
    preview,
    subject: opts.subject ?? OWNER,
    issuer: ISS,
    scope: opts.scope ?? 'read',
    createdBy: 'test',
    expiresAt: null,
    remoteOk: opts.remoteOk ?? false,
  });
  return token;
}

type App = ReturnType<typeof app>;

/** One JSON-RPC message over `/api/mcp`. `forwarded` stamps the edge marker. */
async function rpc(
  a: App,
  pat: string | null,
  body: unknown,
  opts: {forwarded?: boolean; extra?: Record<string, string>} = {},
): Promise<{status: number; json: unknown}> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(opts.extra ?? {}),
  };
  if (pat) headers.Authorization = `Bearer ${pat}`;
  if (opts.forwarded) headers[FORWARDED_HEADER] = '1';
  const res = await a.request('/api/mcp', {method: 'POST', headers, body: JSON.stringify(body)});
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return {status: res.status, json};
}

let rpcId = 0;
const initMsg = () => ({
  jsonrpc: '2.0',
  id: (rpcId += 1),
  method: 'initialize',
  params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'e2e', version: '0'}},
});
const callMsg = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: (rpcId += 1),
  method: 'tools/call',
  params: {name, arguments: args},
});
const toolText = (json: unknown): string => {
  const result = (json as {result?: {content?: Array<{type: string; text?: string}>}})?.result;
  return (result?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
};
const toolIsError = (json: unknown): boolean => (json as {result?: {isError?: boolean}})?.result?.isError === true;

const bearer = (token: string) => ({Authorization: `Bearer ${token}`});

/** Run `fn` with an env var set, restoring the prior value after. */
async function withEnv(key: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

// ── Migration 0017: every existing token is local-only ────────────────────────────

describe('migration 0017: remote_ok defaults false', () => {
  it('a token minted with no remote flag resolves as remote_ok=false and is refused a forwarded /api/mcp', async () => {
    await claim();
    await enableRemote();
    const a = app();
    const pat = await mintPat({subject: OWNER}); // no remoteOk
    // Local (non-forwarded) still works.
    expect((await rpc(a, pat, initMsg())).status).toBe(200);
    // Forwarded → 403 with the non-remote message (the token is not remote-flagged).
    const fwd = await rpc(a, pat, initMsg(), {forwarded: true});
    expect(fwd.status).toBe(403);
  });
});

// ── The conjunctive forwarded-guard ───────────────────────────────────────────────

describe('conjunctive forwarded-guard admits ONLY /api/mcp + remote-enabled + remote_ok', () => {
  beforeEach(async () => {
    await claim();
  });

  it('a forwarded remote_ok PAT on /api/mcp with remote enabled SPEAKS MCP (200)', async () => {
    await enableRemote();
    const a = app();
    const pat = await mintPat({subject: OWNER, remoteOk: true});
    const {status, json} = await rpc(a, pat, initMsg(), {forwarded: true});
    expect(status).toBe(200);
    const info = (json as {result?: {serverInfo?: {name?: string}}}).result;
    expect(info?.serverInfo?.name).toBe('openbook');
  });

  it('a forwarded remote_ok PAT on ANY OTHER /api/* path still 403s (only /api/mcp is admitted)', async () => {
    await enableRemote();
    const a = app();
    const pat = await mintPat({subject: OWNER, remoteOk: true});
    const res = await a.request('/api/pages', {headers: {...bearer(pat), [FORWARDED_HEADER]: '1'}});
    expect(res.status).toBe(403);
    // The forwarded (not the remote-access) message — the path leg failed before resolution.
    expect((await res.json() as {error: string}).error).toMatch(/forwarded/i);
  });

  it('a forwarded NON-remote token on /api/mcp → 403 (not enabled for remote access)', async () => {
    await enableRemote();
    const a = app();
    const pat = await mintPat({subject: OWNER, remoteOk: false});
    const fwd = await rpc(a, pat, initMsg(), {forwarded: true});
    expect(fwd.status).toBe(403);
  });

  it('remote setting OFF (local PAT only) → forwarded remote_ok PAT on /api/mcp 403s', async () => {
    await enableAgentApi(); // enabled but NOT remote
    const a = app();
    const pat = await mintPat({subject: OWNER, remoteOk: true});
    expect((await rpc(a, pat, initMsg(), {forwarded: true})).status).toBe(403);
    // …while a LOCAL (non-forwarded) request with the same token still works.
    expect((await rpc(a, pat, initMsg())).status).toBe(200);
  });

  it('the remote kill-switch OPENBOOK_AGENT_MCP_REMOTE=0 kills remote even with the setting on', async () => {
    await enableRemote();
    await withEnv('OPENBOOK_AGENT_MCP_REMOTE', '0', async () => {
      const a = app();
      const pat = await mintPat({subject: OWNER, remoteOk: true});
      expect((await rpc(a, pat, initMsg(), {forwarded: true})).status).toBe(403);
      // Local PAT auth is UNAFFECTED by the remote-only kill-switch.
      expect((await rpc(a, pat, initMsg())).status).toBe(200);
    });
  });

  it('the existing OPENBOOK_AGENT_API=0 kill-switch still kills EVERYTHING (local + remote)', async () => {
    await enableRemote();
    await withEnv('OPENBOOK_AGENT_API', '0', async () => {
      const a = app();
      const pat = await mintPat({subject: OWNER, remoteOk: true});
      expect((await rpc(a, pat, initMsg(), {forwarded: true})).status).toBe(403);
      // Local too: dark → the endpoint 404s (existence hidden) with no PAT resolved.
      const local = await a.request('/api/pages', {headers: bearer(pat)});
      expect(local.status).toBe(401);
    });
  });

  it('local MCP + LAN PAT flows are byte-identical (regression: no forwarded marker)', async () => {
    await enableRemote();
    const a = app();
    const localToken = await mintPat({subject: OWNER, remoteOk: false});
    const page = await store.upsertPage({name: `p-${seq}`, data: {editorjs: {blocks: [{type: 'paragraph', data: {text: 'budget'}}]}, values: [], names: []}});
    // A plain local (non-remote) token still speaks MCP and reads over the loopback.
    expect((await rpc(a, localToken, initMsg())).status).toBe(200);
    const read = await rpc(a, localToken, callMsg('read_page', {pageId: page.id}));
    expect(toolText(read.json)).toContain('budget');
    // And the plain REST surface still resolves it locally.
    expect((await a.request('/api/pages', {headers: bearer(localToken)})).status).toBe(200);
  });
});

// ── R2: origin early-429 sheds a forwarded garbage flood before the DB lookup ──────

describe('R2 origin early-429 (§3.4.7)', () => {
  it('a forwarded garbage-PAT flood early-429s and STOPS re-hitting resolveAgentToken', async () => {
    await claim();
    await enableRemote();
    const a = app();

    // Count DB resolutions so we can prove the limiter sheds BEFORE the lookup.
    let resolveCalls = 0;
    const realResolve = store.resolveAgentToken.bind(store);
    store.resolveAgentToken = async (hash: string) => {
      resolveCalls += 1;
      return realResolve(hash);
    };

    let saw429 = false;
    for (let i = 0; i < 20; i += 1) {
      // Distinct garbage tokens, all on the admitted /api/mcp path so they reach the
      // dark-gate + limiter (path/remote-enabled legs pass; the token never resolves).
      const res = await rpc(a, `obat_garbage-${i}-${seq}`, initMsg(), {forwarded: true});
      if (res.status === 429) saw429 = true;
    }
    expect(saw429).toBe(true);
    // The FAILED-PAT limit is 10; the 11th failure trips it, and every request after is
    // shed by the pre-lookup peek — so resolveAgentToken is called at most 11 times even
    // though 20 requests arrived. (Proves the lookup work is shed, not just the status.)
    expect(resolveCalls).toBeLessThanOrEqual(11);
  });
});

// ── R4: OPENBOOK_REQUIRE_REMOTE_FLAG closes the self-host direct-dial residual ─────

describe('R4 OPENBOOK_REQUIRE_REMOTE_FLAG (self-host direct-dial hardening)', () => {
  it('when set, a MARKER-LESS local (non-remote) token is refused (403) — closes T2', async () => {
    await claim();
    await enableRemote();
    await withEnv('OPENBOOK_REQUIRE_REMOTE_FLAG', '1', async () => {
      const a = app();
      const localToken = await mintPat({subject: OWNER, remoteOk: false});
      // No forwarded marker (direct dial), yet the require-flag forces the remote
      // conjunction: a non-remote token 403s.
      const res = await a.request('/api/pages', {headers: bearer(localToken)});
      expect(res.status).toBe(403);
    });
  });

  it('when set, a MARKER-LESS remote_ok token still works AND its loop-back resolves', async () => {
    await claim();
    await enableRemote();
    await withEnv('OPENBOOK_REQUIRE_REMOTE_FLAG', '1', async () => {
      const a = app();
      const remoteToken = await mintPat({subject: OWNER, remoteOk: true});
      const page = await store.upsertPage({name: `r4-${seq}`, data: {editorjs: {blocks: [{type: 'paragraph', data: {text: 'field notes'}}]}, values: [], names: []}});
      // Direct REST path (no marker) resolves for a remote token under the flag.
      expect((await a.request('/api/pages', {headers: bearer(remoteToken)})).status).toBe(200);
      // MCP + its inner loop-back (list_pages → inner GET /api/pages, marker-less) still
      // resolve — the loop-back is NOT bricked by the require-flag.
      expect((await rpc(a, remoteToken, initMsg())).status).toBe(200);
      const read = await rpc(a, remoteToken, callMsg('read_page', {pageId: page.id}));
      expect(toolText(read.json)).toContain('field notes');
    });
  });

  it('is DEFAULT OFF: a marker-less local token resolves normally without the env', async () => {
    await claim();
    await enableRemote();
    const a = app();
    const localToken = await mintPat({subject: OWNER, remoteOk: false});
    expect((await a.request('/api/pages', {headers: bearer(localToken)})).status).toBe(200);
  });
});

// ── R5: a WRITE-scoped REMOTE token stays suggestion-only (never an applied change) ─

describe('R5 remote writes are suggestion-only', () => {
  it('a forwarded WRITE remote token cannot produce an applied change — it lands as a suggestion', async () => {
    await claim();
    await enableRemote();
    const a = app();
    const page = await store.upsertPage({name: `w-${seq}`, data: {editorjs: {blocks: [{type: 'paragraph', data: {text: 'original'}}]}, values: [], names: []}});
    const pat = await mintPat({scope: 'write', subject: OWNER, remoteOk: true});

    const append = await rpc(a, pat, callMsg('append_to_page', {pageId: page.id, content: 'proposed remote addition'}), {forwarded: true});
    expect(append.status).toBe(200);
    expect(toolIsError(append.json)).toBe(false);
    expect(toolText(append.json)).toContain('Suggested for review');

    // The page CONTENT is unchanged — the write did NOT apply (allowDirectEdits:false).
    const after = await store.getPage(page.id);
    expect(JSON.stringify(after?.data)).not.toContain('proposed remote addition');

    // The suggestion queued in the review pane instead.
    const suggestions = await store.listSuggestions(page.id);
    expect(suggestions.length).toBe(1);
  });

  it('a forwarded WRITE remote token cannot flip visibility or ACL (sharing is never a PAT surface)', async () => {
    await claim();
    await enableRemote();
    const a = app();
    const remoteToken = await mintPat({scope: 'write', subject: OWNER, remoteOk: true});
    const page = await store.upsertPage({name: `s-${seq}`, data: snapshot()});
    // These forwarded requests are on non-/api/mcp paths → 403 at the conjunctive guard
    // (before even reaching the sharing scope-gate). Either way: never an applied share.
    const vis = await a.request(`/api/pages/${page.id}/visibility`, {
      method: 'PUT',
      headers: {...bearer(remoteToken), 'Content-Type': 'application/json', [FORWARDED_HEADER]: '1'},
      body: JSON.stringify({visibility: 'public'}),
    });
    expect(vis.status).toBe(403);
  });
});

// ── R6: GET/SSE on remote /api/mcp yields no long-lived/hijackable stream ──────────

describe('R6 stateless transport: no hijackable GET/SSE stream', () => {
  it('a forwarded GET /api/mcp mints NO session id and holds NO long-lived stream (stateless)', async () => {
    await claim();
    await enableRemote();
    const a = app();
    const pat = await mintPat({subject: OWNER, remoteOk: true});
    const res = await a.request('/api/mcp', {
      method: 'GET',
      headers: {...bearer(pat), Accept: 'application/json, text/event-stream', [FORWARDED_HEADER]: '1'},
    });
    // No `mcp-session-id` is ever minted (`sessionIdGenerator: undefined`) → there is no
    // session to hijack or resume. This is the load-bearing R6 invariant.
    expect(res.headers.get('mcp-session-id')).toBeNull();
    // Whatever the transport returns, the body drains to EMPTY promptly — the per-request
    // server is torn down immediately (no per-session memory, no long-lived push channel
    // an attacker could keep open or exfiltrate through). A hanging stream would time the
    // test out; an empty immediate drain proves it is closed.
    const body = await res.text();
    expect(body).toBe('');
  });

  it('a POST session-init cannot establish a resumable session (no session id echoed back)', async () => {
    await claim();
    await enableRemote();
    const a = app();
    const pat = await mintPat({subject: OWNER, remoteOk: true});
    // Even the initialize handshake never yields a session id in stateless mode, so a
    // client can never present `mcp-session-id` on a follow-up to resume server state.
    const res = await a.request('/api/mcp', {
      method: 'POST',
      headers: {...bearer(pat), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', [FORWARDED_HEADER]: '1'},
      body: JSON.stringify(initMsg()),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });
});

// ── Mint flow: remote requires remote-enabled + enforced short TTL (Q-a) ───────────

describe('minting remote tokens', () => {
  const mintReq = (a: App, body: unknown) =>
    (async () => {
      const jws = await idFor('owner');
      return a.request('/api/agent-tokens', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', [IDENTITY_HEADER]: jws},
        body: JSON.stringify(body),
      });
    })();

  it('minting a remote token REQUIRES remote MCP enabled (409 while only local is on)', async () => {
    await claim();
    await enableAgentApi(); // local only
    const a = app();
    const res = await mintReq(a, {name: 'r', remote: true});
    expect(res.status).toBe(409);
  });

  it('with remote enabled, a remote token mints, defaults TTL to 30 days, and reports remote:true', async () => {
    await claim();
    await enableRemote();
    const a = app();
    const res = await mintReq(a, {name: 'r', scope: 'read', remote: true});
    expect(res.status).toBe(201);
    const body = (await res.json()) as {meta: {remote: boolean; expiresAt: string | null}};
    expect(body.meta.remote).toBe(true);
    expect(body.meta.expiresAt).not.toBeNull();
    const days = (new Date(body.meta.expiresAt as string).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it('a remote token REJECTS no-expiry (null) and TTL > 90 days (400)', async () => {
    await claim();
    await enableRemote();
    const a = app();
    expect((await mintReq(a, {name: 'r', remote: true, expiresInDays: null})).status).toBe(400);
    expect((await mintReq(a, {name: 'r', remote: true, expiresInDays: 120})).status).toBe(400);
  });

  it('a LOCAL token still allows no-expiry and defaults remote_ok=false', async () => {
    await claim();
    await enableRemote();
    const a = app();
    const res = await mintReq(a, {name: 'l', expiresInDays: null});
    expect(res.status).toBe(201);
    const body = (await res.json()) as {meta: {remote: boolean; expiresAt: string | null}};
    expect(body.meta.remote).toBe(false);
    expect(body.meta.expiresAt).toBeNull();
  });
});
