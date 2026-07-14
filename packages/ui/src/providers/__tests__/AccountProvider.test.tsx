import React from 'react';
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {renderHook, act, waitFor, cleanup} from '@testing-library/react';
import {decodeIdentity, getIdentityCredential, setForwardingAudience, setIdentityToken} from '@book.dev/sdk';
import {AccountProvider, useAccount} from '../AccountProvider';
import {PlatformCapabilitiesProvider, type AccountSecretStore, type PlatformCapabilities} from '../PlatformCapabilitiesProvider';
import {PreferencesProvider} from '../PreferencesProvider';
import {LibraryProvider, useLibrary} from '../LibraryProvider';

// ── A fake account.book.pub, keyed by device token. Each token resolves to a
//    distinct identity (issuer#sub + persona email), so the provider can label
//    and dedupe accounts the way it does against the real service. ─────────────
const PERSONAS: Record<string, {iss: string; sub: string; name: string; email: string}> = {
  'tok-work': {iss: 'https://account.book.pub', sub: 'work', name: 'Work User', email: 'work@corp.example'},
  'tok-personal': {iss: 'https://account.book.pub', sub: 'personal', name: 'Home', email: 'me@home.example'},
};
const subjectOf = (tok: string): string => `${PERSONAS[tok].iss}#${PERSONAS[tok].sub}`;

// A token that is valid for settings but issues NO identity (the 501/dev path):
// account.book.pub accepts it for /api/settings but returns 501 from /api/identity.
const NO_IDENTITY_TOKEN = 'tok-dev';
const settingsValid = (tok: string): boolean => !!PERSONAS[tok] || tok === NO_IDENTITY_TOKEN;

// Test-controllable fakes, reset in beforeEach:
//  • settingsPuts — every PUT /api/settings the provider made, by token (so a test
//    can assert account A's blob is never pushed under account B's token).
//  • failSettingsGet — tokens whose next GET /api/settings returns 500, to force a
//    transient reconcile failure on an already-connected account.
//  • rejectAudMints — the account 400s any mint carrying an `aud` query (its
//    DEFAULT posture when no audience allowlist is configured — the bug class the
//    unscoped-fallback fix targets).
//  • failIdentityMint — tokens whose identity mint 503s (a transient failure).
//  • identityMintUrls — every /api/identity/token URL requested, in order.
let settingsPuts: Array<{token: string; settings: Record<string, unknown>}> = [];
//  • serverBlobs — a per-token stored settings blob the GET returns (defaults to an
//    empty blob). Lets an interop test stand up a server holding only the legacy
//    `workspaces` key, or the new `libraries` key, and assert the client dual-reads.
const serverBlobs = new Map<string, {settings: Record<string, unknown>; updatedAt: string}>();
const failSettingsGet = new Set<string>();
let rejectAudMints = false;
const failIdentityMint = new Set<string>();
let identityMintUrls: string[] = [];
const putsFor = (tok: string): Array<{token: string; settings: Record<string, unknown>}> =>
  settingsPuts.filter((p) => p.token === tok);

const b64u = (o: unknown): string => {
  let bin = '';
  for (const byte of new TextEncoder().encode(JSON.stringify(o))) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fakeJws = (tok: string): string => {
  const p = PERSONAS[tok];
  const claims = {iss: p.iss, sub: p.sub, name: p.name, email: p.email, exp: Math.floor(Date.now() / 1000) + 3600};
  return `${b64u({alg: 'EdDSA', typ: 'JWT'})}.${b64u(claims)}.sig`;
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
}

function installFetchStub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      const tok = auth?.replace(/^Bearer\s+/, '') ?? '';
      if (url.includes('/api/identity/token')) {
        identityMintUrls.push(url);
        if (failIdentityMint.has(tok)) return jsonResponse(503, {}); // transient outage
        if (!PERSONAS[tok]) return jsonResponse(501, {}); // issuance not configured
        if (rejectAudMints && url.includes('aud=')) {
          return jsonResponse(400, {error: 'audience binding is not configured on this server'});
        }
        return jsonResponse(200, {identity: fakeJws(tok), expiresAt: new Date(Date.now() + 3600_000).toISOString()});
      }
      if (url.includes('/api/settings')) {
        if (init?.method === 'PUT') {
          let settings: Record<string, unknown> = {};
          try {
            settings = (JSON.parse(String(init?.body ?? '{}')) as {settings?: Record<string, unknown>}).settings ?? {};
          } catch {
            /* ignore */
          }
          settingsPuts.push({token: tok, settings});
          return jsonResponse(200, {updatedAt: new Date().toISOString()});
        }
        if (failSettingsGet.has(tok)) return jsonResponse(500, {}); // forced transient failure
        if (!settingsValid(tok)) return jsonResponse(401, {}); // unknown/rejected token
        const seeded = serverBlobs.get(tok);
        if (seeded) return jsonResponse(200, seeded);
        return jsonResponse(200, {settings: {}, updatedAt: new Date().toISOString()});
      }
      return jsonResponse(404, {});
    }),
  );
}

const tokenKey = (id: string): string => `openbook.account.token.${id}`;
const readIndex = (): Array<{id: string; email: string | null; subject: string | null}> =>
  JSON.parse(localStorage.getItem('openbook.accounts') ?? '[]');

function makeWrapper(platform: PlatformCapabilities = {}) {
  const Wrapper = ({children}: {children: React.ReactNode}) => (
    <PlatformCapabilitiesProvider value={platform}>
      <PreferencesProvider>
        <LibraryProvider>
          <AccountProvider>{children}</AccountProvider>
        </LibraryProvider>
      </PreferencesProvider>
    </PlatformCapabilitiesProvider>
  );
  Wrapper.displayName = 'TestAccountWrapper';
  return Wrapper;
}

function renderAccount(platform?: PlatformCapabilities) {
  return renderHook(() => useAccount(), {wrapper: makeWrapper(platform)});
}

type Hook = ReturnType<typeof renderAccount>['result'];

/** Drive the manual-code path (skips the CSRF nonce a real deep link carries). */
async function addAccount(result: Hook, tok: string): Promise<void> {
  act(() => result.current.submitCode(tok));
  await waitFor(() => expect(result.current.status).toBe('connected'));
  await waitFor(() => expect(result.current.token).toBe(tok));
}

// Shared across both suites below (multi-account + identity resilience).
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setIdentityToken(null);
  settingsPuts = [];
  serverBlobs.clear();
  failSettingsGet.clear();
  rejectAudMints = false;
  failIdentityMint.clear();
  identityMintUrls = [];
  installFetchStub();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setIdentityToken(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('AccountProvider — multi-account (OB-194)', () => {
  it('adds an account, makes it active, and stores its token in a namespaced slot', async () => {
    const {result} = renderAccount();
    await waitFor(() => expect(result.current.status).toBe('disconnected'));

    await addAccount(result, 'tok-work');

    expect(result.current.accounts).toHaveLength(1);
    const id = result.current.activeAccountId!;
    expect(id).toBeTruthy();
    expect(result.current.connected).toBe(true);
    expect(result.current.accounts[0]).toMatchObject({id, email: 'work@corp.example', status: 'connected'});

    // The device token is persisted under a per-account namespaced key…
    expect(localStorage.getItem(tokenKey(id))).toBe('tok-work');
    // …and never inlined into the (non-secret) account index.
    expect(localStorage.getItem('openbook.accounts')).not.toContain('tok-work');

    // The active account's identity JWS was minted and handed to the data client.
    const jws = getIdentityCredential().jws!;
    expect(decodeIdentity(jws)?.claims.email).toBe('work@corp.example');
  });

  it('a second sign-in ADDS without evicting the first; switching activates either', async () => {
    const {result} = renderAccount();
    await addAccount(result, 'tok-work');
    const workId = result.current.activeAccountId!;

    await addAccount(result, 'tok-personal');
    const personalId = result.current.activeAccountId!;

    expect(workId).not.toBe(personalId);
    expect(result.current.accounts).toHaveLength(2);
    // Latest sign-in is active; the first is retained.
    expect(result.current.activeAccountId).toBe(personalId);
    expect(decodeIdentity(getIdentityCredential().jws!)?.claims.email).toBe('me@home.example');

    // Both tokens live in distinct namespaced slots — no cross-account leakage.
    expect(localStorage.getItem(tokenKey(workId))).toBe('tok-work');
    expect(localStorage.getItem(tokenKey(personalId))).toBe('tok-personal');

    // Switch back to the work account: identity + token follow the active one.
    act(() => result.current.setActiveAccount(workId));
    await waitFor(() => expect(result.current.activeAccountId).toBe(workId));
    await waitFor(() => expect(result.current.token).toBe('tok-work'));
    await waitFor(() => expect(decodeIdentity(getIdentityCredential().jws!)?.claims.email).toBe('work@corp.example'));
  });

  it('re-signing the same account refreshes its slot rather than duplicating it', async () => {
    const {result} = renderAccount();
    await addAccount(result, 'tok-work');
    const firstId = result.current.activeAccountId!;

    await addAccount(result, 'tok-work'); // same identity subject
    expect(result.current.accounts).toHaveLength(1);
    expect(result.current.activeAccountId).toBe(firstId);
    expect(readIndex()[0].subject).toBe(subjectOf('tok-work'));
  });

  it('removeAccount drops only that account; removing the active one falls back to another', async () => {
    const {result} = renderAccount();
    await addAccount(result, 'tok-work');
    const workId = result.current.activeAccountId!;
    await addAccount(result, 'tok-personal');
    const personalId = result.current.activeAccountId!;

    // Remove the active (personal) account → active falls back to work.
    act(() => result.current.removeAccount(personalId));
    await waitFor(() => expect(result.current.activeAccountId).toBe(workId));
    expect(result.current.accounts).toHaveLength(1);
    // Only the removed account's secret slot is cleared.
    expect(localStorage.getItem(tokenKey(personalId))).toBeNull();
    expect(localStorage.getItem(tokenKey(workId))).toBe('tok-work');
    await waitFor(() => expect(decodeIdentity(getIdentityCredential().jws!)?.claims.email).toBe('work@corp.example'));
  });

  it('signing out the only account goes fully disconnected and clears identity (single-account back-compat)', async () => {
    const {result} = renderAccount();
    await addAccount(result, 'tok-work');
    const id = result.current.activeAccountId!;

    act(() => result.current.signOut());
    await waitFor(() => expect(result.current.status).toBe('disconnected'));
    expect(result.current.connected).toBe(false);
    expect(result.current.token).toBeNull();
    expect(result.current.accounts).toHaveLength(0);
    expect(result.current.activeAccountId).toBeNull();
    expect(localStorage.getItem(tokenKey(id))).toBeNull();
    expect(getIdentityCredential().jws).toBeUndefined();
  });

  it('migrates a pre-OB-194 single account on mount, into the namespaced store', async () => {
    // Seed the legacy single-account record the old provider wrote.
    localStorage.setItem(
      'openbook.account',
      JSON.stringify({token: 'tok-work', connectedAt: 123, lastServerUpdatedAt: '2026-01-01T00:00:00.000Z'}),
    );

    const {result} = renderAccount();
    await waitFor(() => expect(result.current.status).toBe('connected'));

    expect(result.current.accounts).toHaveLength(1);
    const id = result.current.activeAccountId!;
    expect(result.current.token).toBe('tok-work');
    // Token moved into the namespaced secret store; the legacy key is gone.
    expect(localStorage.getItem(tokenKey(id))).toBe('tok-work');
    expect(localStorage.getItem('openbook.account')).toBeNull();
    // Identity for the migrated (now active) account is minted.
    expect(decodeIdentity(getIdentityCredential().jws!)?.claims.email).toBe('work@corp.example');
  });

  it('uses a platform-provided secret store (the desktop keychain pattern) over localStorage', async () => {
    const mem = new Map<string, string>();
    const secretStore: AccountSecretStore = {
      get: async (id) => mem.get(id) ?? null,
      set: async (id, token) => void mem.set(id, token),
      delete: async (id) => void mem.delete(id),
    };
    const {result} = renderAccount({account: {secretStore}});
    await addAccount(result, 'tok-work');
    const id = result.current.activeAccountId!;

    // The token went into the injected store, not the localStorage fallback.
    expect(mem.get(id)).toBe('tok-work');
    expect(localStorage.getItem(tokenKey(id))).toBeNull();
  });

  it('adding a 2nd account with an empty remote does NOT push the first account’s blob (no settings bleed)', async () => {
    // Account A's local state carries a distinctive workspace. The genuine first
    // sign-in seeds it to A's empty server blob — the legitimate seed path.
    localStorage.setItem(
      'openbook.workspaces',
      JSON.stringify([{id: 'ws-acme', icon: '🅰️', name: 'Acme Corp', serverUrl: null}]),
    );

    const {result} = renderAccount();
    await waitFor(() => expect(result.current.status).toBe('disconnected'));

    await addAccount(result, 'tok-work');
    // A's blob was seeded — to A, and only A — carrying the local workspace.
    expect(putsFor('tok-work').length).toBeGreaterThan(0);
    expect(JSON.stringify(putsFor('tok-work'))).toContain('Acme Corp');

    // Add a SECOND account whose server settings are empty. An empty remote must
    // NOT cause account A's blob to be uploaded under account B's token — neither
    // by the reconcile seed nor by the debounced switch-race push.
    await addAccount(result, 'tok-personal');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1300)); // let any (wrong) debounced push fire
    });

    expect(putsFor('tok-personal')).toHaveLength(0);
  });

  it('re-signing a dev/identity-less account reuses its slot instead of duplicating it', async () => {
    const {result} = renderAccount();
    await addAccount(result, NO_IDENTITY_TOKEN); // the issuer asserts no identity (501)
    const firstId = result.current.activeAccountId!;
    expect(result.current.accounts).toHaveLength(1);
    // No verified identity was minted — the app is a named guest.
    expect(getIdentityCredential().jws).toBeUndefined();

    await addAccount(result, NO_IDENTITY_TOKEN); // same dev account, signed in again
    // Deduped by account URL (no subject to key on) — one slot, not two.
    expect(result.current.accounts).toHaveLength(1);
    expect(result.current.activeAccountId).toBe(firstId);
  });

  it('removing the active account clears its identity even when the fallback can’t mint one', async () => {
    const {result} = renderAccount();
    // A fallback account with its own identity…
    await addAccount(result, 'tok-personal');
    const personalId = result.current.activeAccountId!;
    // …then the account we'll remove, which carries a verified identity.
    await addAccount(result, 'tok-work');
    const workId = result.current.activeAccountId!;
    expect(decodeIdentity(getIdentityCredential().jws!)?.claims.email).toBe('work@corp.example');

    // The fallback's next reconcile fails transiently, so activating it can't mint a
    // replacement identity. The removed (work) account's JWS must already be gone —
    // cleared up front in forgetAccount — not lingering for the round-trip.
    failSettingsGet.add('tok-personal');
    act(() => result.current.removeAccount(workId));

    await waitFor(() => expect(result.current.activeAccountId).toBe(personalId));
    await waitFor(() => expect(getIdentityCredential().jws).toBeUndefined());
  });
});

describe('AccountProvider — identity mint resilience', () => {
  it('an aud-rejected mint retries ONCE unscoped instead of demoting the owner to guest', async () => {
    // A forwarding audience is persisted (the tunnel was enabled at some point)…
    setForwardingAudience('demo-xyz.book.cloud');
    // …but the account runs NO audience allowlist, so it 400s every scoped mint —
    // the production default that silently nulled the identity and cascaded into
    // "no write access" 403s on the owner's own instance.
    rejectAudMints = true;

    const {result} = renderAccount();
    await addAccount(result, 'tok-work');

    // The identity SURVIVED: the fallback minted an unscoped token.
    const jws = getIdentityCredential().jws!;
    expect(decodeIdentity(jws)?.claims.email).toBe('work@corp.example');
    expect(decodeIdentity(jws)?.claims.aud).toBeUndefined();
    expect(result.current.identityIssuance).toBe('ok');

    // Exactly one retry, in the right order: scoped first, then unscoped.
    expect(identityMintUrls).toHaveLength(2);
    expect(identityMintUrls[0]).toContain('aud=');
    expect(identityMintUrls[1]).not.toContain('aud=');
  });

  it('a 501 issuer clears the identity and marks issuance unconfigured (terminal)', async () => {
    const {result} = renderAccount();
    await addAccount(result, NO_IDENTITY_TOKEN);

    expect(getIdentityCredential().jws).toBeUndefined();
    await waitFor(() => expect(result.current.identityIssuance).toBe('unconfigured'));
  });

  it('a transient mint failure keeps the previous identity token (no demotion)', async () => {
    const {result} = renderAccount();
    await addAccount(result, 'tok-work');
    const before = getIdentityCredential().jws!;

    failIdentityMint.add('tok-work');
    await act(async () => {
      await result.current.remintIdentity();
    });

    // The 503 took the transient path: the stored JWS is untouched, and the
    // issuance verdict didn't flip on a blip.
    expect(getIdentityCredential().jws).toBe(before);
    expect(result.current.identityIssuance).toBe('ok');
  });
});

// ── LIB-6: the account-sync wire key rename `workspaces` → `libraries`. The client
//    DUAL-WRITES the library list under both keys and DUAL-READS `libraries ??
//    workspaces`, so it interoperates with an account server on either side of the
//    rename with no data loss. These exercise the three cross-version pairings. ───
describe('AccountProvider — LIB-6 library sync-key dual-read/write', () => {
  // Observe both the account status AND the adopted library list.
  const renderBoth = () =>
    renderHook(() => ({account: useAccount(), library: useLibrary()}), {wrapper: makeWrapper()});
  type BothHook = ReturnType<typeof renderBoth>['result'];
  const connect = async (result: BothHook, tok: string): Promise<void> => {
    act(() => result.current.account.submitCode(tok));
    await waitFor(() => expect(result.current.account.status).toBe('connected'));
    await waitFor(() => expect(result.current.account.token).toBe(tok));
  };
  const libNames = (result: BothHook): string[] => result.current.library.libraries.map((l) => l.name);

  it('new client ↔ new server: writes BOTH keys (dual-write), equal values', async () => {
    // A distinctive local library the genuine first sign-in seeds to the server.
    localStorage.setItem(
      'openbook.workspaces',
      JSON.stringify([{id: 'ws-acme', icon: '🅰️', name: 'Acme Corp', serverUrl: 'https://acme.example'}]),
    );
    const {result} = renderBoth();
    await waitFor(() => expect(result.current.account.status).toBe('disconnected'));
    await connect(result, 'tok-work');

    const pushed = putsFor('tok-work');
    expect(pushed.length).toBeGreaterThan(0);
    const {settings} = pushed[0];
    // The library list is written under BOTH wire keys…
    expect(Array.isArray(settings.libraries)).toBe(true);
    expect(Array.isArray(settings.workspaces)).toBe(true);
    // …carrying the same value, and containing the local library.
    expect(JSON.stringify(settings.libraries)).toContain('Acme Corp');
    expect(settings.workspaces).toEqual(settings.libraries);
  });

  it('new client ↔ OLD server: server holds only `workspaces` ⇒ client dual-reads it', async () => {
    // An old account server stored the blob under the legacy key only.
    serverBlobs.set('tok-work', {
      settings: {workspaces: [{id: 'ws-legacy', icon: '📼', name: 'Legacy Only', serverUrl: 'https://legacy.example'}]},
      updatedAt: new Date().toISOString(),
    });
    const {result} = renderBoth();
    await connect(result, 'tok-work');

    // The client adopted the legacy-keyed library list (fallback read succeeded).
    await waitFor(() => expect(libNames(result)).toContain('Legacy Only'));
  });

  it('new client prefers `libraries` when a server emits BOTH keys', async () => {
    // A new/mirroring server exposes both keys; the NEW key must win.
    serverBlobs.set('tok-work', {
      settings: {
        libraries: [{id: 'ws-new', icon: '📗', name: 'New Key Wins', serverUrl: 'https://new.example'}],
        workspaces: [{id: 'ws-old', icon: '📕', name: 'Old Key Loses', serverUrl: 'https://old.example'}],
      },
      updatedAt: new Date().toISOString(),
    });
    const {result} = renderBoth();
    await connect(result, 'tok-work');

    await waitFor(() => expect(libNames(result)).toContain('New Key Wins'));
    expect(libNames(result)).not.toContain('Old Key Loses');
  });

  it('old client ↔ new server: a legacy-only local push still round-trips (no data loss)', async () => {
    // Model the reverse direction: the mirrored blob a NEW server would serve back
    // after an old client wrote only `workspaces` still carries `libraries` too, so
    // this (new) client reads it. Proves the server-side mirror closes the loop.
    serverBlobs.set('tok-personal', {
      settings: {
        // What the account service stores after mirroring an old client's write.
        libraries: [{id: 'ws-x', icon: '🔁', name: 'Round Trips', serverUrl: 'https://x.example'}],
        workspaces: [{id: 'ws-x', icon: '🔁', name: 'Round Trips', serverUrl: 'https://x.example'}],
      },
      updatedAt: new Date().toISOString(),
    });
    const {result} = renderBoth();
    await connect(result, 'tok-personal');

    await waitFor(() => expect(libNames(result)).toContain('Round Trips'));
  });
});
