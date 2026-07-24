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
 * The write tools honor the library's AGENT-EDITS POLICY, resolved PER WRITE from
 * the target page's `agentEdits` override and the instance-wide mode (AGED-3):
 * only a resolved `direct` applies a change immediately, otherwise it persists a
 * REVIEWABLE SUGGESTION. The safe default is `suggest`. This is governed entirely
 * by the library's Settings → Agents toggle (and per-page overrides) — NOT by any
 * environment variable or tool argument the client controls, so a client can never
 * opt itself out of review. The legacy `OPENBOOK_MCP_ALLOW_DIRECT_EDITS` env grant
 * is RETIRED (it no longer enables direct edits).
 */
const url = process.env.OPENBOOK_URL ?? 'http://127.0.0.1:4319';

/**
 * Sanitize a server-reported string before echoing it into a terminal error.
 * Drops control characters (which includes the ESC that introduces ANSI/CSI
 * escape sequences, so a hostile responder can't inject escape codes into the
 * operator's terminal) and clamps the length so it can't flood stderr.
 */
function sanitizeServerString(value: string, max = 64): string {
  // Char-code filtering avoids embedding raw control chars in a regex literal.
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    // Strip C0 controls + DEL and the C1 range (0x00–0x1f, 0x7f–0x9f).
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    if (!isControl) out += ch;
  }
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

// AGED-3: `OPENBOOK_MCP_ALLOW_DIRECT_EDITS` is RETIRED as a grant — direct edits are
// decided per write by the library's agent-edits policy (Settings → Agents + per-page
// overrides), never by this process's environment. If it's still set we warn ONCE so
// an operator relying on it learns where the control moved; it changes NO behaviour.
const legacyDirectEnvSet = process.env.OPENBOOK_MCP_ALLOW_DIRECT_EDITS !== undefined;

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
        'If a port conflict is likely, confirm nothing else is bound to that port.',
    );
    process.exit(1);
  }
  // Instance verification: REFUSE a foreign/mismatched responder rather than
  // silently serving another instance's (empty) data. Naming the mismatch makes a
  // stray port-4319 responder (a stale dev server, a wrong app) obvious.
  if (expectedInstanceId && instanceId !== expectedInstanceId) {
    // The reported id comes from an UNTRUSTED responder — sanitize before echoing to
    // a terminal so a hostile server can't inject ANSI escapes or flood stderr.
    const reported =
      typeof instanceId === 'string'
        ? sanitizeServerString(instanceId)
        : '(no instance id — not an OpenBook STAB-5 server)';
    console.error(
      `openbook-mcp: endpoint identity mismatch at ${url} — expected library ${expectedInstanceId} ` +
        `but the server there reports ${reported}. ` +
        'A different process is answering on that port; refusing to adopt it. ' +
        'Point OPENBOOK_URL at the intended library\'s server, or free the port.',
    );
    process.exit(1);
  }
  if (legacyDirectEnvSet) {
    console.error(
      'openbook-mcp: OPENBOOK_MCP_ALLOW_DIRECT_EDITS is set but no longer grants direct edits (AGED-3). ' +
        'Direct-vs-suggest is now decided per write by the library\'s agent-edits policy — set it in ' +
        'Settings → Agents (and override per page). Remove this variable.',
    );
  }
  const server = createOpenBookMcpServer(client);
  await server.connect(new StdioServerTransport());
  console.error(
    `openbook-mcp: serving library at ${url} over stdio ` +
      '(writes honor the library/page agent-edits policy — reviewable suggestion by default)',
  );
}

main().catch((err: unknown) => {
  console.error('openbook-mcp: fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
