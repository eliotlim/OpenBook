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
import {bodyLimit} from 'hono/body-limit';
import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {createOpenBookMcpServer} from '@book.dev/mcp';
import {API, FORWARDED_HEADER, HttpDataClient, type FetchLike} from '@book.dev/sdk';
import type {AppEnv} from './appEnv';
import type {PageStore} from './store';
import {bearerAgentToken, isAgentApiEnabled} from './agentTokens';

/**
 * Max inbound body for a JSON-RPC tool call (DoS parity with the asset/relay/awareness
 * routes, which each carry their own `bodyLimit`). This is the outward, PAT-authenticated
 * surface, so cap the body an authenticated caller can push. 1 MiB is generous for MCP
 * tool arguments (matching the `/updates` relay cap) — oversized → 413.
 */
const MCP_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB per JSON-RPC POST

/**
 * Mount the remote MCP transport at `ALL /api/mcp`. Wired in `createApp` beside the
 * AI routes; the `/api/*` middleware stack (bearer gate, forwarded-reject, PAT
 * resolution + guest floor, scope-gate) is registered above and has already run by
 * the time this handler executes. The `app` reference is captured for the loop-back
 * `fetchImpl`. A `bodyLimit` middleware fronts the handler for DoS parity.
 */
export function mountMcpHttp(app: Hono<AppEnv>, store: PageStore): void {
  app.all(
    API.mcp,
    bodyLimit({maxSize: MCP_MAX_BODY_BYTES, onError: (c) => c.json({error: 'request body too large'}, 413)}),
    async (c) => {
    // 1. Require a PAT — NEVER guest / jws / loopback-owner. `agentToken` is set only by
    //    AGENT-6's principal mw after a valid `Bearer obat_` resolved. When it is absent,
    //    stay DARK: hide the endpoint's existence while the feature is disabled (404), and
    //    otherwise report that a PAT is required (401). This is the ONLY place the agentApi
    //    gate is read — once `agentToken` is set the principal mw has already confirmed the
    //    feature is live (and 401'd the PAT otherwise), so the authenticated path needs no
    //    re-read. (`isAgentApiEnabled` is false when `OPENBOOK_AGENT_API=0` OR the setting
    //    is off, the default.)
      const agentToken = c.get('agentToken');
      const pat = bearerAgentToken(c);
      if (!agentToken || !pat) {
        return (await isAgentApiEnabled(store))
          ? c.json({error: 'unauthorized'}, 401)
          : c.json({error: 'not found'}, 404);
      }

      // 2. Belt-and-braces forwarded reject (MEDIUM-1). A forwarded PAT is already 403'd at
      //    PAT resolution and so never reaches here with `agentToken` set; this second line
      //    keeps `/api/mcp` structurally loopback/LAN-only even if that ever changes.
      //    *.book.cloud edge exposure is deferred to its own review.
      if (c.req.header(FORWARDED_HEADER)) {
        return c.json({error: 'the MCP endpoint is not accessible over a forwarded connection'}, 403);
      }

      // 3. The loop-back fetch: re-enter THIS app carrying ONLY the same PAT (+ a
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
