import React, {createContext, useCallback, useContext, useEffect, useMemo, useState} from 'react';

/** A user's identity within the app. Cosmetic today (local-first, no accounts). */
export interface ProfilePreferences {
  name: string;
  displayName: string;
  /** Avatar emoji. Empty = derive a lettered (initials) avatar from the name. */
  avatar: string;
  /** Avatar image as a small data URL. Takes precedence over the emoji. */
  avatarImage: string;
  bio: string;
}

/** General behavior toggles that aren't layout (those live in the HUD). */
export interface GeneralPreferences {
  /** Ask before moving a page to the trash. Default true (today's behavior). */
  confirmOnTrash: boolean;
  /** Spellcheck the editor while typing. */
  spellcheck: boolean;
}

export interface Preferences {
  profile: ProfilePreferences;
  general: GeneralPreferences;
}

export const DEFAULT_PREFERENCES: Preferences = {
  profile: {name: '', displayName: '', avatar: '', avatarImage: '', bio: ''},
  general: {confirmOnTrash: true, spellcheck: true},
};

/** A nested partial — every key optional, recursively — for `update(patch)`. */
type DeepPartial<T> = {[K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]};

interface PreferencesContextValue {
  preferences: Preferences;
  /** Shallow-merge a patch per section (one level of nesting), then persist. */
  update: (patch: DeepPartial<Preferences>) => void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export const PREFERENCES_STORAGE_KEY = 'openbook.preferences';

/** Merge stored prefs over the defaults so a shape grown after a value was
 *  persisted (a new toggle) comes back defaulted rather than undefined. */
function mergeStored(stored: DeepPartial<Preferences> | null): Preferences {
  return {
    profile: {...DEFAULT_PREFERENCES.profile, ...stored?.profile},
    general: {...DEFAULT_PREFERENCES.general, ...stored?.general},
  };
}

function readStored(): Preferences {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCES;
  try {
    const raw = localStorage.getItem(PREFERENCES_STORAGE_KEY);
    return raw ? mergeStored(JSON.parse(raw) as DeepPartial<Preferences>) : DEFAULT_PREFERENCES;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

/**
 * Durable, local-only user preferences (profile + behavior toggles), persisted
 * to localStorage. SSR-safe: the first render (server + the client's hydration
 * pass) uses the defaults so the two agree, and the stored values are adopted in
 * a post-mount effect — reading localStorage during the initial render would
 * diverge from the server HTML and trip a hydration mismatch.
 */
export const PreferencesProvider: React.FC<React.PropsWithChildren<unknown>> = ({children}) => {
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);

  // Adopt the persisted values once we're on the client.
  useEffect(() => {
    const stored = readStored();
    if (stored !== DEFAULT_PREFERENCES) setPreferences(stored);
  }, []);

  const update = useCallback((patch: DeepPartial<Preferences>) => {
    setPreferences((prev) => {
      const next: Preferences = {
        profile: {...prev.profile, ...patch.profile},
        general: {...prev.general, ...patch.general},
      };
      try {
        localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore (private mode / quota)
      }
      return next;
    });
  }, []);

  const value = useMemo<PreferencesContextValue>(() => ({preferences, update}), [preferences, update]);

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
};

export const usePreferences = (): PreferencesContextValue => {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error('usePreferences must be used within a <PreferencesProvider>');
  return ctx;
};
