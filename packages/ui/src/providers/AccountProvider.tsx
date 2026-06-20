import React, {createContext, PropsWithChildren, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {AccountClient, AccountError, resolveAccountUrl} from '@open-book/sdk';
import {usePlatformLibrary} from './PlatformLibraryProvider';
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
 */

export type AccountStatus = 'disconnected' | 'connecting' | 'syncing' | 'connected' | 'error';

interface AccountContextValue {
  status: AccountStatus;
  connected: boolean;
  /** The device bearer token, for same-app account API calls (e.g. forwarding's
   *  POST /api/sites). Null when disconnected. Treat as a secret. */
  token: string | null;
  /** The label this device registers under (shown in the account dashboard). */
  deviceName: string;
  /** ISO timestamp of the last successful server sync, or null. */
  lastSyncedAt: string | null;
  /** A human-readable error from the last failed action, or null. */
  error: string | null;
  /** The account service base URL (for an "open dashboard" link). */
  accountUrl: string;
  /** Start the deep-link sign-in flow. */
  signIn: () => void;
  /** Abandon a pending sign-in (returns to disconnected when not yet connected). */
  cancel: () => void;
  /** Forget the local token (does not revoke it server-side — do that in the dashboard). */
  signOut: () => void;
  /** Pull-then-push a reconciliation now. */
  syncNow: () => void;
}

const AccountContext = createContext<AccountContextValue | null>(null);

const STORAGE_KEY = 'openbook.account';
const DEVICE_ID_KEY = 'openbook.deviceId';
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

interface StoredAccount {
  token: string;
  connectedAt: number;
  lastServerUpdatedAt: string | null;
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

function readStored(): StoredAccount | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as StoredAccount;
    return v && typeof v.token === 'string' && v.token ? v : null;
  } catch {
    return null;
  }
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

export const AccountProvider: React.FC<PropsWithChildren<unknown>> = ({children}) => {
  const {account: platform} = usePlatformLibrary();
  const {preferences, update: updatePreferences} = usePreferences();
  const {workspaces, replaceWorkspaces} = useWorkspace();

  const [status, setStatus] = useState<AccountStatus>('disconnected');
  const [token, setToken] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const client = useMemo(() => new AccountClient(), []);
  const accountUrl = useMemo(() => resolveAccountUrl(), []);
  const name = useMemo(() => `OpenBook ${platform?.redirectUri?.startsWith('openbook:') ? 'Desktop' : 'Web'} · ${deviceId()}`, [platform]);

  // The pending sign-in's CSRF state, and the JSON of the last blob we know the
  // server has (so adopting a pull doesn't immediately echo a push back).
  const pendingState = useRef<string | null>(null);
  const lastSyncedBlob = useRef<string | null>(null);

  // Latest preferences/workspaces, read inside async callbacks without re-binding.
  const blobRef = useRef<SyncBlob>({preferences, workspaces});
  blobRef.current = {preferences, workspaces};
  const currentBlob = useCallback((): SyncBlob => ({preferences: blobRef.current.preferences, workspaces: blobRef.current.workspaces}), []);

  const persistToken = useCallback((tok: string, serverUpdatedAt: string | null) => {
    const stored: StoredAccount = {token: tok, connectedAt: Date.now(), lastServerUpdatedAt: serverUpdatedAt};
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // ignore (private mode / quota)
    }
    setToken(tok);
    setLastSyncedAt(serverUpdatedAt);
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

  /** Validate a token, then reconcile: seed an empty account, else adopt remote. */
  const connect = useCallback(
    async (tok: string) => {
      setStatus('syncing');
      setError(null);
      try {
        const {settings, updatedAt} = await client.getSettings(tok); // 401 ⇒ AccountError
        const remoteEmpty = updatedAt === null || (!settings.preferences && !settings.workspaces);
        if (remoteEmpty) {
          const blob = currentBlob();
          const res = await client.putSettings(tok, blob as unknown as Record<string, unknown>);
          lastSyncedBlob.current = JSON.stringify(blob);
          persistToken(tok, res.updatedAt);
        } else {
          adopt(settings);
          lastSyncedBlob.current = JSON.stringify(settings);
          persistToken(tok, updatedAt);
        }
        setStatus('connected');
      } catch (err) {
        if (err instanceof AccountError && err.status === 401) {
          // Token rejected/revoked — forget it.
          try {
            localStorage.removeItem(STORAGE_KEY);
          } catch {
            /* ignore */
          }
          setToken(null);
          setStatus('error');
          setError('That sign-in was rejected. Please try again.');
        } else {
          setStatus(tok ? 'error' : 'disconnected');
          setError('Could not reach account.book.pub. Check your connection.');
        }
      }
    },
    [client, currentBlob, adopt, persistToken],
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
      void connect(tok);
    },
    [connect],
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

  // ── Reconcile on app open if we already hold a token (once, on mount). ───────
  const reconnect = useRef(connect);
  reconnect.current = connect;
  useEffect(() => {
    const stored = readStored();
    if (stored) {
      setToken(stored.token);
      setLastSyncedAt(stored.lastServerUpdatedAt);
      void reconnect.current(stored.token);
    }
  }, []);

  // ── Push local changes (debounced, skipped when they match the server). ──────
  useEffect(() => {
    if (!token) return;
    const blob: SyncBlob = {preferences, workspaces};
    const json = JSON.stringify(blob);
    if (json === lastSyncedBlob.current) return;
    const id = setTimeout(() => {
      setStatus('syncing');
      client
        .putSettings(token, blob as unknown as Record<string, unknown>)
        .then((res) => {
          lastSyncedBlob.current = json;
          setLastSyncedAt(res.updatedAt);
          setStatus('connected');
          setError(null);
          const stored = readStored();
          if (stored) {
            try {
              localStorage.setItem(STORAGE_KEY, JSON.stringify({...stored, lastServerUpdatedAt: res.updatedAt}));
            } catch {
              /* ignore */
            }
          }
        })
        .catch(() => {
          setStatus('error');
          setError('Sync failed — will retry on the next change.');
        });
    }, 1200);
    return () => clearTimeout(id);
  }, [token, preferences, workspaces, client]);

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

  const cancel = useCallback(() => {
    pendingState.current = null;
    clearPendingState();
    setStatus((s) => (token ? s : 'disconnected'));
    setError(null);
  }, [token]);

  const signOut = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    pendingState.current = null;
    clearPendingState();
    lastSyncedBlob.current = null;
    setToken(null);
    setLastSyncedAt(null);
    setError(null);
    setStatus('disconnected');
  }, []);

  const syncNow = useCallback(() => {
    if (token) void connect(token);
  }, [token, connect]);

  const value = useMemo<AccountContextValue>(
    () => ({
      status,
      connected: !!token && (status === 'connected' || status === 'syncing'),
      token,
      deviceName: name,
      lastSyncedAt,
      error,
      accountUrl,
      signIn,
      cancel,
      signOut,
      syncNow,
    }),
    [status, token, name, lastSyncedAt, error, accountUrl, signIn, cancel, signOut, syncNow],
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
};

export const useAccount = (): AccountContextValue => {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error('useAccount must be used within an <AccountProvider>');
  return ctx;
};
