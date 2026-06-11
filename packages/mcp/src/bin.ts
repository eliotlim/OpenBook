#!/usr/bin/env node
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {HttpDataClient} from '@open-book/sdk';
import {createOpenBookMcpServer} from './server';

/**
 * Stdio entry point. Point `OPENBOOK_URL` at a running OpenBook server (the
 * desktop app's embedded server, `pnpm dev`, or a headless deployment) and
 * register this binary with an MCP client. stdout belongs to the protocol —
 * all human-facing output goes to stderr.
 */
const url = process.env.OPENBOOK_URL ?? 'http://127.0.0.1:4319';

async function main(): Promise<void> {
  const client = new HttpDataClient(url);
  // Fail fast (and helpfully) when the workspace isn't reachable.
  try {
    await client.listPages();
  } catch {
    console.error(`openbook-mcp: cannot reach an OpenBook server at ${url} — set OPENBOOK_URL or start the app.`);
    process.exit(1);
  }
  const server = createOpenBookMcpServer(client);
  await server.connect(new StdioServerTransport());
  console.error(`openbook-mcp: serving workspace at ${url} over stdio`);
}

main().catch((err: unknown) => {
  console.error('openbook-mcp: fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
