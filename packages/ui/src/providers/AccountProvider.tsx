import React, {createContext, PropsWithChildren, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {
  AccountClient,
  AccountError,
  decodeIdentity,
  getServerUrlOverride,
  resolveAccountUrl,
  setIdentityToken,
} from '@book.dev/sdk';
import {usePlatformLibrary, type AccountSecretStore} from './PlatformLibraryProvider';
import {usePreferences, type Preferences} from './PreferencesProvider';
import {useWorkspace, type Workspace} from './WorkspaceProvider';

/**
 * Signs the app in to account.book.pub via the deep-link flow and keeps the
 * user's settings synced there (the account service stores settings only; the
 * data server stays single-tenant and untouched).
 *
 * Sign-in: open `/api/connect` in the browser (desktop in the system browser,
 * web in a popup); the account service runs OAuth, mints a one-shot device
 * token, and redirects back — to the desktop's `openbook://auth-callback` deep
 * link, or the web shell's `/account/callback` page, which both hand the token
 * here. The token is then a bearer for `/api/settings`.
 *
 * Sync: pull on connect / app open (remote wins), then push the
 * `{preferences, workspaces}` blob on local change (debounced, last-writer-wins).
 *
 * Multi-account (OB-194): the client holds a **list** of connected accounts and
 * an **active** one. Sign-in *adds* an account rather than replacing the current
 * one; the active account is the identity presented to the data server and the
 * one whose settings sync. Each account's device token is stored separately and
 * namespaced (OS keychain on desktop, namespaced `localStorage` on web/dev) —
 * no cross-account leakage. The single-account fields below keep reflecting the
 * ACTIVE account, so a lone account behaves exactly as it did before.
 */

export type AccountStatus = 'disconnected' | 'connecting' | 'syncing' | 'connected' | 'error';

/** One connected account in the multi-account list. Carries only non-secret
 *  metadata — the device token lives in the per-account secret store. */
export interface ConnectedAccount {
  /** Stable local id for this account slot (namespaces its token + index row). */
  id: string;
  /** Display label — the active-persona email, else the name/account host. */
  name: string;
  /** The active-persona email (lowercased) when the identity JWS asserts one. */
  email: string | null;
  /** The account service base URL this account signed in to. */
  accountUrl: string;
  /** Connection status. The ACTIVE account tracks the live status; the others are
   *  dormant (reported as `connected` until they are made active). */
  status: AccountStatus;
}

interface AccountContextValue {
  status: AccountStatus;
  connected: boolean;
  /** The device bearer token of the ACTIVE account, for same-app account API
   *  calls (e.g. forwarding's POST /api/sites). Null when disconnected. Treat as
   *  a secret. */
  token: string | null;
  /** The label this device registers under (shown in the account dashboard). */
  deviceName: string;
  /** ISO timestamp of the active account's last successful server sync, or null. */
  lastSyncedAt: string | null;
  /** A human-readable error from the last failed action, or null. */
  error: string | null;
  /** The active account's service base URL (for an "open dashboard" link). */
  accountUrl: string;
  /** Start the deep-link sign-in flow (additive — see {@link addAccount}). */
  signIn: () => void;
  /** Complete sign-in from a manually pasted code — the dev/fallback path for when
   *  the `openbook://` deep link can't fire (the user dismisses the "open app?"
   *  prompt and pastes the code instead). Accepts a bare token or the whole
   *  `openbook://auth-callback#token=…` URL. */
  submitCode: (raw: string) => void;
  /** Abandon a pending sign-in (returns to disconnected when not yet connected). */
  cancel: () => void;
  /** Forget the ACTIVE account's token (does not revoke it server-side — do that in
   *  the dashboard). If other accounts remain, switches to one of them. */
  signOut: () => void;
  /** Pull-then-push a reconciliation now (for the active account). */
  syncNow: () => void;

  // ── Multi-account (OB-194) ─────────────────────────────────────────────────
  /** Every connected account, in connection order. */
  accounts: ConnectedAccount[];
  /** The id of the active account, or null when none is connected. */
  activeAccountId: string | null;
  /** Make `id` the active account: presents its identity, syncs its settings. */
  setActiveAccount: (id: string) => void;
  /** Start the sign-in flow to ADD an account (alias of {@link signIn}; the flow
   *  is additive — a new sign-in never evicts the accounts already connected). */
  addAccount: () => void;
  /** Forget account `id` locally (token + metadata). Switches active away from it. */
  removeAccount: (id: string) => void;
}

const AccountContext = createContext<AccountContextValue | null>(null);

const DEVICE_ID_KEY = 'openbook.deviceId';
/** The account list (non-secret metadata only). */
const INDEX_KEY = 'openbook.accounts';
/** The active account id. */
const ACTIVE_KEY = 'openbook.accounts.active';
/** Pre-OB-194 single-account record (`{token, connectedAt, lastServerUpdatedAt}`),
 *  migrated into the namespaced store on first load. */
const LEGACY_KEY = 'openbook.account';
/** Per-account device-token slot for the localStorage fallback store. */
const TOKEN_KEY_PREFIX = 'openbook.account.token.';

/** Cross-window handoff (web): the callback page hands the minted token to the
 *  running app over this BroadcastChannel (popup case) or localStorage key
 *  (same-tab fallback). Exported so the web `/account/callback` page reuses the
 *  exact contract. */
export const ACCOUNT_CHANNEL = 'openbook.account';
export const ACCOUNT_HANDOFF_KEY = 'openbook.account.handoff';

/** The message a callback page sends; `state` echoes the sign-in's CSRF nonce. */
interface AccountTokenMessage {
  type: 'openbook-account-token';
  token: string;
  state: string;
}

/**
 * Deliver a token from a web callback page to the running app. A popup posts on
 * the BroadcastChannel (the opener can't be relied on cross-origin); a same-tab
 * fallback writes the localStorage key the app reads on its next load.
 */
export function handoffAccountToken(token: string, state: string, mode: 'broadcast' | 'storage'): void {
  const msg: AccountTokenMessage = {type: 'openbook-account-token', token, state};
  if (mode === 'broadcast') {
    try {
      const bc = new BroadcastChannel(ACCOUNT_CHANNEL);
      bc.postMessage(msg);
      bc.close();
    } catch {
      /* fall through to storage below */
    }
  }
  try {
    if (mode === 'storage') localStorage.setItem(ACCOUNT_HANDOFF_KEY, JSON.stringify(msg));
  } catch {
    /* ignore (private mode / quota) */
  }
}

/** One persisted account row (metadata only — token lives in the secret store). */
interface StoredIndexRow {
  id: string;
  name: string;
  email: string | null;
  /** `iss#sub` from the identity JWS, when asserted — dedupes re-sign-in of the
   *  same account into the same slot. Null when the issuer issues no identity. */
  subject: string | null;
  accountUrl: string;
  connectedAt: number;
  lastServerUpdatedAt: string | null;
}

/** Identity facts decoded from a freshly minted JWS (for labelling/dedup). */
interface Persona {
  subject: string;
  email: string | null;
  name: string | null;
}

/**
 * Pull a device token out of a manually pasted value, so the user can paste
 * whatever they managed to copy: a bare token, the full
 * `openbook://auth-callback#token=…&state=…` URL the browser tried to open, a
 * web `…/account/callback#token=…` URL, or just a `#token=…` fragment. Returns
 * the token, or null when nothing usable is found.
 */
export function extractToken(raw: string): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  // Anything carrying `token=…` (URL, query, or fragment) — take that value.
  const m = s.match(/[#?&]token=([^&\s#]+)/) ?? s.match(/^token=([^&\s#]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  // Otherwise treat it as a bare token, unless it's clearly a URL or has spaces.
  if (/\s/.test(s) || s.includes('://')) return null;
  return s;
}

const rand = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '')
    : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

/** A stable per-install id, so re-connecting replaces this device's token. */
function deviceId(): string {
  if (typeof localStorage === 'undefined') return 'web';
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = rand().slice(0, 12);
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/** A fresh local id for a new account slot. */
const newAccountId = (): string => rand().slice(0, 12);

/** A readable fallback label for an account (its service host, e.g. `account.book.pub`). */
function accountHostLabel(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url.replace(/^https?:\/\//, '');
  }
}

function readIndex(): StoredIndexRow[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((r): r is StoredIndexRow => !!r && typeof (r as StoredIndexRow).id === 'string');
  } catch {
    return [];
  }
}

function writeIndex(rows: StoredIndexRow[]): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(rows));
  } catch {
    /* ignore (private mode / quota) */
  }
}

function readActiveId(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(ACTIVE_KEY) || null;
  } catch {
    return null;
  }
}

function writeActiveId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}

/** The pre-OB-194 single-account record, if one is still stored. */
function readLegacy(): {token: string; connectedAt?: number; lastServerUpdatedAt?: string | null} | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as {token?: unknown; connectedAt?: number; lastServerUpdatedAt?: string | null};
    return v && typeof v.token === 'string' && v.token ? {token: v.token, connectedAt: v.connectedAt, lastServerUpdatedAt: v.lastServerUpdatedAt ?? null} : null;
  } catch {
    return null;
  }
}

/**
 * The fallback secret store (web shell, and unsigned desktop dev builds): each
 * account's device token under its own namespaced `localStorage` key, mirroring
 * the desktop's per-account keychain entries. A signed desktop build supplies a
 * keychain-backed {@link AccountSecretStore} via `platform.account.secretStore`.
 */
function localStorageSecretStore(): AccountSecretStore {
  return {
    async get(id) {
      try {
        return typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_KEY_PREFIX + id) : null;
      } catch {
        return null;
      }
    },
    async set(id, token) {
      try {
        localStorage.setItem(TOKEN_KEY_PREFIX + id, token);
      } catch {
        /* ignore */
      }
    },
    async delete(id) {
      try {
        localStorage.removeItem(TOKEN_KEY_PREFIX + id);
      } catch {
        /* ignore */
      }
    },
  };
}

// The pending sign-in's CSRF nonce, persisted so a same-tab redirect (the
// popup-blocked fallback) can still validate it after the app reloads.
// sessionStorage scope means it dies with the tab/app session — an unsolicited
// deep link that arrives with no sign-in in flight is rejected.
const PENDING_KEY = 'openbook.account.pending';
const PENDING_TTL_MS = 10 * 60 * 1000;

function writePendingState(state: string): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({state, at: Date.now()}));
  } catch {
    /* ignore */
  }
}

function readPendingState(): string | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as {state?: unknown; at?: unknown};
    if (typeof v.state === 'string' && typeof v.at === 'number' && Date.now() - v.at < PENDING_TTL_MS) return v.state;
  } catch {
    /* ignore */
  }
  return null;
}

function clearPendingState(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}

/** The blob mirrored to account.book.pub. */
interface SyncBlob {
  preferences: Preferences;
  workspaces: Workspace[];
}

/**
 * The data server this client talks to, as an audience for the identity JWS
 * (OB-177 confused-deputy protection). When connected to an *external* server we
 * scope the assertion to that host so it can't be replayed elsewhere; the local
 * embedded server is the single-server model and stays unscoped (as before).
 */
function dataServerAudience(): string | undefined {
  const url = getServerUrlOverride();
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

export const AccountProvider: React.FC<PropsWithChildren<unknown>> = ({children}) => {
  const {account: platform} = usePlatformLibrary();
  const {preferences, update: updatePreferences} = usePreferences();
  const {workspaces, replaceWorkspaces} = useWorkspace();

  const [status, setStatus] = useState<AccountStatus>('disconnected');
  const [token, setToken] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<StoredIndexRow[]>(() => readIndex());
  const [activeAccountId, setActiveAccountId] = useState<string | null>(() => readActiveId());

  const client = useMemo(() => new AccountClient(), []);
  const accountUrlDefault = useMemo(() => resolveAccountUrl(), []);
  const name = useMemo(() => `OpenBook ${platform?.redirectUri?.startsWith('openbook:') ? 'Desktop' : 'Web'} · ${deviceId()}`, [platform]);

  // Per-account device-token storage: the OS keychain on a signed desktop build,
  // else a namespaced-localStorage fallback (web / desktop dev). Each account's
  // token sits in its own slot — no shared key, no cross-account leakage.
  const secretStore = useMemo<AccountSecretStore>(() => platform?.secretStore ?? localStorageSecretStore(), [platform]);
  const secretStoreRef = useRef(secretStore);
  secretStoreRef.current = secretStore;

  // The pending sign-in's CSRF state, and the JSON of the last blob we know the
  // server has (so adopting a pull doesn't immediately echo a push back).
  const pendingState = useRef<string | null>(null);
  const lastSyncedBlob = useRef<string | null>(null);
  // In-memory token cache for this session, so switching accounts is instant and
  // the sync effect can read the active token without an async round-trip.
  const tokensRef = useRef<Map<string, string>>(new Map());
  // >0 while an account is being activated (settings reconcile + identity mint in
  // flight). During that window `token` has already flipped to the new account but
  // the live blob may still be the previous account's, so the debounced push must
  // hold off — else it uploads A's blob under B's token (OB-194 switch-race). A
  // depth counter (not a boolean) stays correct across the activate ⇄ forget
  // recursion. A ref (not state) so toggling it triggers no extra render.
  const activatingDepth = useRef(0);

  // Latest preferences/workspaces, read inside async callbacks without re-binding.
  const blobRef = useRef<SyncBlob>({preferences, workspaces});
  blobRef.current = {preferences, workspaces};
  const currentBlob = useCallback((): SyncBlob => ({preferences: blobRef.current.preferences, workspaces: blobRef.current.workspaces}), []);

  // ── The account index (metadata) + active id, mirrored to localStorage. ──────
  const indexRef = useRef<StoredIndexRow[]>(accounts);
  indexRef.current = accounts;
  const commitIndex = useCallback((rows: StoredIndexRow[]) => {
    indexRef.current = rows;
    setAccounts(rows);
    writeIndex(rows);
  }, []);
  const upsertRow = useCallback(
    (row: StoredIndexRow) => commitIndex([...indexRef.current.filter((r) => r.id !== row.id), row]),
    [commitIndex],
  );
  const patchRow = useCallback(
    (id: string, patch: Partial<StoredIndexRow>) => commitIndex(indexRef.current.map((r) => (r.id === id ? {...r, ...patch} : r))),
    [commitIndex],
  );
  const activeIdRef = useRef<string | null>(activeAccountId);
  activeIdRef.current = activeAccountId;
  const commitActiveId = useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveAccountId(id);
    writeActiveId(id);
  }, []);

  /** Adopt a pulled blob into the live providers. */
  const adopt = useCallback(
    (settings: Record<string, unknown>) => {
      if (settings.preferences && typeof settings.preferences === 'object') {
        updatePreferences(settings.preferences as Partial<Preferences>);
      }
      if (Array.isArray(settings.workspaces)) {
        replaceWorkspaces(settings.workspaces as Workspace[]);
      }
    },
    [updatePreferences, replaceWorkspaces],
  );

  /** Pull-then-reconcile. With `seedFromLocal` (the genuine FIRST account only) an
   *  empty remote is seeded from the local providers; otherwise an empty remote is
   *  treated as empty and the local blob is never pushed. Returns the server
   *  timestamp. Throws `AccountError(401)` on a rejected token. */
  const reconcileSettings = useCallback(
    async (tok: string, seedFromLocal: boolean): Promise<string | null> => {
      const {settings, updatedAt} = await client.getSettings(tok); // 401 ⇒ AccountError
      const remoteEmpty = updatedAt === null || (!settings.preferences && !settings.workspaces);
      if (remoteEmpty) {
        // Seed the server blob from the local providers ONLY for the genuine first
        // account ever connected — the "upload my pre-sign-in local state" path.
        // For any later account the live blob belongs to the *previously active*
        // account; pushing it here would bleed account A's workspaces/preferences
        // into account B (OB-194 review). Treat an empty remote as empty instead:
        // never push, and record the live blob as the synced baseline so the
        // debounced push stays a no-op (no later upload of A's blob to B either).
        if (seedFromLocal) {
          const blob = currentBlob();
          const res = await client.putSettings(tok, blob as unknown as Record<string, unknown>);
          lastSyncedBlob.current = JSON.stringify(blob);
          return res.updatedAt;
        }
        lastSyncedBlob.current = JSON.stringify(currentBlob());
        return updatedAt;
      }
      adopt(settings);
      lastSyncedBlob.current = JSON.stringify(settings);
      return updatedAt;
    },
    [client, currentBlob, adopt],
  );

  // ── Verified identity for the data server (OB-165/OB-177/OB-194) ─────────────
  // The ACTIVE account mints an audience-scoped identity JWS from
  // account.book.pub and hands it to the data client (via the SDK credential
  // store); we refresh it shortly before it expires and decode it to learn the
  // active persona (email/name) for labelling. Switching accounts re-mints for
  // the new active account; sign-out clears it. If the account doesn't issue
  // identities (501) we stay a named guest.
  const identityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshIdentity = useCallback(
    async (tok: string): Promise<Persona | null> => {
      try {
        const aud = dataServerAudience();
        const res = await client.getIdentityToken(tok, aud);
        setIdentityToken(res?.identity ?? null);
        if (identityTimer.current) clearTimeout(identityTimer.current);
        if (!res) return null;
        // Refresh a minute before expiry (but at least 30s out).
        const ms = Math.max(30_000, new Date(res.expiresAt).getTime() - Date.now() - 60_000);
        identityTimer.current = setTimeout(() => void refreshRef.current(tok), ms);
        const decoded = decodeIdentity(res.identity);
        if (!decoded) return null;
        return {
          subject: `${decoded.claims.iss}#${decoded.claims.sub}`,
          email: decoded.claims.email ? decoded.claims.email.toLowerCase() : null,
          name: decoded.claims.name ?? null,
        };
      } catch {
        // Network/transient error — keep whatever we had; a later sync retries.
        return null;
      }
    },
    [client],
  );
  const refreshRef = useRef(refreshIdentity);
  refreshRef.current = refreshIdentity;

  const clearIdentity = useCallback((): void => {
    if (identityTimer.current) clearTimeout(identityTimer.current);
    identityTimer.current = null;
    setIdentityToken(null);
  }, []);

  // Mutually-recursive async actions (activate ⇄ forget) bound through refs so
  // each can call the latest of the other without a declaration-order cycle.
  const activateRef = useRef<(id: string, tok: string) => Promise<void>>(async () => {});
  const forgetRef = useRef<(id: string) => Promise<void>>(async () => {});

  /** Forget account `id` locally (token + metadata). If it was active, fall back
   *  to another connected account, else go disconnected. Never revokes server-side. */
  const forgetAccount = useCallback(
    async (id: string): Promise<void> => {
      // When forgetting the ACTIVE account, drop its live identity JWS (and refresh
      // timer) up front — before activating any fallback — so the removed account's
      // verified identity never lingers for a round-trip, and never survives a
      // fallback whose own activation fails to mint a replacement (OB-194, Sasha).
      const wasActive = activeIdRef.current === id;
      if (wasActive) clearIdentity();
      try {
        await secretStoreRef.current.delete(id);
      } catch {
        /* best-effort */
      }
      tokensRef.current.delete(id);
      const remaining = indexRef.current.filter((r) => r.id !== id);
      commitIndex(remaining);
      if (!wasActive) return; // a dormant account — active is untouched
      const next = remaining[0];
      if (next) {
        const tok = tokensRef.current.get(next.id) ?? (await secretStoreRef.current.get(next.id));
        if (tok) {
          await activateRef.current(next.id, tok);
          return;
        }
      }
      // Nothing left to fall back to (identity already cleared above).
      lastSyncedBlob.current = null;
      setToken(null);
      setLastSyncedAt(null);
      commitActiveId(null);
      setStatus('disconnected');
    },
    [commitIndex, commitActiveId, clearIdentity],
  );
  forgetRef.current = forgetAccount;

  /** Make `id` the live/active account: reconcile its settings and mint its
   *  identity. Used by switch, reconnect-on-mount, and sync-now. The row must
   *  already exist. */
  const activate = useCallback(
    async (id: string, tok: string): Promise<void> => {
      activatingDepth.current += 1;
      setStatus('syncing');
      setError(null);
      commitActiveId(id);
      setToken(tok);
      tokensRef.current.set(id, tok);
      try {
        // An already-stored account is never the genuine first connect, so never
        // seed its (possibly empty) remote from the current — previous account's —
        // blob; an empty remote is treated as empty (OB-194).
        const updatedAt = await reconcileSettings(tok, false);
        patchRow(id, {lastServerUpdatedAt: updatedAt});
        setLastSyncedAt(updatedAt);
        setStatus('connected');
        const persona = await refreshRef.current(tok); // mint the active identity JWS
        if (persona) {
          const current = indexRef.current.find((r) => r.id === id);
          patchRow(id, {
            email: persona.email,
            subject: persona.subject,
            name: persona.email ?? persona.name ?? current?.name ?? accountHostLabel(accountUrlDefault),
          });
        }
      } catch (err) {
        if (err instanceof AccountError && err.status === 401) {
          // Token rejected/revoked — forget this account.
          setStatus('error');
          setError('That sign-in was rejected. Please sign in again.');
          await forgetRef.current(id);
        } else {
          setStatus('error');
          setError('Could not reach account.book.pub. Check your connection.');
        }
      } finally {
        activatingDepth.current = Math.max(0, activatingDepth.current - 1);
      }
    },
    [commitActiveId, reconcileSettings, patchRow, accountUrlDefault],
  );
  activateRef.current = activate;

  /**
   * Handle a freshly minted token (deep link / paste): ADD it as a new account
   * (or refresh an existing slot when the same identity signs in again), make it
   * active, sync its settings, and mint its identity. Additive — never evicts the
   * accounts already connected.
   */
  const addFromToken = useCallback(
    async (tok: string): Promise<void> => {
      activatingDepth.current += 1;
      // Seed the server blob from local state ONLY when this is the very first
      // account ever connected (nothing in the index at connect time). A later
      // sign-in must not push the current — previously active — account's blob.
      const firstAccount = indexRef.current.length === 0;
      setStatus('syncing');
      setError(null);
      try {
        const updatedAt = await reconcileSettings(tok, firstAccount); // validates (401 ⇒ AccountError)
        const persona = await refreshRef.current(tok); // mints + sets the live identity
        // Dedupe a re-sign-in of the same account into the same slot. Prefer the
        // identity subject; when the issuer asserts no identity (501/dev) fall back
        // to the account URL, so re-signing-in the same dev account reuses its slot
        // rather than piling up duplicates. Dev-only caveat: two *different*
        // identity-less accounts on the same host then collapse into one slot.
        const existing = persona?.subject
          ? indexRef.current.find((r) => r.subject === persona.subject)
          : indexRef.current.find((r) => r.subject === null && r.accountUrl === accountUrlDefault);
        const id = existing?.id ?? newAccountId();
        const row: StoredIndexRow = {
          id,
          name: persona?.email ?? persona?.name ?? existing?.name ?? accountHostLabel(accountUrlDefault),
          email: persona?.email ?? null,
          subject: persona?.subject ?? existing?.subject ?? null,
          accountUrl: accountUrlDefault,
          connectedAt: Date.now(),
          lastServerUpdatedAt: updatedAt,
        };
        await secretStore.set(id, tok);
        tokensRef.current.set(id, tok);
        upsertRow(row);
        commitActiveId(id);
        setToken(tok);
        setLastSyncedAt(updatedAt);
        setStatus('connected');
      } catch (err) {
        if (err instanceof AccountError && err.status === 401) {
          clearIdentity();
          setStatus('error');
          setError('That sign-in was rejected. Please try again.');
        } else {
          // Keep the existing active connection on a transient network error.
          setStatus(activeIdRef.current ? 'connected' : 'disconnected');
          setError('Could not reach account.book.pub. Check your connection.');
        }
      } finally {
        activatingDepth.current = Math.max(0, activatingDepth.current - 1);
      }
    },
    [reconcileSettings, secretStore, upsertRow, commitActiveId, clearIdentity, accountUrlDefault],
  );

  /**
   * Handle a token delivered by the deep link / callback page. Fails closed: a
   * token is accepted ONLY when it answers a sign-in we started (a matching,
   * non-empty state). On desktop the `openbook://` scheme is reachable by any web
   * page, so an unsolicited token here would otherwise silently sign the user in
   * to an attacker's account and upload their settings to it.
   */
  const receive = useCallback(
    (tok: string, state: string) => {
      const expected = pendingState.current ?? readPendingState();
      if (!tok || !expected || !state || state !== expected) return;
      pendingState.current = null;
      clearPendingState();
      void addFromToken(tok);
    },
    [addFromToken],
  );

  // ── Receive the token: desktop deep link, or web popup/callback handoff. ─────
  useEffect(() => {
    if (platform?.onCallback) {
      return platform.onCallback(({token: tok, state}) => receive(tok, state));
    }
    if (typeof window === 'undefined') return;
    const handle = (data: unknown): void => {
      const m = data as {type?: string; token?: string; state?: string} | null;
      if (m?.type === 'openbook-account-token' && typeof m.token === 'string') receive(m.token, m.state ?? '');
    };
    const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(ACCOUNT_CHANNEL) : null;
    bc?.addEventListener('message', (e) => handle(e.data));
    const onStorage = (e: StorageEvent): void => {
      if (e.key === ACCOUNT_HANDOFF_KEY && e.newValue) {
        try {
          handle(JSON.parse(e.newValue));
        } catch {
          /* ignore */
        }
      }
    };
    window.addEventListener('storage', onStorage);
    // A token left by a callback page that loaded before this listener attached.
    try {
      const pending = localStorage.getItem(ACCOUNT_HANDOFF_KEY);
      if (pending) {
        localStorage.removeItem(ACCOUNT_HANDOFF_KEY);
        handle(JSON.parse(pending));
      }
    } catch {
      /* ignore */
    }
    return () => {
      bc?.close();
      window.removeEventListener('storage', onStorage);
    };
  }, [platform, receive]);

  // ── Reconcile on app open: migrate any legacy account, then activate the stored
  //    active account (loading its token from the secret store). Once, on mount. ─
  useEffect(() => {
    void (async () => {
      let rows = readIndex();
      let activeId = readActiveId();
      // One-time migration of the pre-OB-194 single account into the namespaced store.
      if (rows.length === 0) {
        const legacy = readLegacy();
        if (legacy) {
          const id = newAccountId();
          const row: StoredIndexRow = {
            id,
            name: accountHostLabel(resolveAccountUrl()),
            email: null,
            subject: null,
            accountUrl: resolveAccountUrl(),
            connectedAt: legacy.connectedAt ?? Date.now(),
            lastServerUpdatedAt: legacy.lastServerUpdatedAt ?? null,
          };
          let stored = false;
          try {
            await secretStoreRef.current.set(id, legacy.token);
            stored = true;
          } catch {
            /* keychain write failed — leave the legacy record untouched so the next
               launch retries the migration, rather than stranding a dead, tokenless
               slot and discarding the only copy of the token (OB-194 review). */
          }
          if (stored) {
            rows = [row];
            activeId = id;
            writeIndex(rows);
            writeActiveId(activeId);
            try {
              localStorage.removeItem(LEGACY_KEY);
            } catch {
              /* ignore */
            }
          }
        }
      }
      if (!activeId && rows.length) activeId = rows[0].id;
      if (rows.length) {
        indexRef.current = rows;
        setAccounts(rows);
      }
      const target = activeId ? rows.find((r) => r.id === activeId) : undefined;
      if (!target) return;
      commitActiveId(target.id);
      setLastSyncedAt(target.lastServerUpdatedAt);
      const tok = await secretStoreRef.current.get(target.id);
      if (tok) await activateRef.current(target.id, tok);
    })();
    // Run once on mount; everything it touches is reached through stable refs.
  }, []);

  // ── Push the ACTIVE account's local changes (debounced, skipped when unchanged).
  useEffect(() => {
    if (!token) return;
    // Hold off while an activation is in flight: `token` has switched to the new
    // account but the live blob may still be the previous account's, so a push now
    // would upload A's blob under B's token (OB-194 switch-race). The reconcile
    // records the new account's synced baseline; the next real edit pushes cleanly.
    if (activatingDepth.current > 0) return;
    const blob: SyncBlob = {preferences, workspaces};
    const json = JSON.stringify(blob);
    if (json === lastSyncedBlob.current) return;
    const id = setTimeout(() => {
      // Re-check at fire time: a reconcile that landed during the debounce may have
      // recorded this blob as the synced baseline, or another activation may have
      // started — in either case the queued blob is no longer ours to push.
      if (json === lastSyncedBlob.current || activatingDepth.current > 0) return;
      setStatus('syncing');
      client
        .putSettings(token, blob as unknown as Record<string, unknown>)
        .then((res) => {
          lastSyncedBlob.current = json;
          setLastSyncedAt(res.updatedAt);
          setStatus('connected');
          setError(null);
          const aid = activeIdRef.current;
          if (aid) patchRow(aid, {lastServerUpdatedAt: res.updatedAt});
        })
        .catch(() => {
          setStatus('error');
          setError('Sync failed — will retry on the next change.');
        });
    }, 1200);
    return () => clearTimeout(id);
  }, [token, preferences, workspaces, client, patchRow]);

  const signIn = useCallback(() => {
    const state = rand();
    pendingState.current = state;
    writePendingState(state);
    setStatus('connecting');
    setError(null);
    const redirectUri =
      platform?.redirectUri ?? (typeof window !== 'undefined' ? `${window.location.origin}/account/callback` : '');
    const url = client.connectUrl({redirectUri, state, name});
    if (platform?.openSignIn) {
      platform.openSignIn(url);
    } else if (typeof window !== 'undefined') {
      // Web: a popup keeps the app mounted to receive the handoff; fall back to a
      // full navigation if the popup is blocked.
      const popup = window.open(url, 'openbook-signin', 'width=520,height=720');
      if (!popup) window.location.href = url;
    }
  }, [client, name, platform]);

  /**
   * Sign in from a manually pasted code. Unlike {@link receive} this skips the
   * CSRF state check — a paste is a deliberate in-app action by the user, not an
   * unsolicited deep link that any web page could trigger — and still validates
   * the token server-side. Clears any pending deep-link sign-in so a stray late
   * callback can't re-fire.
   */
  const submitCode = useCallback(
    (raw: string) => {
      const tok = extractToken(raw);
      if (!tok) {
        setStatus((s) => (token ? s : 'error'));
        setError('That doesn’t look like a valid code. Paste the code (or the whole openbook:// link) from the browser.');
        return;
      }
      pendingState.current = null;
      clearPendingState();
      setStatus('connecting');
      setError(null);
      void addFromToken(tok);
    },
    [addFromToken, token],
  );

  const cancel = useCallback(() => {
    pendingState.current = null;
    clearPendingState();
    setStatus((s) => (token ? s : 'disconnected'));
    setError(null);
  }, [token]);

  /** Sign out the ACTIVE account (forget its token; switch to another if any). */
  const signOut = useCallback(() => {
    pendingState.current = null;
    clearPendingState();
    lastSyncedBlob.current = null;
    setError(null);
    const id = activeIdRef.current;
    if (id) {
      void forgetRef.current(id);
    } else {
      clearIdentity();
      setToken(null);
      setLastSyncedAt(null);
      setStatus('disconnected');
    }
  }, [clearIdentity]);

  const syncNow = useCallback(() => {
    const id = activeIdRef.current;
    if (id && token) void activateRef.current(id, token);
  }, [token]);

  const setActiveAccount = useCallback(
    (id: string) => {
      if (id === activeIdRef.current) return;
      if (!indexRef.current.some((r) => r.id === id)) return;
      void (async () => {
        clearIdentity(); // drop the prior account's live JWS at once
        const tok = tokensRef.current.get(id) ?? (await secretStoreRef.current.get(id));
        if (!tok) {
          await forgetRef.current(id); // token vanished — drop the dangling slot
          return;
        }
        await activateRef.current(id, tok);
      })();
    },
    [clearIdentity],
  );

  const removeAccount = useCallback((id: string) => {
    void forgetRef.current(id);
  }, []);

  const exposedAccounts = useMemo<ConnectedAccount[]>(
    () =>
      accounts.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        accountUrl: r.accountUrl,
        status: r.id === activeAccountId ? status : 'connected',
      })),
    [accounts, activeAccountId, status],
  );

  const activeAccountUrl = useMemo(
    () => accounts.find((r) => r.id === activeAccountId)?.accountUrl ?? accountUrlDefault,
    [accounts, activeAccountId, accountUrlDefault],
  );

  const value = useMemo<AccountContextValue>(
    () => ({
      status,
      connected: !!token && (status === 'connected' || status === 'syncing'),
      token,
      deviceName: name,
      lastSyncedAt,
      error,
      accountUrl: activeAccountUrl,
      signIn,
      submitCode,
      cancel,
      signOut,
      syncNow,
      accounts: exposedAccounts,
      activeAccountId,
      setActiveAccount,
      addAccount: signIn,
      removeAccount,
    }),
    [
      status,
      token,
      name,
      lastSyncedAt,
      error,
      activeAccountUrl,
      signIn,
      submitCode,
      cancel,
      signOut,
      syncNow,
      exposedAccounts,
      activeAccountId,
      setActiveAccount,
      removeAccount,
    ],
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
};

export const useAccount = (): AccountContextValue => {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error('useAccount must be used within an <AccountProvider>');
  return ctx;
};
