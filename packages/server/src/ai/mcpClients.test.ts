/**
 * McpClientManager (AGENT-3): the in-app agent's MCP *client*.
 *
 *  - Config merge preserves write-only auth tokens (omit/blank preserve, a value
 *    replaces, `null` clears) — the same contract as the provider apiKey.
 *  - Redaction strips the token and flags `authTokenSet` (never leaks a secret).
 *  - The trust-level stdio gate: a `stdio` server is allowed on an UNCLAIMED
 *    (desktop) instance but REJECTED once the instance is claimed (multi-user) —
 *    the central AGENT-3 security control.
 *  - Discovery over an in-process MCP server (InMemoryTransport) namespaces and
 *    sanitizes tool names `mcp__<id>__<tool>`; a call wraps the untrusted result
 *    and an `isError` result throws; a broken server contributes 0 tools and
 *    backs off.
 */

import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import type {McpServerConfig} from '@book.dev/sdk';
import {PgliteDb} from '../db';
import {PageStore} from '../store';
import {McpClientManager, McpConfigError} from './mcpClients';

let store: PageStore;
let db: PgliteDb;
let dir: string;
let seq = 0;

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-mcp-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  db = await PgliteDb.create(dir);
  store = new PageStore(db);
  await store.migrate();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

const httpServer = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'srv',
  transport: 'http',
  url: 'http://127.0.0.1:9/mcp',
  enabled: true,
  ...over,
});

describe('secret-preserving config merge (write-only auth token)', () => {
  it('preserves an omitted/blank token, replaces a new one, and clears on null', async () => {
    const mcp = new McpClientManager(store);
    await mcp.setConfig({enabled: true, servers: [httpServer({authToken: 'secret-1'})]});
    expect((await mcp.getConfig()).servers[0].authToken).toBe('secret-1');

    // Omitted → preserve.
    await mcp.setConfig({enabled: true, servers: [httpServer({})]});
    expect((await mcp.getConfig()).servers[0].authToken).toBe('secret-1');

    // Blank → preserve (no unclearable ghost, no accidental wipe).
    await mcp.setConfig({enabled: true, servers: [httpServer({authToken: '   '})]});
    expect((await mcp.getConfig()).servers[0].authToken).toBe('secret-1');

    // A value → replace.
    await mcp.setConfig({enabled: true, servers: [httpServer({authToken: 'secret-2'})]});
    expect((await mcp.getConfig()).servers[0].authToken).toBe('secret-2');

    // Explicit null → clear.
    await mcp.setConfig({enabled: true, servers: [httpServer({authToken: null})]});
    expect((await mcp.getConfig()).servers[0].authToken).toBeUndefined();
  });

  it('redaction strips the token and flags authTokenSet', async () => {
    const mcp = new McpClientManager(store);
    await mcp.setConfig({enabled: true, servers: [httpServer({authToken: 'top-secret'})]});
    const redacted = mcp.redact(await mcp.getConfig());
    expect(redacted.servers[0].authToken).toBeUndefined();
    expect(redacted.servers[0].authTokenSet).toBe(true);
    // A server with no token has no flag.
    await mcp.setConfig({enabled: true, servers: [httpServer({authToken: null})]});
    expect(mcp.redact(await mcp.getConfig()).servers[0].authTokenSet).toBeUndefined();
  });

  it('rejects an invalid slug (underscore) and a duplicate id', async () => {
    const mcp = new McpClientManager(store);
    await expect(mcp.setConfig({enabled: true, servers: [httpServer({id: 'bad_id'})]})).rejects.toBeInstanceOf(McpConfigError);
    await expect(
      mcp.setConfig({enabled: true, servers: [httpServer({id: 'dup'}), httpServer({id: 'dup'})]}),
    ).rejects.toBeInstanceOf(McpConfigError);
  });
});

describe('trust-level stdio gate (Q1 — the central security control)', () => {
  const stdio = httpServer({transport: 'stdio', url: undefined, command: 'echo'}) as McpServerConfig;

  it('allows stdio on an UNCLAIMED (desktop) instance', async () => {
    const mcp = new McpClientManager(store);
    expect(await mcp.stdioAllowed()).toBe(true);
    await expect(mcp.setConfig({enabled: true, servers: [stdio]})).resolves.toBeTruthy();
  });

  it('REJECTS stdio once the instance is claimed (multi-user); HTTP stays allowed', async () => {
    await store.updateInstanceConfig({ownerSubject: 'https://account.book.pub#owner'});
    const mcp = new McpClientManager(store);
    expect(await mcp.stdioAllowed()).toBe(false);
    await expect(mcp.setConfig({enabled: true, servers: [stdio]})).rejects.toBeInstanceOf(McpConfigError);
    // HTTP is still fine on a claimed instance.
    await expect(mcp.setConfig({enabled: true, servers: [httpServer()]})).resolves.toBeTruthy();
  });

  it('test() refuses a stdio dry-run on a claimed instance', async () => {
    await store.updateInstanceConfig({ownerSubject: 'https://account.book.pub#owner'});
    const mcp = new McpClientManager(store);
    const res = await mcp.test(stdio);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not allowed/i);
  });
});

// ── Discovery + dispatch over an in-process MCP server ─────────────────────────

/** A manager whose transport is a fixed in-process link (no child/socket). */
class LinkedManager extends McpClientManager {
  constructor(store: PageStore, private readonly link: Transport) {
    super(store);
  }
  protected buildTransport(): Transport {
    return this.link;
  }
}

/** A manager whose transport always fails to build (a dead server). */
class BrokenManager extends McpClientManager {
  protected buildTransport(): Transport {
    throw new Error('cannot reach server');
  }
}

async function inProcessServer(): Promise<Transport> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({name: 'test-mcp', version: '1.0.0'});
  server.tool('echo', async () => ({content: [{type: 'text', text: 'hello from mcp'}]}));
  // A name needing sanitizing (dot → underscore).
  server.tool('weird.name', async () => ({content: [{type: 'text', text: 'ok'}]}));
  server.tool('boom', async () => ({content: [{type: 'text', text: 'kaboom'}], isError: true}));
  await server.connect(serverT);
  return clientT;
}

describe('discovery + tool dispatch (in-process MCP server)', () => {
  it('namespaces + sanitizes tool names, and disabled/off contributes nothing', async () => {
    const mcp = new LinkedManager(store, await inProcessServer());

    // Global switch OFF → no tools even with an enabled server.
    await mcp.setConfig({enabled: false, servers: [httpServer({enabled: true})]});
    expect(await mcp.toolsForRun(3000)).toEqual([]);

    await mcp.setConfig({enabled: true, servers: [httpServer({enabled: true})]});
    const tools = await mcp.toolsForRun(3000);
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain('mcp__srv__echo');
    expect(names).toContain('mcp__srv__weird_name'); // '.' sanitized to '_'
    for (const t of tools) expect(t.external).toBe(true);
  });

  it('wraps an untrusted result and throws on an isError result', async () => {
    const mcp = new LinkedManager(store, await inProcessServer());
    await mcp.setConfig({enabled: true, servers: [httpServer({enabled: true})]});
    await mcp.toolsForRun(3000); // connect + discover

    const ok = await mcp.callTool('srv', 'echo', {});
    expect(ok).toContain('untrusted');
    expect(ok).toContain('hello from mcp');

    // A tool that flags isError surfaces as a throw (→ AGENT-4 recoverable path).
    await expect(mcp.callTool('srv', 'boom', {})).rejects.toThrow(/reported an error/i);
    await mcp.dispose();
  });

  it('refuses a stale stdio server at RUN time once the instance is claimed (defence in depth)', async () => {
    const mcp = new LinkedManager(store, await inProcessServer());
    // Register stdio while UNCLAIMED (allowed), enable it, then claim the instance.
    await mcp.setConfig({enabled: true, servers: [httpServer({transport: 'stdio', url: undefined, command: 'echo', enabled: true})]});
    await store.updateInstanceConfig({ownerSubject: 'https://account.book.pub#owner'});
    // The stored stdio server is now skipped at run time — no local child spawns.
    expect(await mcp.toolsForRun(3000)).toEqual([]);
  });

  it('a broken server contributes 0 tools (the run proceeds) and backs off', async () => {
    const mcp = new BrokenManager(store);
    await mcp.setConfig({enabled: true, servers: [httpServer({enabled: true})]});
    expect(await mcp.toolsForRun(3000)).toEqual([]);
    // Still empty on the immediate retry (backed off, not thrown).
    expect(await mcp.toolsForRun(3000)).toEqual([]);
  });
});
