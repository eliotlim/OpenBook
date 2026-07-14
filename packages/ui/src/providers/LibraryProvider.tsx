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
 * A library is a named connection to a server. Switching libraries re-points
 * the app at that server (via the shared server-URL override) and reloads, so
 * the page list and documents come from the selected source. `serverUrl: null`
 * means "this device's default server" (no override) — the always-present local
 * library.
 */
export interface Library {
  id: string;
  icon: string;
  name: string;
  serverUrl: string | null;
}

export interface LibraryContext {
  /** All configured libraries, in display order. */
  libraries: Library[];
  /** The library currently connected (matches the active server override). */
  library: Library;
  /** Switch to a library. Reloads the app if it points at a different server. */
  selectLibrary: (id: string) => void;
  /** Add a library and return it. */
  addLibrary: (input: {name: string; serverUrl: string | null; icon?: string}) => Library;
  /** Remove a library (the active one and the last one can't be removed). */
  removeLibrary: (id: string) => void;
  /** Edit a library's name/icon/url in place. */
  updateLibrary: (id: string, patch: Partial<Omit<Library, 'id'>>) => void;
  /** Replace the whole list (account sync adopting a synced list). Always keeps a
   *  local library + the active server present, and never switches servers. Returns
   *  the normalized list it stored (it may filter/prepend/synthesize entries), so the
   *  caller can record the exact result as a sync baseline (ER-9). */
  replaceLibraries: (list: Library[]) => Library[];
}

// Persisted storage key for the library/server list.
export const LIBRARIES_KEY = 'openbook.libraries';
// Pre-rename storage key. Read once on init for a one-time migration into
// {@link LIBRARIES_KEY}, then removed. Used only by that migration.
export const LEGACY_LIBRARIES_KEY = 'openbook.workspaces';

const LOCAL_LIBRARY: Library = {
  id: 'local',
  icon: '🏡',
  name: 'My Library',
  serverUrl: null,
};

const sameTarget = (a: string | null, b: string | null): boolean => (a ?? null) === (b ?? null);

const makeId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `ws-${Math.random().toString(36).slice(2)}`;

/** A short, human label for a server URL (its host), falling back to the raw value. */
export const libraryHostLabel = (serverUrl: string | null): string => {
  if (!serverUrl) return 'This device';
  try {
    return new URL(serverUrl).host || serverUrl;
  } catch {
    return serverUrl;
  }
};

const readLibraries = (): Library[] => {
  if (typeof localStorage === 'undefined') return [LOCAL_LIBRARY];
  let list: Library[] = [LOCAL_LIBRARY];
  try {
    let raw = localStorage.getItem(LIBRARIES_KEY);
    if (raw === null) {
      // One-time migration: the current key is absent, so adopt any list saved
      // under the pre-rename key, re-persist it under the new key, and drop the
      // old one so this runs exactly once. A present current key always wins —
      // the legacy key is ignored (no clobber).
      const legacy = localStorage.getItem(LEGACY_LIBRARIES_KEY);
      if (legacy !== null) {
        raw = legacy;
        localStorage.setItem(LIBRARIES_KEY, legacy);
        localStorage.removeItem(LEGACY_LIBRARIES_KEY);
      }
    }
    const parsed = raw ? (JSON.parse(raw) as Library[]) : null;
    if (Array.isArray(parsed) && parsed.length > 0) list = parsed;
  } catch {
    // Corrupt storage (incl. a malformed migrated value); fall back to the
    // default local library.
  }
  // Always keep a local library present so there's a way back to the default.
  if (!list.some((l) => l.serverUrl === null)) list = [LOCAL_LIBRARY, ...list];
  // Represent a connection made elsewhere (Server settings) as a library, so
  // the switcher always reflects the server we're actually talking to.
  const override = getServerUrlOverride();
  if (override && !list.some((l) => sameTarget(l.serverUrl, override))) {
    list = [...list, {id: makeId(), icon: '🌐', name: libraryHostLabel(override), serverUrl: override}];
  }
  return list;
};

const writeLibraries = (list: Library[]): void => {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(LIBRARIES_KEY, JSON.stringify(list));
};

const currentIdFor = (list: Library[]): string => {
  const override = getServerUrlOverride();
  return (list.find((l) => sameTarget(l.serverUrl, override)) ?? list[0]).id;
};

/** `null` (this device) or a well-formed http(s) URL — never a `javascript:`,
 *  `file:`, or otherwise unexpected scheme that a synced/poisoned blob could use
 *  to re-point the data client somewhere hostile when the library is selected. */
export const isSafeServerUrl = (u: unknown): boolean => {
  if (u === null) return true;
  if (typeof u !== 'string') return false;
  try {
    const {protocol} = new URL(u);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

/** A library entry is well-formed enough to trust from a synced blob — and its
 *  `serverUrl` is a safe scheme (the blob is untrusted input; see the account
 *  service README). */
const isLibrary = (l: unknown): l is Library =>
  !!l &&
  typeof l === 'object' &&
  typeof (l as Library).id === 'string' &&
  typeof (l as Library).name === 'string' &&
  isSafeServerUrl((l as Library).serverUrl);

export const LibraryContext = createContext<LibraryContext>({
  libraries: [LOCAL_LIBRARY],
  library: LOCAL_LIBRARY,
  selectLibrary: () => undefined,
  addLibrary: () => LOCAL_LIBRARY,
  removeLibrary: () => undefined,
  updateLibrary: () => undefined,
  replaceLibraries: () => [],
});

export const useLibrary = () => useContext(LibraryContext);

export const LibraryProvider: React.FC<PropsWithChildren<unknown>> = ({children}) => {
  // Start from the deterministic default so server and first client paint agree;
  // hydrate the real list (and which one is active) from storage after mount.
  const [libraries, setLibraries] = useState<Library[]>([LOCAL_LIBRARY]);
  const [currentId, setCurrentId] = useState<string>(LOCAL_LIBRARY.id);

  useEffect(() => {
    const list = readLibraries();
    setLibraries(list);
    setCurrentId(currentIdFor(list));
    writeLibraries(list);
  }, []);

  const library = useMemo(
    () => libraries.find((l) => l.id === currentId) ?? libraries[0] ?? LOCAL_LIBRARY,
    [libraries, currentId],
  );

  const selectLibrary = useCallback(
    (id: string) => {
      const lib = libraries.find((l) => l.id === id);
      if (!lib) return;
      // Already on this server — just mark it active (no reload needed).
      if (sameTarget(lib.serverUrl, getServerUrlOverride())) {
        setCurrentId(id);
        return;
      }
      // Re-point the data client at the new server and reload so every provider
      // re-initializes against it (mirrors the Server settings flow).
      setServerUrlOverride(lib.serverUrl);
      if (typeof window !== 'undefined') window.location.reload();
    },
    [libraries],
  );

  const addLibrary = useCallback(
    (input: {name: string; serverUrl: string | null; icon?: string}): Library => {
      const trimmedUrl = input.serverUrl?.trim();
      const lib: Library = {
        id: makeId(),
        icon: input.icon?.trim() || '📓',
        name: input.name.trim() || libraryHostLabel(trimmedUrl || null),
        serverUrl: trimmedUrl && trimmedUrl.length > 0 ? trimmedUrl : null,
      };
      setLibraries((prev) => {
        const next = [...prev, lib];
        writeLibraries(next);
        return next;
      });
      return lib;
    },
    [],
  );

  const removeLibrary = useCallback(
    (id: string) => {
      setLibraries((prev) => {
        if (prev.length <= 1 || id === currentId) return prev;
        const next = prev.filter((l) => l.id !== id);
        writeLibraries(next);
        return next;
      });
    },
    [currentId],
  );

  const updateLibrary = useCallback((id: string, patch: Partial<Omit<Library, 'id'>>) => {
    setLibraries((prev) => {
      const next = prev.map((l) => (l.id === id ? {...l, ...patch} : l));
      writeLibraries(next);
      return next;
    });
  }, []);

  const replaceLibraries = useCallback((incoming: Library[]): Library[] => {
    let list = (Array.isArray(incoming) ? incoming : []).filter(isLibrary);
    // Always keep a way back to the local server.
    if (!list.some((l) => l.serverUrl === null)) list = [LOCAL_LIBRARY, ...list];
    // Keep the server we're actually talking to represented (don't yank it away).
    const override = getServerUrlOverride();
    if (override && !list.some((l) => sameTarget(l.serverUrl, override))) {
      list = [...list, {id: makeId(), icon: '🌐', name: libraryHostLabel(override), serverUrl: override}];
    }
    setLibraries(list);
    // Re-resolve which one is active by server (ids may differ across devices).
    setCurrentId(currentIdFor(list));
    writeLibraries(list);
    // Return the stored list so account sync can baseline against the exact shape
    // (incl. a synthesized override library's random id) the push will serialize.
    return list;
  }, []);

  const value = useMemo<LibraryContext>(
    () => ({libraries, library, selectLibrary, addLibrary, removeLibrary, updateLibrary, replaceLibraries}),
    [libraries, library, selectLibrary, addLibrary, removeLibrary, updateLibrary, replaceLibraries],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
};
