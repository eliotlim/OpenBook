import React, {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {getServerUrlOverride, setServerUrlOverride} from '@book.dev/sdk';

/**
 * A workspace is a named connection to a server. Switching workspaces re-points
 * the app at that server (via the shared server-URL override) and reloads, so
 * the page list and documents come from the selected source. `serverUrl: null`
 * means "this device's default server" (no override) — the always-present local
 * workspace.
 */
export interface Workspace {
  id: string;
  icon: string;
  name: string;
  serverUrl: string | null;
}

export interface WorkspaceContext {
  /** All configured workspaces, in display order. */
  workspaces: Workspace[];
  /** The workspace currently connected (matches the active server override). */
  workspace: Workspace;
  /** Switch to a workspace. Reloads the app if it points at a different server. */
  selectWorkspace: (id: string) => void;
  /** Add a workspace and return it. */
  addWorkspace: (input: {name: string; serverUrl: string | null; icon?: string}) => Workspace;
  /** Remove a workspace (the active one and the last one can't be removed). */
  removeWorkspace: (id: string) => void;
  /** Edit a workspace's name/icon/url in place. */
  updateWorkspace: (id: string, patch: Partial<Omit<Workspace, 'id'>>) => void;
  /** Replace the whole list (account sync adopting a synced list). Always keeps a
   *  local workspace + the active server present, and never switches servers. */
  replaceWorkspaces: (list: Workspace[]) => void;
}

const WORKSPACES_KEY = 'openbook.workspaces';

const LOCAL_WORKSPACE: Workspace = {
  id: 'local',
  icon: '🏡',
  name: 'My Workspace',
  serverUrl: null,
};

const sameTarget = (a: string | null, b: string | null): boolean => (a ?? null) === (b ?? null);

const makeId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `ws-${Math.random().toString(36).slice(2)}`;

/** A short, human label for a server URL (its host), falling back to the raw value. */
export const workspaceHostLabel = (serverUrl: string | null): string => {
  if (!serverUrl) return 'This device';
  try {
    return new URL(serverUrl).host || serverUrl;
  } catch {
    return serverUrl;
  }
};

const readWorkspaces = (): Workspace[] => {
  if (typeof localStorage === 'undefined') return [LOCAL_WORKSPACE];
  let list: Workspace[] = [LOCAL_WORKSPACE];
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY);
    const parsed = raw ? (JSON.parse(raw) as Workspace[]) : null;
    if (Array.isArray(parsed) && parsed.length > 0) list = parsed;
  } catch {
    // Corrupt storage; fall back to the default local workspace.
  }
  // Always keep a local workspace present so there's a way back to the default.
  if (!list.some((w) => w.serverUrl === null)) list = [LOCAL_WORKSPACE, ...list];
  // Represent a connection made elsewhere (Server settings) as a workspace, so
  // the switcher always reflects the server we're actually talking to.
  const override = getServerUrlOverride();
  if (override && !list.some((w) => sameTarget(w.serverUrl, override))) {
    list = [...list, {id: makeId(), icon: '🌐', name: workspaceHostLabel(override), serverUrl: override}];
  }
  return list;
};

const writeWorkspaces = (list: Workspace[]): void => {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(WORKSPACES_KEY, JSON.stringify(list));
};

const currentIdFor = (list: Workspace[]): string => {
  const override = getServerUrlOverride();
  return (list.find((w) => sameTarget(w.serverUrl, override)) ?? list[0]).id;
};

/** `null` (this device) or a well-formed http(s) URL — never a `javascript:`,
 *  `file:`, or otherwise unexpected scheme that a synced/poisoned blob could use
 *  to re-point the data client somewhere hostile when the workspace is selected. */
const isSafeServerUrl = (u: unknown): boolean => {
  if (u === null) return true;
  if (typeof u !== 'string') return false;
  try {
    const {protocol} = new URL(u);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

/** A workspace entry is well-formed enough to trust from a synced blob — and its
 *  `serverUrl` is a safe scheme (the blob is untrusted input; see the account
 *  service README). */
const isWorkspace = (w: unknown): w is Workspace =>
  !!w &&
  typeof w === 'object' &&
  typeof (w as Workspace).id === 'string' &&
  typeof (w as Workspace).name === 'string' &&
  isSafeServerUrl((w as Workspace).serverUrl);

export const WorkspaceContext = createContext<WorkspaceContext>({
  workspaces: [LOCAL_WORKSPACE],
  workspace: LOCAL_WORKSPACE,
  selectWorkspace: () => undefined,
  addWorkspace: () => LOCAL_WORKSPACE,
  removeWorkspace: () => undefined,
  updateWorkspace: () => undefined,
  replaceWorkspaces: () => undefined,
});

export const useWorkspace = () => useContext(WorkspaceContext);

export const WorkspaceProvider: React.FC<PropsWithChildren<unknown>> = ({children}) => {
  // Start from the deterministic default so server and first client paint agree;
  // hydrate the real list (and which one is active) from storage after mount.
  const [workspaces, setWorkspaces] = useState<Workspace[]>([LOCAL_WORKSPACE]);
  const [currentId, setCurrentId] = useState<string>(LOCAL_WORKSPACE.id);

  useEffect(() => {
    const list = readWorkspaces();
    setWorkspaces(list);
    setCurrentId(currentIdFor(list));
    writeWorkspaces(list);
  }, []);

  const workspace = useMemo(
    () => workspaces.find((w) => w.id === currentId) ?? workspaces[0] ?? LOCAL_WORKSPACE,
    [workspaces, currentId],
  );

  const selectWorkspace = useCallback(
    (id: string) => {
      const ws = workspaces.find((w) => w.id === id);
      if (!ws) return;
      // Already on this server — just mark it active (no reload needed).
      if (sameTarget(ws.serverUrl, getServerUrlOverride())) {
        setCurrentId(id);
        return;
      }
      // Re-point the data client at the new server and reload so every provider
      // re-initializes against it (mirrors the Server settings flow).
      setServerUrlOverride(ws.serverUrl);
      if (typeof window !== 'undefined') window.location.reload();
    },
    [workspaces],
  );

  const addWorkspace = useCallback(
    (input: {name: string; serverUrl: string | null; icon?: string}): Workspace => {
      const trimmedUrl = input.serverUrl?.trim();
      const ws: Workspace = {
        id: makeId(),
        icon: input.icon?.trim() || '📓',
        name: input.name.trim() || workspaceHostLabel(trimmedUrl || null),
        serverUrl: trimmedUrl && trimmedUrl.length > 0 ? trimmedUrl : null,
      };
      setWorkspaces((prev) => {
        const next = [...prev, ws];
        writeWorkspaces(next);
        return next;
      });
      return ws;
    },
    [],
  );

  const removeWorkspace = useCallback(
    (id: string) => {
      setWorkspaces((prev) => {
        if (prev.length <= 1 || id === currentId) return prev;
        const next = prev.filter((w) => w.id !== id);
        writeWorkspaces(next);
        return next;
      });
    },
    [currentId],
  );

  const updateWorkspace = useCallback((id: string, patch: Partial<Omit<Workspace, 'id'>>) => {
    setWorkspaces((prev) => {
      const next = prev.map((w) => (w.id === id ? {...w, ...patch} : w));
      writeWorkspaces(next);
      return next;
    });
  }, []);

  const replaceWorkspaces = useCallback((incoming: Workspace[]) => {
    let list = (Array.isArray(incoming) ? incoming : []).filter(isWorkspace);
    // Always keep a way back to the local server.
    if (!list.some((w) => w.serverUrl === null)) list = [LOCAL_WORKSPACE, ...list];
    // Keep the server we're actually talking to represented (don't yank it away).
    const override = getServerUrlOverride();
    if (override && !list.some((w) => sameTarget(w.serverUrl, override))) {
      list = [...list, {id: makeId(), icon: '🌐', name: workspaceHostLabel(override), serverUrl: override}];
    }
    setWorkspaces(list);
    // Re-resolve which one is active by server (ids may differ across devices).
    setCurrentId(currentIdFor(list));
    writeWorkspaces(list);
  }, []);

  const value = useMemo<WorkspaceContext>(
    () => ({workspaces, workspace, selectWorkspace, addWorkspace, removeWorkspace, updateWorkspace, replaceWorkspaces}),
    [workspaces, workspace, selectWorkspace, addWorkspace, removeWorkspace, updateWorkspace, replaceWorkspaces],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
};
