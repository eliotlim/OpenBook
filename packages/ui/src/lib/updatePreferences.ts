/**
 * Local, device-scoped preferences for the desktop app's self-update behaviour
 * (OB update-preferences). These are read by two consumers: the Updates section
 * in General settings (the UI that edits them) and — later — a background
 * scheduler that decides when to run an automatic check. Both go through this
 * typed accessor rather than touching `localStorage` directly, so the storage
 * keys and value shapes have a single source of truth.
 *
 * Storage: three discrete keys (`updates.cadence`, `updates.securityOnly`,
 * `updates.lastCheckAt`) rather than one blob, so the scheduler can read just
 * the cadence without parsing the rest, and a partial write can't clobber an
 * unrelated field.
 *
 * SSR: every read is guarded and falls back to the defaults when there is no
 * `window` (or storage throws), so this module is safe to import from
 * server-rendered code paths.
 */

/** How often the app checks for updates on its own. `never` = don't contact the
 *  update server at all (a manual "Check for updates" still works). */
export type UpdateCadence = 'daily' | 'weekly' | 'never';

export interface UpdatePreferences {
  /** Automatic-check frequency. Default `daily`. */
  cadence: UpdateCadence;
  /** When true, only security updates are acted on automatically. Default false. */
  securityOnly: boolean;
  /** Epoch-ms of the last completed check, or `null` if never checked. */
  lastCheckAt: number | null;
}

export const UPDATE_PREFERENCE_KEYS = {
  cadence: 'updates.cadence',
  securityOnly: 'updates.securityOnly',
  lastCheckAt: 'updates.lastCheckAt',
} as const;

export const DEFAULT_UPDATE_PREFERENCES: UpdatePreferences = {
  cadence: 'daily',
  securityOnly: false,
  lastCheckAt: null,
};

const CADENCES: ReadonlySet<UpdateCadence> = new Set(['daily', 'weekly', 'never']);

function readRaw(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore (private mode / quota)
  }
}

/** Read the persisted cadence, defaulting to `daily` for missing/invalid values. */
export function getUpdateCadence(): UpdateCadence {
  const raw = readRaw(UPDATE_PREFERENCE_KEYS.cadence);
  return raw && CADENCES.has(raw as UpdateCadence) ? (raw as UpdateCadence) : DEFAULT_UPDATE_PREFERENCES.cadence;
}

export function setUpdateCadence(cadence: UpdateCadence): void {
  writeRaw(UPDATE_PREFERENCE_KEYS.cadence, cadence);
}

/** Read the "security updates only" flag (default false). */
export function getUpdateSecurityOnly(): boolean {
  return readRaw(UPDATE_PREFERENCE_KEYS.securityOnly) === 'true';
}

export function setUpdateSecurityOnly(securityOnly: boolean): void {
  writeRaw(UPDATE_PREFERENCE_KEYS.securityOnly, securityOnly ? 'true' : 'false');
}

/** Read the last-check timestamp (epoch ms), or `null` if never / unparseable. */
export function getUpdateLastCheckAt(): number | null {
  const raw = readRaw(UPDATE_PREFERENCE_KEYS.lastCheckAt);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function setUpdateLastCheckAt(at: number): void {
  writeRaw(UPDATE_PREFERENCE_KEYS.lastCheckAt, String(at));
}

/** Read all three preferences at once (the shape the scheduler wants). */
export function readUpdatePreferences(): UpdatePreferences {
  return {
    cadence: getUpdateCadence(),
    securityOnly: getUpdateSecurityOnly(),
    lastCheckAt: getUpdateLastCheckAt(),
  };
}
