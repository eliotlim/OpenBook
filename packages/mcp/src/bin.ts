#!/usr/bin/env node
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {HttpDataClient} from '@book.dev/sdk';
import {createOpenBookMcpServer} from './server';

/**
 * Stdio entry point. Point `OPENBOOK_URL` at a running OpenBook server (the
 * desktop app's embedded server, `pnpm dev`, or a headless deployment) and
 * register this binary with an MCP client. stdout belongs to the protocol —
 * all human-facing output goes to stderr.
 *
 * By default the write tools persist REVIEWABLE SUGGESTIONS rather than mutating
 * the workspace — an untrusted MCP client cannot silently change existing
 * content. Set `OPENBOOK_MCP_ALLOW_DIRECT_EDITS=1` only for a TRUSTED deployment
 * to restore direct mutation. This is a deployment/config decision on purpose:
 * it lives in the server's environment, not in any tool argument the client can
 * set, so a client can never opt itself out of review.
 */
const url = process.env.OPENBOOK_URL ?? 'http://127.0.0.1:4319';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const allowDirectEdits = TRUTHY.has((process.env.OPENBOOK_MCP_ALLOW_DIRECT_EDITS ?? '').trim().toLowerCase());

async function main(): Promise<void> {
  const client = new HttpDataClient(url);
  // Fail fast (and helpfully) when the workspace isn't reachable.
  try {
    await client.listPages();
  } catch {
    console.error(`openbook-mcp: cannot reach an OpenBook server at ${url} — set OPENBOOK_URL or start the app.`);
    process.exit(1);
  }
  const server = createOpenBookMcpServer(client, {allowDirectEdits});
  await server.connect(new StdioServerTransport());
  console.error(
    `openbook-mcp: serving workspace at ${url} over stdio (writes ${
      allowDirectEdits ? 'apply DIRECTLY — trusted mode' : 'create reviewable suggestions'
    })`,
  );
}

main().catch((err: unknown) => {
  console.error('openbook-mcp: fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
