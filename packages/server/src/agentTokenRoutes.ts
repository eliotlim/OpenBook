/**
 * Agent-PAT management routes (AGENT-6): mint / list / revoke tokens + toggle the
 * dark `agentApi` setting. ALL admin-only (`requireInstanceAdmin`) — a PAT can never
 * reach these, both because `requireInstanceAdmin`'s admin path is jws-only
 * (`resolveMemberRole` never yields a role for a `pat`) and because the request-time
 * scope-gate denies `/api/agent-tokens` for any PAT. So a PAT can neither mint nor
 * list PATs.
 *
 * Each minted token is BOUND to the minter's OWN verified subject (never a
 * client-chosen value); a hatch / local-owner minter binds `local:owner`. The
 * plaintext secret is returned exactly ONCE (on create) and never stored — only its
 * SHA-256 hash + a non-secret preview live at rest.
 */

import {Hono, type Context} from 'hono';
import {API, type AgentTokenScope, type Principal} from '@book.dev/sdk';
import type {AppEnv} from './appEnv';
import type {PageStore} from './store';
import {requireInstanceAdmin} from './access';
import {
  AGENT_API_SETTING_KEY,
  AGENT_TOKEN_CAP,
  DEFAULT_AGENT_TOKEN_EXPIRY_DAYS,
  agentApiKillSwitchOn,
  generateAgentToken,
  isAgentApiEnabled,
  type AgentApiSetting,
} from './agentTokens';

type LogEdit = (c: {get(k: 'principal'): Principal}, pageId: string | null, kind: string, summary?: string) => void;

const MAX_NAME_LEN = 120;

/** Resolve the subject/issuer to bind a minted token to — ALWAYS the minter's own
 *  verified identity, never anything from the request body. A hatch / in-process
 *  local-owner minter binds the machine-owner subject. */
function minterBinding(c: Context<AppEnv>): {
  subject: string;
  issuer: string;
  createdBy: string;
} {
  const principal = c.get('principal');
  const isLocalOwner = c.get('localOwner') === true || principal.verifiedVia === 'local';
  if (isLocalOwner) return {subject: 'local:owner', issuer: 'local', createdBy: 'Local owner'};
  return {subject: principal.subject, issuer: principal.issuer, createdBy: principal.name || principal.subject};
}

export function mountAgentTokenRoutes(app: Hono<AppEnv>, store: PageStore, logEdit: LogEdit): void {
  // List tokens (redacted) + the dark on/off state. Reachable regardless of the
  // setting so an admin can see + manage the surface (and turn it on).
  app.get(API.agentTokens, async (c) => {
    await requireInstanceAdmin(c, store);
    const [enabled, tokens] = await Promise.all([isAgentApiEnabled(store), store.listAgentTokens()]);
    return c.json({enabled, tokens});
  });

  // Toggle the dark `agentApi` setting. Reachable regardless (this is how an admin
  // enables it). The `OPENBOOK_AGENT_API=0` kill-switch still wins at resolution, so
  // the returned `enabled` reflects the EFFECTIVE state (setting AND not-killed).
  app.put(API.agentTokens, async (c) => {
    await requireInstanceAdmin(c, store);
    const body = await c.req.json<{enabled?: unknown}>().catch(() => ({}) as {enabled?: unknown});
    const enabled = body.enabled === true;
    const setting: AgentApiSetting = {enabled};
    await store.setSetting(AGENT_API_SETTING_KEY, setting);
    logEdit(c, null, 'agent.api', enabled ? 'enabled' : 'disabled');
    return c.json({enabled: enabled && !agentApiKillSwitchOn()});
  });

  // Mint a token. 404 while `agentApi` is off (hide the surface's existence when
  // disabled). Binds to the minter's own subject; returns the plaintext ONCE.
  app.post(API.agentTokens, async (c) => {
    await requireInstanceAdmin(c, store);
    if (!(await isAgentApiEnabled(store))) {
      return c.json({error: 'agent API is disabled on this instance'}, 404);
    }
    const body = await c.req
      .json<{name?: unknown; scope?: unknown; expiresInDays?: unknown}>()
      .catch(() => ({}) as {name?: unknown; scope?: unknown; expiresInDays?: unknown});
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME_LEN) : '';
    if (!name) return c.json({error: 'a token name is required'}, 400);
    if (body.scope !== undefined && body.scope !== 'read' && body.scope !== 'write') {
      return c.json({error: 'scope must be "read" or "write"'}, 400);
    }
    const scope: AgentTokenScope = body.scope === 'write' ? 'write' : 'read';

    // Expiry: default 90 days; `null` ⇒ no expiry (allowed, with a UI warning); a
    // finite positive number ⇒ that many days from now.
    let expiresAt: Date | null;
    if (body.expiresInDays === null) {
      expiresAt = null;
    } else if (body.expiresInDays === undefined) {
      expiresAt = new Date(Date.now() + DEFAULT_AGENT_TOKEN_EXPIRY_DAYS * 86_400_000);
    } else if (typeof body.expiresInDays === 'number' && Number.isFinite(body.expiresInDays) && body.expiresInDays > 0) {
      expiresAt = new Date(Date.now() + body.expiresInDays * 86_400_000);
    } else {
      return c.json({error: 'expiresInDays must be a positive number or null'}, 400);
    }

    if ((await store.countActiveAgentTokens()) >= AGENT_TOKEN_CAP) {
      return c.json({error: `the ${AGENT_TOKEN_CAP}-token limit has been reached; revoke one first`}, 409);
    }

    const {token, hash, preview} = generateAgentToken();
    const {subject, issuer, createdBy} = minterBinding(c);
    const meta = await store.createAgentToken({name, tokenHash: hash, preview, subject, issuer, scope, createdBy, expiresAt});
    logEdit(c, null, 'agent.mint', `${scope} ${name}`);
    // The plaintext is returned HERE and NOWHERE ELSE — the store keeps only the hash.
    return c.json({token, meta}, 201);
  });

  // Revoke a token by id (instant — the next request with it 401s). Reachable
  // regardless of the setting so an admin can always revoke.
  app.delete(`${API.agentTokens}/:id`, async (c) => {
    await requireInstanceAdmin(c, store);
    const removed = await store.revokeAgentToken(c.req.param('id'));
    if (!removed) return c.json({error: 'agent token not found'}, 404);
    logEdit(c, null, 'agent.revoke', c.req.param('id'));
    return c.json({revoked: true});
  });
}
