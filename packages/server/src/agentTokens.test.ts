/**
 * Agent Personal-Access-Token suite (AGENT-6). Exercises the security-critical
 * request path: bearer-routing (invalid/revoked/expired → HARD 401, never a silent
 * guest downgrade), the dark `agentApi` gate, the default-deny scope-gate (incl. the
 * FULL privileged-route 403 list), the `authorize()` `pat` rungs (subject-keyed only,
 * never a roster role, never verified authorship), minter-subject binding, and the
 * per-token + per-IP rate limiters.
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
  verifiedSubject,
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
import {agentPrincipal, AGENT_API_SETTING_KEY} from './agentTokens';

const ISS = 'https://account.book.pub';
const OWNER = `${ISS}#owner`;
let store: PageStore;
let dir: string;
let seq = 0;
let kp: IdentityKeypair;
let jwks: Jwks;

const snapshot = () => ({editorjs: {blocks: []}, values: [], names: []});

const idFor = (sub: string): Promise<string> =>
  signIdentity(
    kp.privateKey,
    {
      iss: ISS,
      sub,
      name: sub,
      iat: Math.floor(Date.now() / 1000) - 30,
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: `jti-${sub}-${Math.random()}`,
    },
    kp.publicJwk.kid,
  );

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-agent-${process.pid}-${seq}`);
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

// A claimed instance WITH a configured local-owner hatch secret, so a request
// carrying LOCAL_OWNER_HEADER=SECRET resolves as the machine owner (localOwner) — the
// exact path the desktop app / LAN MCP bridge mints through.
const HATCH_SECRET = 'machine-owner-hatch-secret';
const appWithHatch = () =>
  createApp(store, undefined, new PageHub(), {identity: new IdentityService(store), localOwnerSecret: HATCH_SECRET});

const claim = () =>
  store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], ownerSubject: OWNER});

const enableAgentApi = () => store.setSetting(AGENT_API_SETTING_KEY, {enabled: true});

/** Mint a PAT directly in the store (returns the plaintext to present). */
async function mintPat(
  opts: {scope?: AgentTokenScope; subject?: string; expiresAt?: Date | null; revoked?: boolean} = {},
): Promise<{token: string; id: string}> {
  const {generateAgentToken} = await import('./agentTokens');
  const {token, hash, preview} = generateAgentToken();
  const meta = await store.createAgentToken({
    name: 'test',
    tokenHash: hash,
    preview,
    subject: opts.subject ?? OWNER,
    issuer: ISS,
    scope: opts.scope ?? 'read',
    createdBy: 'test',
    expiresAt: opts.expiresAt ?? null,
  });
  if (opts.revoked) await store.revokeAgentToken(meta.id);
  return {token, id: meta.id};
}

const bearer = (token: string) => ({Authorization: `Bearer ${token}`});
const req = (a: ReturnType<typeof app>, path: string, init: RequestInit = {}) => a.request(path, init);

// ── Bearer routing: valid resolves, everything bad HARD-401s (never guest) ────────

describe('agent PAT bearer routing', () => {
  beforeEach(async () => {
    await claim();
    await enableAgentApi();
  });

  it('a valid read PAT resolves and can read', async () => {
    const a = app();
    const {token} = await mintPat({scope: 'read'});
    expect((await req(a, '/api/pages', {headers: bearer(token)})).status).toBe(200);
  });

  it('a garbage obat_ token HARD-401s (NOT a silent downgrade to guest)', async () => {
    const a = app();
    // An anonymous request lists public pages (200); a garbage PAT must 401, proving
    // it never falls through to the guest principal.
    expect((await req(a, '/api/pages')).status).toBe(200);
    expect((await req(a, '/api/pages', {headers: bearer('obat_not-a-real-token')})).status).toBe(401);
  });

  it('a revoked PAT 401s', async () => {
    const a = app();
    const {token} = await mintPat({revoked: true});
    expect((await req(a, '/api/pages', {headers: bearer(token)})).status).toBe(401);
  });

  it('an expired PAT 401s', async () => {
    const a = app();
    const {token} = await mintPat({expiresAt: new Date(Date.now() - 60_000)});
    expect((await req(a, '/api/pages', {headers: bearer(token)})).status).toBe(401);
  });

  it('is header-only — a ?token=obat_ query never authenticates as a PAT', async () => {
    const a = app();
    // A restricted page ACL'd to a non-owner subject: readable by that PAT via the
    // header, but a query-token presentation resolves as an anonymous guest → 404.
    const sub = `${ISS}#agent`;
    const pid = (await store.upsertPage({name: `r-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(pid, 'restricted');
    await store.setPageAcl(pid, {subject: sub, level: 'read'});
    const {token} = await mintPat({subject: sub});
    expect((await req(a, `/api/pages/${pid}`, {headers: bearer(token)})).status).toBe(200);
    expect((await req(a, `/api/pages/${pid}?token=${encodeURIComponent(token)}`)).status).toBe(404);
  });
});

// ── Dark by default: agentApi OFF → every PAT 401s, mint route 404s ───────────────

describe('agentApi dark gate', () => {
  beforeEach(async () => {
    await claim();
  });

  it('a valid-looking PAT 401s while agentApi is disabled (default)', async () => {
    const a = app();
    const {token} = await mintPat(); // stored, but the feature is OFF
    expect((await req(a, '/api/pages', {headers: bearer(token)})).status).toBe(401);
  });

  it('a garbage PAT 401s while disabled (never a guest 200)', async () => {
    const a = app();
    expect((await req(a, '/api/pages', {headers: bearer('obat_whatever')})).status).toBe(401);
  });

  it('POST /api/agent-tokens 404s while disabled (existence hidden)', async () => {
    const a = app();
    const res = await req(a, '/api/agent-tokens', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', [IDENTITY_HEADER]: await idFor('owner')},
      body: JSON.stringify({name: 'x'}),
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/agent-tokens works while disabled and reports enabled:false', async () => {
    const a = app();
    const res = await req(a, '/api/agent-tokens', {headers: {[IDENTITY_HEADER]: await idFor('owner')}});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({enabled: false, tokens: []});
  });
});

// ── The default-deny scope-gate ───────────────────────────────────────────────────

describe('scope-gate confinement', () => {
  beforeEach(async () => {
    await claim();
    await enableAgentApi();
  });

  it('a read PAT reads content but is refused ALL write methods (403)', async () => {
    const a = app();
    const {token} = await mintPat({scope: 'read'});
    expect((await req(a, '/api/pages', {headers: bearer(token)})).status).toBe(200);
    // A write method on a content route is not in the read allowlist → scope-gate 403.
    const res = await req(a, '/api/pages', {
      method: 'POST',
      headers: {...bearer(token), 'Content-Type': 'application/json'},
      body: JSON.stringify({name: `x-${seq}`, data: snapshot()}),
    });
    expect(res.status).toBe(403);
  });

  it('a read PAT may reach POST /api/ai/search (allowed — not 403)', async () => {
    const a = app();
    const {token} = await mintPat({scope: 'read'});
    // No AI service is mounted, so the route is absent (404) — the point is the
    // scope-gate ALLOWS it (never 403).
    const res = await req(a, '/api/ai/search', {
      method: 'POST',
      headers: {...bearer(token), 'Content-Type': 'application/json'},
      body: JSON.stringify({query: 'x'}),
    });
    expect(res.status).not.toBe(403);
  });

  it('a WRITE PAT is refused the ENTIRE privileged route list (403)', async () => {
    const a = app();
    const {token} = await mintPat({scope: 'write', subject: OWNER});
    const privileged: Array<[string, string]> = [
      ['GET', '/api/members'],
      ['POST', '/api/members'],
      ['GET', '/api/instance'],
      ['PUT', '/api/instance'],
      ['GET', '/api/backups'],
      ['PUT', '/api/backups'],
      ['POST', '/api/backups/run'],
      ['GET', '/api/export'],
      ['POST', '/api/import'],
      ['POST', '/api/maintenance/compact'],
      ['PUT', '/api/ai/config'],
      ['POST', '/api/ai/models/download'],
      ['GET', '/api/ai/skills'],
      ['GET', '/api/ai/mcp'],
      ['GET', '/api/library/sync'],
      ['POST', '/api/library/sync'],
      ['GET', '/api/workspace/sync'],
      ['GET', '/api/plugins'],
      ['GET', '/api/agent-tokens'],
      ['POST', '/api/agent-tokens'],
      ['DELETE', '/api/agent-tokens/some-id'],
    ];
    for (const [method, path] of privileged) {
      const res = await req(a, path, {headers: bearer(token)});
      expect(res.status, `${method} ${path} must be scope-gate-denied`).toBe(403);
    }
  });

  it('a WRITE PAT bound to the owner may create a page (scope-gate + authorize allow)', async () => {
    const a = app();
    const {token} = await mintPat({scope: 'write', subject: OWNER});
    const res = await req(a, '/api/pages', {
      method: 'POST',
      headers: {...bearer(token), 'Content-Type': 'application/json'},
      body: JSON.stringify({name: `w-${seq}`, data: snapshot()}),
    });
    expect(res.status).toBe(201);
  });
});

// ── authorize() `pat` rungs: subject-keyed only, no roster role, no verified author ─

describe('authorize pat rungs', () => {
  it('resolveMemberRole is jws-only — a PAT (even bound to an admin) gets NO role', async () => {
    await claim();
    await store.addMember({subject: `${ISS}#admin`, role: 'admin', status: 'active'});
    const config = await store.getInstanceConfig();
    const p = agentPrincipal({id: 't', name: 'a', subject: `${ISS}#admin`, issuer: ISS, scope: 'write', remoteOk: false});
    expect(await store.resolveMemberRole(p, config)).toBeNull();
  });

  it('verifiedSubject stays jws-only (a PAT can never forge verified authorship)', () => {
    const p = agentPrincipal({id: 't', name: 'a', subject: OWNER, issuer: ISS, scope: 'write', remoteOk: false});
    expect(verifiedSubject(p)).toBe('');
  });

  it('a subject-ACL grant matches a PAT bound to that subject; another restricted page 404s', async () => {
    await claim();
    await enableAgentApi();
    const a = app();
    const sub = `${ISS}#agent`;
    const granted = (await store.upsertPage({name: `g-${seq}`, data: snapshot()})).id;
    const other = (await store.upsertPage({name: `o-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(granted, 'restricted');
    await store.setPageVisibility(other, 'restricted');
    await store.setPageAcl(granted, {subject: sub, level: 'read'});
    const {token} = await mintPat({subject: sub});
    expect((await req(a, `/api/pages/${granted}`, {headers: bearer(token)})).status).toBe(200);
    expect((await req(a, `/api/pages/${other}`, {headers: bearer(token)})).status).toBe(404);
  });

  it('an authenticated-scope page is read by a PAT but not a guest', async () => {
    await claim();
    await enableAgentApi();
    const a = app();
    const pid = (await store.upsertPage({name: `a-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(pid, 'authenticated');
    const {token} = await mintPat({subject: `${ISS}#agent`});
    expect((await req(a, `/api/pages/${pid}`, {headers: bearer(token)})).status).toBe(200);
    expect((await req(a, `/api/pages/${pid}`)).status).toBe(404); // guest
  });

  it('the guest-off floor does not block a valid PAT (it is admitted past the floor)', async () => {
    await claim();
    await enableAgentApi();
    await store.updateInstanceConfig({guestAccess: 'off'});
    const a = app();
    const pid = (await store.upsertPage({name: `p-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(pid, 'public');
    const {token} = await mintPat({subject: OWNER});
    expect((await req(a, `/api/pages/${pid}`, {headers: bearer(token)})).status).toBe(200);
    expect((await req(a, `/api/pages/${pid}`)).status).toBe(401); // guest floor
  });
});

// ── Minting: admin-only, binds the minter's own subject, cap, one-time secret ──────

describe('minting', () => {
  beforeEach(async () => {
    await claim();
    await enableAgentApi();
  });

  it('an owner mints a token bound to their OWN subject (never client-chosen), usable once returned', async () => {
    const a = app();
    const res = await req(a, '/api/agent-tokens', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', [IDENTITY_HEADER]: await idFor('owner')},
      body: JSON.stringify({name: 'ci', scope: 'read', subject: `${ISS}#attacker`}), // subject ignored
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {token: string; meta: {subject: string; scope: string; preview: string}};
    expect(body.meta.subject).toBe(OWNER); // bound to the MINTER, not the body value
    expect(body.token.startsWith('obat_')).toBe(true);
    expect(body.meta.preview).not.toContain(body.token.slice(10)); // preview is not the secret
    // The freshly-minted token authenticates.
    expect((await req(a, '/api/pages', {headers: bearer(body.token)})).status).toBe(200);
  });

  it('a LOCAL-OWNER hatch mint on a CLAIMED instance binds the REAL ownerSubject (not local:owner)', async () => {
    // Regression for the "empty page list over LAN" bug: the LAN MCP bridge mints
    // through the loopback-owner hatch (no identity JWS — a signed-out machine owner).
    // Pre-fix it bound the synthetic `local:owner`, which holds no owner role on a
    // claimed instance, so a `members`-scope page list came back empty. Post-fix it
    // binds the account owner subject so the PAT rides authorize()'s owner rung.
    const a = appWithHatch();
    const res = await req(a, '/api/agent-tokens', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', [LOCAL_OWNER_HEADER]: HATCH_SECRET},
      body: JSON.stringify({name: 'lan', scope: 'read'}),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {token: string; meta: {subject: string; issuer: string}};
    expect(body.meta.subject).toBe(OWNER);
    expect(body.meta.subject).not.toBe('local:owner');
    expect(body.meta.issuer).toBe(ISS); // the instance authority issuer, not 'local'

    // End-to-end: the freshly minted PAT reads a members-scope (default-visibility) page.
    const pid = (await store.upsertPage({name: `m-${seq}`, data: snapshot()})).id; // inherits default 'members'
    expect((await req(a, `/api/pages/${pid}`, {headers: bearer(body.token)})).status).toBe(200);
  });

  it('enforces the 25-token cap (409)', async () => {
    const a = app();
    for (let i = 0; i < 25; i += 1) await mintPat();
    const res = await req(a, '/api/agent-tokens', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', [IDENTITY_HEADER]: await idFor('owner')},
      body: JSON.stringify({name: 'over'}),
    });
    expect(res.status).toBe(409);
  });

  it('revoke makes the next request 401', async () => {
    const a = app();
    const {token, id} = await mintPat();
    expect((await req(a, '/api/pages', {headers: bearer(token)})).status).toBe(200);
    const del = await req(a, `/api/agent-tokens/${id}`, {
      method: 'DELETE',
      headers: {[IDENTITY_HEADER]: await idFor('owner')},
    });
    expect(del.status).toBe(200);
    expect((await req(a, '/api/pages', {headers: bearer(token)})).status).toBe(401);
  });
});

// ── UNCLAIMED instance: the synthetic hatch binding is preserved ──────────────────

describe('local-owner mint on an UNCLAIMED instance', () => {
  beforeEach(async () => {
    await enableAgentApi(); // NB: no claim() — no ownerSubject exists
  });

  it('binds the synthetic local:owner (legacy single-user behaviour, unchanged)', async () => {
    const a = appWithHatch();
    const res = await req(a, '/api/agent-tokens', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', [LOCAL_OWNER_HEADER]: HATCH_SECRET},
      body: JSON.stringify({name: 'local', scope: 'read'}),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {meta: {subject: string; issuer: string}};
    expect(body.meta.subject).toBe('local:owner');
    expect(body.meta.issuer).toBe('local');
  });

  it('an unclaimed guestAccess=off instance still admits the PAT to read (blanketRead ⇄ authorize parity)', async () => {
    // On an unclaimed instance `authorize` rule-0 admits a PAT (`privileged`), so the
    // list fast-path `blanketRead` must agree — else `list_pages` would come back empty
    // while a direct `read_page` succeeds. Guards that divergence.
    await store.updateInstanceConfig({guestAccess: 'off'});
    const a = appWithHatch();
    const mint = await req(a, '/api/agent-tokens', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', [LOCAL_OWNER_HEADER]: HATCH_SECRET},
      body: JSON.stringify({name: 'local', scope: 'read'}),
    });
    const {token} = (await mint.json()) as {token: string};
    const pid = (await store.upsertPage({name: `u-${seq}`, data: snapshot()})).id;
    // The list fast-path returns the page…
    const list = (await (await req(a, '/api/pages', {headers: bearer(token)})).json()) as Array<{id: string}>;
    expect(list.some((p) => p.id === pid)).toBe(true);
    // …and a direct read agrees.
    expect((await req(a, `/api/pages/${pid}`, {headers: bearer(token)})).status).toBe(200);
  });
});

// ── Rate limiting ─────────────────────────────────────────────────────────────────

describe('rate limiting', () => {
  beforeEach(async () => {
    await claim();
    await enableAgentApi();
  });

  it('a valid token is capped per fixed window (429 past 120/min)', async () => {
    const a = app();
    const {token} = await mintPat({subject: OWNER});
    let sawRateLimit = false;
    for (let i = 0; i < 130; i += 1) {
      const res = await req(a, '/api/pages', {headers: bearer(token)});
      if (res.status === 429) {
        sawRateLimit = true;
        break;
      }
    }
    expect(sawRateLimit).toBe(true);
  });

  it('failed PAT attempts are capped per IP (429 past 10/min)', async () => {
    const a = app();
    let sawRateLimit = false;
    for (let i = 0; i < 20; i += 1) {
      const res = await req(a, '/api/pages', {headers: bearer(`obat_bad-${i}`)});
      if (res.status === 429) {
        sawRateLimit = true;
        break;
      }
      expect(res.status).toBe(401);
    }
    expect(sawRateLimit).toBe(true);
  });
});

// ── Sharing / exposure controls are never a PAT surface (BLOCKER regression) ───────

describe('page sharing/exposure is refused for a PAT', () => {
  beforeEach(async () => {
    await claim();
    await enableAgentApi();
  });

  it('a WRITE PAT (bound to the owner) is refused visibility, listing + ACL changes (403), but normal content writes still work', async () => {
    const a = app();
    const {token} = await mintPat({scope: 'write', subject: OWNER});
    const pid = (await store.upsertPage({name: `s-${seq}`, data: snapshot()})).id;
    // AGED-2: an agent PAT's DIRECT content write is now gated by the page's
    // agent-edits mode. Set this page to `direct` so the control write below isolates
    // the sharing/exposure refusals (the subject of this test) from the write gate —
    // the gate's own suggest-mode 403 is covered in agentWriteGate.test.ts.
    await store.setPageAgentEdits(pid, 'direct');

    // Exposure: flipping a page to `public` — a confidentiality break — is refused.
    const vis = await req(a, `/api/pages/${pid}/visibility`, {
      method: 'PUT',
      headers: {...bearer(token), 'Content-Type': 'application/json'},
      body: JSON.stringify({visibility: 'public'}),
    });
    expect(vis.status).toBe(403);

    // Discovery: the same protected route also refuses an unlisted flip.
    const listed = await req(a, `/api/pages/${pid}/visibility`, {
      method: 'PUT',
      headers: {...bearer(token), 'Content-Type': 'application/json'},
      body: JSON.stringify({listed: false}),
    });
    expect(listed.status).toBe(403);
    expect((await store.getPageVisibility(pid))?.listed).toBe(true);

    // Sharing: a durable ACL grant that would SURVIVE revocation is refused.
    const share = await req(a, `/api/pages/${pid}/acl`, {
      method: 'POST',
      headers: {...bearer(token), 'Content-Type': 'application/json'},
      body: JSON.stringify({invitee: `${ISS}#attacker`, level: 'write'}),
    });
    expect(share.status).toBe(403);

    const unshare = await req(a, `/api/pages/${pid}/acl?subject=${encodeURIComponent(`${ISS}#x`)}`, {
      method: 'DELETE',
      headers: bearer(token),
    });
    expect(unshare.status).toBe(403);

    // Control: ordinary page CONTENT writes still succeed for the same write PAT.
    const write = await req(a, `/api/pages/${pid}`, {
      method: 'PUT',
      headers: {...bearer(token), 'Content-Type': 'application/json'},
      body: JSON.stringify({id: pid, name: `s-${seq}`, data: snapshot()}),
    });
    expect(write.status).toBe(200);
  });
});

// ── Forwarded PAT is refused (Wave-2 loopback/LAN-only) ────────────────────────────

describe('forwarded PAT reject', () => {
  it('a valid PAT carrying the forwarded marker is refused (403) even on a claimed instance', async () => {
    await claim();
    await enableAgentApi();
    const a = app();
    const {token} = await mintPat({subject: OWNER});
    // Sanity: it resolves fine without the marker.
    expect((await req(a, '/api/pages', {headers: bearer(token)})).status).toBe(200);
    // With the forwarded marker it never resolves.
    const res = await req(a, '/api/pages', {headers: {...bearer(token), [FORWARDED_HEADER]: '1'}});
    expect(res.status).toBe(403);
  });
});

// ── Defense-in-depth: the jws-only owner gate denies a PAT independently ───────────

describe('privileged owner checks are jws-only (independent of the scope-gate)', () => {
  it('an owner-bound PAT cannot change instance policy or backups (scope-gate layer, 403)', async () => {
    await claim();
    await enableAgentApi();
    const a = app();
    const {token} = await mintPat({scope: 'write', subject: OWNER});
    expect((await req(a, '/api/instance', {method: 'PUT', headers: {...bearer(token), 'Content-Type': 'application/json'}, body: '{}'})).status).toBe(403);
    expect((await req(a, '/api/backups', {method: 'PUT', headers: {...bearer(token), 'Content-Type': 'application/json'}, body: '{}'})).status).toBe(403);
  });

  it('a non-jws principal carrying the owner subject is denied AT the handler (jws gate, scope-gate uninvolved)', async () => {
    // No identity provider ⇒ a presented JWS resolves to an `unverified` principal
    // (subject preserved, verifiedVia !== 'jws') that is NOT a PAT, so it reaches the
    // owner-check handler WITHOUT passing through the scope-gate. This proves the
    // `verifiedVia === 'jws'` tightening at PUT /api/instance + /api/backups is a real,
    // independent gate — a PAT is just another non-jws owner-subject principal.
    await store.updateInstanceConfig({ownerSubject: OWNER});
    const noIdentity = createApp(store, undefined, new PageHub(), {});
    const jws = await idFor('owner');
    const hdr = {[IDENTITY_HEADER]: jws, 'Content-Type': 'application/json'};
    expect((await noIdentity.request('/api/instance', {method: 'PUT', headers: hdr, body: JSON.stringify({guestAccess: 'read'})})).status).toBe(403);
    expect((await noIdentity.request('/api/backups', {method: 'PUT', headers: hdr, body: JSON.stringify({})})).status).toBe(403);
  });
});
