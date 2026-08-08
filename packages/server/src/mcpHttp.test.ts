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
import {
  FORWARDED_HEADER,
  LOCAL_OWNER_HEADER,
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
  dir = join(tmpdir(), `ob-mcphttp-${process.pid}-${seq}`);
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
const enableAgentApi = () => store.setSetting(AGENT_API_SETTING_KEY, {enabled: true});

/** A validly-signed identity JWS for `sub` (verifies against the claimed jwks). */
const idFor = (sub: string): Promise<string> =>
  signIdentity(
    kp.privateKey,
    {iss: ISS, sub, name: sub, iat: Math.floor(Date.now() / 1000) - 30, exp: Math.floor(Date.now() / 1000) + 3600, jti: `jti-${sub}-${Math.random()}`},
    kp.publicJwk.kid,
  );

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

  it('an oversized JSON-RPC body is refused (413) — bodyLimit DoS parity', async () => {
    const a = app();
    const pat = await mintPat('read');
    // > 1 MiB body from a valid PAT holder: the route bodyLimit 413s before the handler.
    const huge = {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'create_page', arguments: {title: 't', content: 'x'.repeat(1024 * 1024 + 1024)}}};
    const res = await a.request('/api/mcp', {
      method: 'POST',
      headers: {Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream'},
      body: JSON.stringify(huge),
    });
    expect(res.status).toBe(413);
  });

  it('tools/list returns the tool catalogue', async () => {
    const a = app();
    const pat = await mintPat('read');
    const {json} = await rpc(a, pat, listMsg());
    const names = ((json as {result?: {tools?: Array<{name: string}>}}).result?.tools ?? []).map((t) => t.name);
    expect(names).toContain('list_pages');
    expect(names).toContain('read_page');
    expect(names).toContain('append_to_page');
    // API-4: the block write tools are on the REMOTE surface too (one server, two
    // transports — `mountMcpHttp` mounts the very same `createOpenBookMcpServer`).
    expect(names).toContain('delete_block');
    expect(names).toContain('update_block_props');
    expect(names.length).toBeGreaterThanOrEqual(18);
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

// ── Parity smoke: nested children + the block write tools over the REMOTE transport ─
//
// `mountMcpHttp` mounts the SAME `createOpenBookMcpServer` the stdio connector uses, so
// the tool behaviour is proven in `packages/mcp/scripts/blocks.test.mts`. What must be
// re-proven HERE is that it survives the remote path end to end: the JSON-RPC arguments
// (a deeply nested `children` tree) cross the streamable-HTTP transport intact, and the
// resulting write goes through the PAT loop-back (savePage under the page's resolved
// agent-edits policy) rather than any privileged shortcut.

describe('mcpHttp nested append + delete_block over the remote transport', () => {
  /** A block-editor page whose agent-edits policy is `direct` (so writes apply). */
  const directBlockPage = async (name: string) => {
    const page = await store.upsertPage({
      name,
      data: {
        editor: 'blocks',
        blockdoc: {blocks: [{id: 'seed', type: 'paragraph', text: [{t: 'seed'}]}]},
        editorjs: {blocks: []},
        values: [],
        names: [],
      },
    });
    await store.setPageAgentEdits(page.id, 'direct');
    return page;
  };

  /** The stored blockdoc projection of a page. */
  const blocks = async (id: string): Promise<Array<{id: string; type: string; text?: Array<{t: string}>; children?: unknown[]}>> =>
    ((await store.getPage(id))?.data.blockdoc as {blocks?: Array<{id: string; type: string; text?: Array<{t: string}>; children?: unknown[]}>})?.blocks ?? [];

  beforeEach(async () => {
    await claim();
    await enableAgentApi();
  });

  it('a nested table payload crosses the transport intact and materializes as table → row → cell', async () => {
    const a = app();
    const page = await directBlockPage(`remote-nested-${seq}`);
    const pat = await mintPat('write');

    const res = await rpc(
      a,
      pat,
      callMsg('append_blocks', {
        pageId: page.id,
        blocks: [
          {
            type: 'table',
            children: [
              {type: 'row', props: {header: true}, children: [{type: 'cell', text: 'Item'}, {type: 'cell', text: 'Qty'}]},
              {type: 'row', children: [{type: 'cell', text: 'Apples'}, {type: 'cell', text: '3'}]},
            ],
          },
        ],
      }),
    );
    expect(toolIsError(res.json)).toBe(false);
    expect(toolText(res.json)).toContain('directly');

    const stored = await blocks(page.id);
    const table = stored.find((b) => b.type === 'table') as {children?: Array<{children?: Array<{text?: Array<{t: string}>}>}>} | undefined;
    // Pre-API-1 this was an empty `{type:'table'}` — the schema stripped `children`
    // and the projection dropped them again.
    expect(table?.children).toHaveLength(2);
    expect(table?.children?.map((r) => r.children?.map((c) => c.text?.[0].t))).toEqual([
      ['Item', 'Qty'],
      ['Apples', '3'],
    ]);
  });

  it('delete_block removes a NESTED block through the loop-back, and an unknown id errors cleanly', async () => {
    const a = app();
    const page = await directBlockPage(`remote-delete-${seq}`);
    const pat = await mintPat('write');

    await rpc(a, pat, callMsg('append_blocks', {pageId: page.id, blocks: [{type: 'group', children: [{type: 'paragraph', text: 'inner'}]}]}));
    const nestedId = (
      (await blocks(page.id)).find((b) => b.type === 'group') as {children?: Array<{id: string}>} | undefined
    )?.children?.[0].id as string;
    expect(nestedId).toBeTruthy();

    const del = await rpc(a, pat, callMsg('delete_block', {pageId: page.id, blockId: nestedId}));
    expect(toolIsError(del.json)).toBe(false);
    const group = (await blocks(page.id)).find((b) => b.type === 'group') as {children?: unknown[]} | undefined;
    expect(group?.children).toEqual([]); // the container stayed, its child is gone
    expect(JSON.stringify(await store.getPage(page.id))).not.toContain('inner');

    const ghost = await rpc(a, pat, callMsg('delete_block', {pageId: page.id, blockId: 'no-such-block'}));
    expect(toolIsError(ghost.json)).toBe(true);
    expect(toolText(ghost.json)).toContain('inspect_page_structure');
  });

  // API-3 smoke: one table STRUCTURE op over the remote transport. The ops' own
  // behaviour is proven in `packages/mcp/scripts/tables.test.mts`; what matters here
  // is that a table tool's RENDER-order coordinates survive the JSON-RPC hop and that
  // the resulting `col:`/`ord` migration is persisted through the PAT loop-back.
  it('a table structure op crosses the remote transport and migrates col:/ord', async () => {
    const a = app();
    const page = await directBlockPage(`remote-table-${seq}`);
    const pat = await mintPat('write');

    await rpc(
      a,
      pat,
      callMsg('append_blocks', {
        pageId: page.id,
        blocks: [
          {
            type: 'table',
            props: {header: true},
            children: [
              {type: 'row', children: [{type: 'cell', text: 'Item'}, {type: 'cell', text: 'Qty'}]},
              {type: 'row', children: [{type: 'cell', text: 'Apples'}, {type: 'cell', text: '3'}]},
            ],
          },
        ],
      }),
    );
    const tableId = (await blocks(page.id)).find((b) => b.type === 'table')!.id;

    // Refused server-side, over the transport, with the editor's own reason.
    const above = await rpc(a, pat, callMsg('table_insert_row', {pageId: page.id, tableId, rowIndex: 0}));
    expect(toolIsError(above.json)).toBe(true);
    expect(toolText(above.json)).toContain('above the header row');

    const insert = await rpc(a, pat, callMsg('table_insert_row', {pageId: page.id, tableId, rowIndex: 1}));
    expect(toolIsError(insert.json)).toBe(false);
    const table = (await blocks(page.id)).find((b) => b.type === 'table') as
      | {props?: Record<string, unknown>; children?: Array<{props?: Record<string, unknown>; children?: Array<{text?: Array<{t: string}>}>}>}
      | undefined;
    expect(table?.children).toHaveLength(3);
    // The op migrated the keyless append_blocks table: a column registry on the
    // table, an `ord` on every row — and the original rows kept their order.
    expect(Object.keys(table?.props ?? {}).filter((k) => k.startsWith('col:'))).toHaveLength(2);
    expect(table?.children?.every((r) => typeof r.props?.ord === 'string')).toBe(true);

    const report = await rpc(a, pat, callMsg('inspect_table', {pageId: page.id, tableId}));
    expect(toolText(report.json)).toContain('3 row(s) × 2 column(s), header row: yes');
    expect(toolText(report.json)).toMatch(/row 1 \[[^\]]+\]: 0:""\s+\[[^\]]+\]\s+1:""/); // the blank row is at render position 1
  });

  it('a READ PAT cannot delete a block (scope still enforced by the loop-back)', async () => {
    const a = app();
    const page = await directBlockPage(`remote-ro-${seq}`);
    const pat = await mintPat('read');
    const del = await rpc(a, pat, callMsg('delete_block', {pageId: page.id, blockId: 'seed'}));
    expect(toolIsError(del.json)).toBe(true);
    expect((await blocks(page.id)).some((b) => b.id === 'seed')).toBe(true);
  });
});

// ── The load-bearing invariant: inbound headers NEVER propagate to the loop-back ──
//
// The whole confidentiality/integrity guarantee rests on the handler's `fetchImpl`
// building headers FROM SCRATCH — attaching ONLY the caller's own PAT — and the MCP
// server never holding the `store` or a LocalDataClient. This pins that: an inbound
// request that ALSO smuggles a valid owner identity JWS AND the loopback-owner secret
// must NOT let the loop-back run as the owner / local-owner. The inner request runs as
// the PAT principal ONLY. It would FAIL if the loop-back spread inbound headers (owner
// identity / LOCAL_OWNER leak) or if the MCP server were handed a LocalDataClient/store
// (which bypasses authorize() and would read the owner-only page regardless).

describe('mcpHttp inbound identity / local-owner headers do NOT propagate to the loop-back', () => {
  const SECRET = 'the-machine-owner-hatch-secret';
  // A claimed instance WITH a configured local-owner hatch secret (so a leaked
  // LOCAL_OWNER_HEADER would actually grant owner authority if it ever reached an
  // inner request).
  const appWithHatch = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store), localOwnerSecret: SECRET});

  beforeEach(async () => {
    await claim();
    await enableAgentApi();
  });

  it('a non-owner PAT cannot read an OWNER-only page even when the request smuggles the owner JWS + local-owner secret', async () => {
    const a = appWithHatch();
    const agentSub = `${ISS}#agent`;

    // An owner-only restricted page (readable by the owner / local-owner, NOT by the
    // agent subject) and an agent-ACL'd page (readable by the PAT).
    const ownerPage = await store.upsertPage({name: `owner-only-${seq}`, data: snapshot()});
    await store.setPageVisibility(ownerPage.id, 'restricted');
    await store.setPageAcl(ownerPage.id, {subject: OWNER, level: 'read'});
    const agentPage = await store.upsertPage({name: `agent-${seq}`, data: {editorjs: {blocks: [{type: 'paragraph', data: {text: 'agent-visible body'}}]}, values: [], names: []}});
    await store.setPageVisibility(agentPage.id, 'restricted');
    await store.setPageAcl(agentPage.id, {subject: agentSub, level: 'read'});

    const pat = await mintPat('read', agentSub);
    // The attack: present a VALID owner identity JWS AND the machine-owner hatch secret
    // alongside the PAT on the inbound MCP request.
    const smuggled = {[IDENTITY_HEADER]: await idFor('owner'), [LOCAL_OWNER_HEADER]: SECRET};

    // The owner-only page is NOT readable — the inner request runs as the agent PAT, not
    // the owner and not the local-owner. (A propagation bug or a LocalDataClient would
    // make this succeed.)
    const readOwner = await rpc(a, pat, callMsg('read_page', {pageId: ownerPage.id}), smuggled);
    expect(toolIsError(readOwner.json)).toBe(true);
    expect(toolText(readOwner.json)).toContain('not found');

    // Control: the SAME request (same smuggled headers) reads the agent's OWN page fine —
    // proving the loop-back works and the failure above is confinement, not breakage.
    const readAgent = await rpc(a, pat, callMsg('read_page', {pageId: agentPage.id}), smuggled);
    expect(toolIsError(readAgent.json)).toBe(false);
    expect(toolText(readAgent.json)).toContain('agent-visible body');
  });

  it('the smuggled owner JWS + local-owner secret grant no WRITE either (inner scope-gate still the agent PAT)', async () => {
    const a = appWithHatch();
    const agentSub = `${ISS}#agent`;
    // A page the agent can neither read nor write (owner-only).
    const ownerPage = await store.upsertPage({name: `owner-w-${seq}`, data: snapshot()});
    await store.setPageVisibility(ownerPage.id, 'restricted');
    await store.setPageAcl(ownerPage.id, {subject: OWNER, level: 'read'});

    const pat = await mintPat('write', agentSub);
    const smuggled = {[IDENTITY_HEADER]: await idFor('owner'), [LOCAL_OWNER_HEADER]: SECRET};
    // append_to_page → inner getPage 404 for the agent (owner-only) → tool errors; nothing
    // is queued. The owner identity / hatch never elevate the inner principal.
    const append = await rpc(a, pat, callMsg('append_to_page', {pageId: ownerPage.id, content: 'x'}), smuggled);
    expect(toolIsError(append.json)).toBe(true);
    expect(await store.listSuggestions(ownerPage.id)).toHaveLength(0);
  });
});

// ── The LAN-owner path: a hatch-minted PAT sees the owner's members-scope pages ────
//
// The regression this pins (empty page list over LAN): the local MCP bridge mints a
// PAT through the loopback-owner hatch (the machine owner is signed-out — no identity
// JWS). Pre-fix the mint bound the synthetic `local:owner`, which is NOT the claimed
// instance's `ownerSubject`, so authorize() gave it no role → every default-visibility
// (`members`) page was filtered out → `list_pages` came back EMPTY though pages exist.
// This mints EXACTLY as the bridge does (through the real POST /api/agent-tokens over
// the hatch — NOT the test's `mintPat` shortcut that pre-sets subject=OWNER), then
// drives `list_pages` and asserts the owner's pages return.

describe('mcpHttp local-owner-minted PAT lists the owner members-scope pages (LAN empty-list regression)', () => {
  const SECRET = 'the-machine-owner-hatch-secret';
  const appWithHatch = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store), localOwnerSecret: SECRET});

  beforeEach(async () => {
    await claim();
    await enableAgentApi();
  });

  /** Mint a PAT the way the LAN bridge does: POST /api/agent-tokens over the loopback
   *  hatch, with NO identity JWS (a signed-out machine owner). Returns the plaintext. */
  async function mintViaHatch(a: App, scope: AgentTokenScope = 'read'): Promise<string> {
    const res = await a.request('/api/agent-tokens', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', [LOCAL_OWNER_HEADER]: SECRET},
      body: JSON.stringify({name: 'lan-bridge', scope}),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as {token: string}).token;
  }

  it('list_pages returns the owner default-visibility (members) pages — NOT an empty list', async () => {
    const a = appWithHatch();
    // Seed pages at the CLAIMED default visibility (`members`): upsertPage leaves
    // visibility 'inherit', which resolves to the instance defaultVisibility set by the
    // claim (members). These are exactly the pages a non-owner PAT cannot read.
    const p1 = await store.upsertPage({name: `LAN-A-${seq}`, data: snapshot()});
    const p2 = await store.upsertPage({name: `LAN-B-${seq}`, data: {editorjs: {blocks: [{type: 'paragraph', data: {text: 'lan body'}}]}, values: [], names: []}});

    const pat = await mintViaHatch(a);
    const list = await rpc(a, pat, callMsg('list_pages'));
    const text = toolText(list.json);
    // Pre-fix (synthetic local:owner binding) this list is EMPTY — both assertions fail.
    expect(text).toContain(p1.id);
    expect(text).toContain(p2.id);

    // And a direct read of a members page works too (the owner rung, end to end).
    const read = await rpc(a, pat, callMsg('read_page', {pageId: p2.id}));
    expect(toolIsError(read.json)).toBe(false);
    expect(toolText(read.json)).toContain('lan body');
  });
});
