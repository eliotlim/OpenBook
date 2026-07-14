/**
 * Agent-PAT management routes (AGENT-6): mint / list / revoke tokens + toggle the
 * dark `agentApi` setting. ALL admin-only (`requireInstanceAdmin`) — a PAT can never
 * reach these, both because `requireInstanceAdmin`'s admin path is jws-only
 * (`resolveMemberRole` never yields a role for a `pat`) and because the request-time
 * scope-gate denies `/api/agent-tokens` for any PAT. So a PAT can neither mint nor
 * list PATs.
 *
 * Each minted token is BOUND to the minter's OWN verified subject (never a
 * client-chosen value); a hatch / local-owner minter binds the real `ownerSubject`
 * on a claimed instance (else the synthetic `local:owner` on an unclaimed one). The
 * plaintext secret is returned exactly ONCE (on create) and never stored — only its
 * SHA-256 hash + a non-secret preview live at rest.
 */

import {Hono, type Context} from 'hono';
import {API, DEFAULT_ACCOUNT_URL, type AgentTokenScope, type InstanceConfig, type Principal} from '@book.dev/sdk';
import type {AppEnv} from './appEnv';
import type {PageStore} from './store';
import {requireInstanceAdmin} from './access';
import {
  AGENT_API_SETTING_KEY,
  AGENT_TOKEN_CAP,
  DEFAULT_AGENT_TOKEN_EXPIRY_DAYS,
  DEFAULT_REMOTE_AGENT_TOKEN_EXPIRY_DAYS,
  MAX_REMOTE_AGENT_TOKEN_EXPIRY_DAYS,
  agentApiKillSwitchOn,
  agentMcpRemoteKillSwitchOn,
  generateAgentToken,
  isAgentApiEnabled,
  isAgentRemoteEnabled,
  type AgentApiSetting,
} from './agentTokens';

type LogEdit = (c: {get(k: 'principal'): Principal}, pageId: string | null, kind: string, summary?: string) => void;

const MAX_NAME_LEN = 120;

/** Resolve the subject/issuer to bind a minted token to — ALWAYS the minter's own
 *  verified identity, never anything from the request body. A hatch / in-process
 *  local-owner minter binds the machine owner.
 *
 *  On a CLAIMED instance (an `ownerSubject` exists) the local-owner mint binds to
 *  that REAL account owner subject + the instance's authority issuer, so the PAT
 *  rides the owner rung of `authorize()` (`subject===ownerSubject`) instead of the
 *  synthetic `'local:owner'`, which holds no role and reads no `members`-scope page
 *  (that mismatch is the "empty page list over LAN" bug). The binding only names the
 *  owner subject; it grants no remote reach and no direct-edit power — the forwarded
 *  reject + remote conjunction gate remote MCP independently of subject, and a PAT is
 *  minted `allowDirectEdits:false` (writes stay reviewable suggestions).
 *
 *  On an UNCLAIMED instance (no `ownerSubject`) the legacy synthetic `'local:owner'`
 *  binding is preserved — the single-user local experience is unchanged. */
function minterBinding(c: Context<AppEnv>, config: InstanceConfig): {
  subject: string;
  issuer: string;
  createdBy: string;
} {
  const principal = c.get('principal');
  const isLocalOwner = c.get('localOwner') === true || principal.verifiedVia === 'local';
  if (isLocalOwner) {
    if (config.ownerSubject) {
      return {
        subject: config.ownerSubject,
        issuer: config.emailAuthority ?? DEFAULT_ACCOUNT_URL,
        createdBy: 'Local owner',
      };
    }
    return {subject: 'local:owner', issuer: 'local', createdBy: 'Local owner'};
  }
  return {subject: principal.subject, issuer: principal.issuer, createdBy: principal.name || principal.subject};
}

export function mountAgentTokenRoutes(app: Hono<AppEnv>, store: PageStore, logEdit: LogEdit): void {
  // List tokens (redacted) + the dark on/off state. Reachable regardless of the
  // setting so an admin can see + manage the surface (and turn it on).
  app.get(API.agentTokens, async (c) => {
    await requireInstanceAdmin(c, store);
    const [enabled, remote, tokens] = await Promise.all([
      isAgentApiEnabled(store),
      isAgentRemoteEnabled(store),
      store.listAgentTokens(),
    ]);
    return c.json({enabled, remote, tokens});
  });

  // Toggle the dark `agentApi` setting (+ the `agentApi.remote` remote-MCP opt-in).
  // Reachable regardless (this is how an admin enables it). The `OPENBOOK_AGENT_API=0`
  // kill-switch still wins at resolution, so the returned `enabled`/`remote` reflect the
  // EFFECTIVE state (setting AND not-killed). `remote` is forced off whenever `enabled`
  // is off (remote is dark on top of an already-dark local feature — no dormant remote).
  app.put(API.agentTokens, async (c) => {
    await requireInstanceAdmin(c, store);
    const body = await c.req
      .json<{enabled?: unknown; remote?: unknown}>()
      .catch(() => ({}) as {enabled?: unknown; remote?: unknown});
    const enabled = body.enabled === true;
    // `remote` may only be true when the whole feature is on; a `remote` field absent
    // from the body preserves nothing (this is a full replace) — the caller must send
    // `remote: true` each time to keep it on. Default off.
    const remote = enabled && body.remote === true;
    const setting: AgentApiSetting = {enabled, remote};
    await store.setSetting(AGENT_API_SETTING_KEY, setting);
    logEdit(c, null, 'agent.api', `${enabled ? 'enabled' : 'disabled'}${remote ? ' remote' : ''}`);
    return c.json({
      enabled: enabled && !agentApiKillSwitchOn(),
      remote: remote && !agentApiKillSwitchOn() && !agentMcpRemoteKillSwitchOn(),
    });
  });

  // Mint a token. 404 while `agentApi` is off (hide the surface's existence when
  // disabled). Binds to the minter's own subject; returns the plaintext ONCE.
  app.post(API.agentTokens, async (c) => {
    await requireInstanceAdmin(c, store);
    if (!(await isAgentApiEnabled(store))) {
      return c.json({error: 'agent API is disabled on this instance'}, 404);
    }
    const body = await c.req
      .json<{name?: unknown; scope?: unknown; expiresInDays?: unknown; remote?: unknown}>()
      .catch(() => ({}) as {name?: unknown; scope?: unknown; expiresInDays?: unknown; remote?: unknown});
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME_LEN) : '';
    if (!name) return c.json({error: 'a token name is required'}, 400);
    if (body.scope !== undefined && body.scope !== 'read' && body.scope !== 'write') {
      return c.json({error: 'scope must be "read" or "write"'}, 400);
    }
    const scope: AgentTokenScope = body.scope === 'write' ? 'write' : 'read';

    // Remote opt-in (AGENT-7, L7). Minting a REMOTE token requires the instance's
    // `agentApi.remote` setting to ALREADY be on — no dormant remote tokens on a
    // non-remote instance (fail 409). Default false.
    const remote = body.remote === true;
    if (remote && !(await isAgentRemoteEnabled(store))) {
      return c.json({error: 'remote MCP is not enabled on this instance; enable it before minting a remote token'}, 409);
    }

    // Expiry. Local tokens keep today's rules: default 90 days; `null` ⇒ no expiry
    // (allowed, with a UI warning). REMOTE tokens (Q-a) are self-limiting: default 30
    // days, MAX 90 days, and `null` (no-expiry) is REJECTED — an internet-valid bearer
    // credential must expire.
    const defaultDays = remote ? DEFAULT_REMOTE_AGENT_TOKEN_EXPIRY_DAYS : DEFAULT_AGENT_TOKEN_EXPIRY_DAYS;
    let expiresAt: Date | null;
    if (body.expiresInDays === null) {
      if (remote) {
        return c.json({error: 'a remote token must have an expiry (no-expiry is not allowed for remote tokens)'}, 400);
      }
      expiresAt = null;
    } else if (body.expiresInDays === undefined) {
      expiresAt = new Date(Date.now() + defaultDays * 86_400_000);
    } else if (typeof body.expiresInDays === 'number' && Number.isFinite(body.expiresInDays) && body.expiresInDays > 0) {
      if (remote && body.expiresInDays > MAX_REMOTE_AGENT_TOKEN_EXPIRY_DAYS) {
        return c.json({error: `a remote token may live at most ${MAX_REMOTE_AGENT_TOKEN_EXPIRY_DAYS} days`}, 400);
      }
      expiresAt = new Date(Date.now() + body.expiresInDays * 86_400_000);
    } else {
      return c.json({error: 'expiresInDays must be a positive number or null'}, 400);
    }

    if ((await store.countActiveAgentTokens()) >= AGENT_TOKEN_CAP) {
      return c.json({error: `the ${AGENT_TOKEN_CAP}-token limit has been reached; revoke one first`}, 409);
    }

    const {token, hash, preview} = generateAgentToken();
    const {subject, issuer, createdBy} = minterBinding(c, await store.getInstanceConfig());
    const meta = await store.createAgentToken({name, tokenHash: hash, preview, subject, issuer, scope, createdBy, expiresAt, remoteOk: remote});
    logEdit(c, null, 'agent.mint', `${remote ? 'remote ' : ''}${scope} ${name}`);
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
