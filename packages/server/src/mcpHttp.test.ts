/**
 * Remote HTTP MCP transport suite (AGENT-5). In-process HTTP e2e over the real
 * `/api/mcp` handler + `WebStandardStreamableHTTPServerTransport` + the PAT loop-back
 * `HttpDataClient`, mirroring `packages/mcp/scripts/e2e.mts` over the HTTP transport.
 *
 * The load-bearing proofs:
 *  - DARK by default: agentApi off (or the kill-switch) → 404 (existence hidden).
 *  - No PAT → 401; a forwarded PAT never reaches the transport (loopback/LAN only).
 *  - A valid PAT speaks MCP: `initialize` + `tools/list` + read tools work.
 *  - SCOPE IS ENFORCED BY THE LOOP-BACK, not re-implemented in the MCP layer:
 *      · a READ PAT can read via MCP but every WRITE tool is refused (inner 403), and
 *      · a WRITE PAT's edits land as reviewable SUGGESTIONS (allowDirectEdits:false),
 *        NOT applied — visible in the review pane (`listSuggestions`).
 */

import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {FORWARDED_HEADER, type AgentTokenScope} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {IdentityService} from './instanceConfig';
import {AGENT_API_SETTING_KEY, generateAgentToken} from './agentTokens';

const ISS = 'https://account.book.pub';
const OWNER = `${ISS}#owner`;
let store: PageStore;
let dir: string;
let seq = 0;

const snapshot = () => ({editorjs: {blocks: []}, values: [], names: []});

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-mcphttp-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

const app = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});
const claim = () => store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks: {keys: []}}], ownerSubject: OWNER});
const enableAgentApi = () => store.setSetting(AGENT_API_SETTING_KEY, {enabled: true});

/** Mint a PAT directly in the store (returns the plaintext bearer to present). */
async function mintPat(scope: AgentTokenScope = 'read', subject = OWNER): Promise<string> {
  const {token, hash, preview} = generateAgentToken();
  await store.createAgentToken({name: 'mcp-test', tokenHash: hash, preview, subject, issuer: ISS, scope, createdBy: 'test', expiresAt: null});
  return token;
}

type App = ReturnType<typeof app>;

/** One JSON-RPC message over the streamable-HTTP transport (stateless JSON mode). */
async function rpc(
  a: App,
  pat: string | null,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{status: number; json: unknown}> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...extraHeaders,
  };
  if (pat) headers.Authorization = `Bearer ${pat}`;
  const res = await a.request('/api/mcp', {method: 'POST', headers, body: JSON.stringify(body)});
  const status = res.status;
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return {status, json};
}

let rpcId = 0;
const initMsg = () => ({
  jsonrpc: '2.0',
  id: (rpcId += 1),
  method: 'initialize',
  params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'e2e', version: '0'}},
});
const listMsg = () => ({jsonrpc: '2.0', id: (rpcId += 1), method: 'tools/list'});
const callMsg = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: (rpcId += 1),
  method: 'tools/call',
  params: {name, arguments: args},
});

/** The concatenated text of an MCP tool result (CallToolResult content blocks). */
const toolText = (json: unknown): string => {
  const result = (json as {result?: {content?: Array<{type: string; text?: string}>}})?.result;
  return (result?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
};
const toolIsError = (json: unknown): boolean =>
  (json as {result?: {isError?: boolean}})?.result?.isError === true;

// ── DARK by default + auth boundary ──────────────────────────────────────────────

describe('mcpHttp dark gate + auth boundary', () => {
  beforeEach(async () => {
    await claim();
  });

  it('agentApi OFF → 404 (existence hidden), even to an unauthenticated probe', async () => {
    const a = app();
    const res = await a.request('/api/mcp', {method: 'GET'});
    expect(res.status).toBe(404);
  });

  it('kill-switch env OFF → 404 even when the setting is enabled', async () => {
    await enableAgentApi();
    const prev = process.env.OPENBOOK_AGENT_API;
    process.env.OPENBOOK_AGENT_API = '0';
    try {
      const a = app();
      const res = await a.request('/api/mcp', {method: 'GET'});
      expect(res.status).toBe(404);
    } finally {
      if (prev === undefined) delete process.env.OPENBOOK_AGENT_API;
      else process.env.OPENBOOK_AGENT_API = prev;
    }
  });

  it('enabled but NO PAT → 401 (never guest/jws/hatch)', async () => {
    await enableAgentApi();
    const a = app();
    // A GET is never guest-write-blocked, so it reaches the handler, which requires a
    // PAT: no `agentToken` var → 401 (the endpoint admits ONLY a PAT, never a guest).
    const res = await a.request('/api/mcp', {method: 'GET', headers: {Accept: 'application/json, text/event-stream'}});
    expect(res.status).toBe(401);
  });

  it('a forwarded PAT never reaches the transport (loopback/LAN only)', async () => {
    await enableAgentApi();
    const a = app();
    const pat = await mintPat('read');
    // Sanity: it initializes fine without the forwarded marker.
    const ok = await rpc(a, pat, initMsg());
    expect(ok.status).toBe(200);
    // With the marker it is refused before ever touching the MCP transport (AGENT-6
    // 403s the forwarded PAT at resolution; the handler would 403 too). Not 200.
    const fwd = await rpc(a, pat, initMsg(), {[FORWARDED_HEADER]: '1'});
    expect(fwd.status).not.toBe(200);
    expect([401, 403]).toContain(fwd.status);
  });
});

// ── A valid PAT speaks MCP: handshake + catalogue + read tools ───────────────────

describe('mcpHttp handshake + read tools', () => {
  beforeEach(async () => {
    await claim();
    await enableAgentApi();
  });

  it('initialize reports the openbook server', async () => {
    const a = app();
    const pat = await mintPat('read');
    const {status, json} = await rpc(a, pat, initMsg());
    expect(status).toBe(200);
    const info = (json as {result?: {serverInfo?: {name?: string}; protocolVersion?: string}}).result;
    expect(info?.serverInfo?.name).toBe('openbook');
    expect(typeof info?.protocolVersion).toBe('string');
  });

  it('tools/list returns the tool catalogue', async () => {
    const a = app();
    const pat = await mintPat('read');
    const {json} = await rpc(a, pat, listMsg());
    const names = ((json as {result?: {tools?: Array<{name: string}>}}).result?.tools ?? []).map((t) => t.name);
    expect(names).toContain('list_pages');
    expect(names).toContain('read_page');
    expect(names).toContain('append_to_page');
    expect(names.length).toBeGreaterThanOrEqual(16);
  });

  it('read tools work through the loop-back (list_pages / read_page)', async () => {
    const a = app();
    const page = await store.upsertPage({name: `Planning-${seq}`, data: {editorjs: {blocks: [{type: 'paragraph', data: {text: 'budget forecast revision'}}]}, values: [], names: []}});
    const pat = await mintPat('read');
    const list = await rpc(a, pat, callMsg('list_pages'));
    expect(toolText(list.json)).toContain(page.id);
    const read = await rpc(a, pat, callMsg('read_page', {pageId: page.id}));
    expect(toolText(read.json)).toContain('budget forecast');
  });
});

// ── THE security model: scope enforced by the loop-back, not the MCP layer ───────

describe('mcpHttp scope is enforced by the PAT loop-back', () => {
  beforeEach(async () => {
    await claim();
    await enableAgentApi();
  });

  it('a READ PAT reads via MCP but every WRITE tool is refused (inner 403 → tool error)', async () => {
    const a = app();
    const page = await store.upsertPage({name: `doc-${seq}`, data: snapshot()});
    const pat = await mintPat('read');

    // Read works.
    const read = await rpc(a, pat, callMsg('read_page', {pageId: page.id}));
    expect(toolIsError(read.json)).toBe(false);

    // create_page → inner POST /api/pages (unsafe method, not in the read allowlist)
    // → scope-gate 403 → the tool reports an error.
    const create = await rpc(a, pat, callMsg('create_page', {title: `new-${seq}`, content: 'x'}));
    expect(toolIsError(create.json)).toBe(true);

    // append_to_page → inner getPage (GET, allowed) THEN createSuggestion
    // (POST /api/pages/:id/suggestions, denied for a read scope) → the tool errors.
    const append = await rpc(a, pat, callMsg('append_to_page', {pageId: page.id, content: 'sneaky'}));
    expect(toolIsError(append.json)).toBe(true);

    // NOTHING was written: no page created, no suggestion queued.
    expect((await store.listPages()).some((p) => p.name === `new-${seq}`)).toBe(false);
    expect(await store.listSuggestions(page.id)).toHaveLength(0);
  });

  it('a WRITE PAT edit lands as a reviewable SUGGESTION (not applied), visible in the review pane', async () => {
    const a = app();
    const page = await store.upsertPage({name: `wdoc-${seq}`, data: {editorjs: {blocks: [{type: 'paragraph', data: {text: 'original'}}]}, values: [], names: []}});
    const pat = await mintPat('write');

    const append = await rpc(a, pat, callMsg('append_to_page', {pageId: page.id, content: 'proposed addition'}));
    expect(append.status).toBe(200);
    expect(toolIsError(append.json)).toBe(false);
    // The tool tells the caller it was queued, not applied.
    expect(toolText(append.json)).toContain('Suggested for review');

    // The page CONTENT is unchanged (the write did NOT apply)…
    const after = await store.getPage(page.id);
    expect(JSON.stringify(after?.data)).not.toContain('proposed addition');

    // …and the review pane (listSuggestions) sees the queued suggestion.
    const suggestions = await store.listSuggestions(page.id);
    expect(suggestions.length).toBe(1);
    expect((suggestions[0].payload as {applyKind?: string}).applyKind).toBe('append_blocks');
  });

  it('a WRITE PAT may CREATE a page through the loop-back (creation is non-destructive)', async () => {
    const a = app();
    const pat = await mintPat('write');
    const create = await rpc(a, pat, callMsg('create_page', {title: `made-${seq}`, content: 'hello'}));
    expect(toolIsError(create.json)).toBe(false);
    expect((await store.listPages()).some((p) => p.name === `made-${seq}`)).toBe(true);
  });
});
