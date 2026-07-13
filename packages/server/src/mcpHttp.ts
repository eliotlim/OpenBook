/**
 * Remote streamable-HTTP MCP transport (AGENT-5).
 *
 * Exposes OpenBook's OWN MCP server (`@book.dev/mcp`) to external agents over
 * `ALL /api/mcp`, so a loopback/LAN MCP client (Claude Desktop, Cursor, …) can
 * drive a workspace through the same tool contract the stdio server uses. This is
 * the outward, owner-gated surface — DARK by default and structurally loopback/
 * LAN-only. It carries NO authorization of its own; every guarantee is inherited
 * from the request pipeline the mount sits behind and from the loop-back below.
 *
 * ── The load-bearing security invariant: a PAT-looped HttpDataClient ─────────────
 * The handler is given ONE data client and one only: an {@link HttpDataClient} with
 * an empty base URL and an injected `fetchImpl` that re-enters THIS app via
 * `app.request(...)`, attaching from scratch ONLY:
 *   - `Authorization: Bearer <the same PAT>` the caller presented, and
 *   - the preserved `FORWARDED_HEADER` if the inbound request carried one.
 * It NEVER attaches `LOCAL_OWNER_HEADER`, an identity JWS, or any other header, and
 * it NEVER spreads the inbound MCP request's headers. The handler NEVER touches the
 * `store` or a `LocalDataClient` — those would bypass `authorize()`.
 *
 * Consequence: every MCP tool call becomes an inner HTTP request carrying the same
 * PAT, so the WHOLE request pipeline (bearer gate, forwarded-reject, PAT resolution,
 * guest floor, and the AGENT-6 scope-gate) re-fires per tool call. Scope is enforced
 * FOR FREE by the loop-back — a read PAT's write tool hits an inner 403 (the tool
 * errors); a write PAT's edits post as reviewable SUGGESTIONS (`allowDirectEdits:
 * false`), never applied. An MCP-layer bug therefore cannot out-privilege the PAT's
 * own REST access.
 *
 * ── Reach ───────────────────────────────────────────────────────────────────────
 * Loopback/LAN only. A forwarded request never resolves a PAT (AGENT-6 refuses a
 * `Bearer obat_` carrying `FORWARDED_HEADER` at principal resolution, 403), so it
 * never reaches this handler with an `agentToken` set; the belt-and-braces check
 * below is a second line if the mount order ever changes. Exposure over
 * `*.book.cloud` (the edge) is deliberately OUT OF SCOPE (deferred, owner-gated
 * separately).
 */

import type {Hono} from 'hono';
import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {createOpenBookMcpServer} from '@book.dev/mcp';
import {API, FORWARDED_HEADER, HttpDataClient, type FetchLike} from '@book.dev/sdk';
import type {AppEnv} from './appEnv';
import type {PageStore} from './store';
import {bearerAgentToken, isAgentApiEnabled} from './agentTokens';

/**
 * Mount the remote MCP transport at `ALL /api/mcp`. Wired in `createApp` beside the
 * AI routes, so the whole `/api/*` middleware stack (bearer gate, forwarded-reject,
 * PAT resolution + guest floor, scope-gate) has already run by the time the handler
 * executes. The `app` reference is captured for the loop-back `fetchImpl`.
 */
export function mountMcpHttp(app: Hono<AppEnv>, store: PageStore): void {
  app.all(API.mcp, async (c) => {
    // 1. DARK by default. `isAgentApiEnabled` is false when the `OPENBOOK_AGENT_API=0`
    //    hard kill-switch is set OR the `agentApi` setting is off (the default). Return
    //    404 — not 401/403 — so the endpoint's very existence stays hidden while
    //    disabled. (A PAT can't even resolve while disabled: AGENT-6's principal mw
    //    401s it upstream, so this handler only ever sees a non-PAT probe here.)
    if (!(await isAgentApiEnabled(store))) {
      return c.json({error: 'not found'}, 404);
    }

    // 2. Belt-and-braces forwarded reject (MEDIUM-1). A forwarded PAT is already 403'd
    //    at PAT resolution and so never reaches here with `agentToken` set; this second
    //    line keeps `/api/mcp` structurally loopback/LAN-only even if the mount order
    //    ever changes. *.book.cloud edge exposure is deferred to its own review.
    if (c.req.header(FORWARDED_HEADER)) {
      return c.json({error: 'the MCP endpoint is not accessible over a forwarded connection'}, 403);
    }

    // 3. Require a PAT — NEVER guest / jws / loopback-owner. `agentToken` is set only
    //    by AGENT-6's principal mw after a valid `Bearer obat_` resolved; its absence
    //    means the caller is not an authenticated agent → 401.
    const agentToken = c.get('agentToken');
    const pat = bearerAgentToken(c);
    if (!agentToken || !pat) {
      return c.json({error: 'unauthorized'}, 401);
    }

    // 4. The loop-back fetch: re-enter THIS app carrying ONLY the same PAT (+ a
    //    preserved forwarded marker, never present in practice per step 2). Headers are
    //    built from scratch on top of the SDK client's own request headers (its
    //    Content-Type for a JSON body) — the inbound MCP request's headers are NEVER
    //    spread in, and no LOCAL_OWNER_HEADER / identity JWS is ever attached. This is
    //    the whole security model: each tool call re-runs every gate under the PAT.
    const forwarded = c.req.header(FORWARDED_HEADER);
    const fetchImpl: FetchLike = async (input, init = {}) => {
      const headers: Record<string, string> = {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${pat}`,
      };
      if (forwarded) headers[FORWARDED_HEADER] = forwarded;
      return app.request(input, {...init, headers});
    };

    // The ONLY client the MCP server may hold: the PAT-looped HttpDataClient. Never the
    // `store`, never a LocalDataClient (either would bypass authorize()). Empty base URL
    // + injected fetchImpl = every call routes back through the app's own middleware.
    const client = new HttpDataClient('', undefined, {fetchImpl});
    // Remote writes ALWAYS go through the suggestion-review layer (Wave-2).
    const server = createOpenBookMcpServer(client, {allowDirectEdits: false});

    // Stateless transport: no session id to hijack, no per-session memory growth, and
    // (JSON mode) a single buffered JSON response per request. A fresh transport +
    // server is required PER request in stateless mode (the SDK rejects reuse). No
    // sampling / roots / elicitation handlers are registered.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      // `handleRequest` fully resolves the (buffered) JSON response before returning in
      // JSON mode, so the server/transport can be torn down immediately after.
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close().catch(() => {});
    }
  });
}
