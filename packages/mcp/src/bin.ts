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

/**
 * The library this connector was configured for (STAB-5). When set, the endpoint's
 * advertised `instanceId` MUST match it before we adopt the connection — this is
 * what stops the connector from silently adopting a FOREIGN responder that happens
 * to answer on the same loopback port (e.g. a stale `pnpm dev` with its own data
 * dir), which would report the app's real pages as "nonexistent". The desktop app
 * emits this alongside `OPENBOOK_URL` in the connector config it shows in Settings.
 * Unset ⇒ identity can't be verified (a reachability-only probe, as before) — set
 * it whenever you know the target library.
 */
const expectedInstanceId = (process.env.OPENBOOK_INSTANCE_ID ?? '').trim() || undefined;

async function main(): Promise<void> {
  const client = new HttpDataClient(url);
  // Verify we reached the RIGHT server (reachability + identity) before adopting it.
  // A single `GET /api/instance` (guest-readable, leaks no secret) doubles as the
  // reachability probe and the identity handshake.
  let instanceId: string | null | undefined;
  try {
    ({instanceId} = await client.getInstanceInfo());
  } catch {
    console.error(
      `openbook-mcp: cannot reach an OpenBook server at ${url} — set OPENBOOK_URL or start the app. ` +
        `If a port conflict is likely, confirm nothing else is bound to that port.`,
    );
    process.exit(1);
  }
  // Instance verification: REFUSE a foreign/mismatched responder rather than
  // silently serving another instance's (empty) data. Naming the mismatch makes a
  // stray port-4319 responder (a stale dev server, a wrong app) obvious.
  if (expectedInstanceId && instanceId !== expectedInstanceId) {
    console.error(
      `openbook-mcp: endpoint identity mismatch at ${url} — expected library ${expectedInstanceId} ` +
        `but the server there reports ${instanceId ?? '(no instance id — not an OpenBook STAB-5 server)'}. ` +
        `A different process is answering on that port; refusing to adopt it. ` +
        `Point OPENBOOK_URL at the intended library's server, or free the port.`,
    );
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
