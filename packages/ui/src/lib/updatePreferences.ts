/**
 * Local, device-scoped preferences for the desktop app's self-update behaviour
 * (OB update-preferences). These are read by two consumers: the Updates section
 * in General settings (the UI that edits them) and — later — a background
 * scheduler that decides when to run an automatic check. Both go through this
 * typed accessor rather than touching `localStorage` directly, so the storage
 * keys and value shapes have a single source of truth.
 *
 * Storage: discrete keys (`updates.cadence`, `updates.securityOnly`,
 * `updates.lastCheckAt`, `updates.lastCheckSuccessAt`) rather than one blob, so
 * the scheduler can read just the cadence without parsing the rest, and a
 * partial write can't clobber an unrelated field.
 *
 * Two timestamps, deliberately: `lastCheckAt` is stamped on every check
 * *attempt* (success or failure) — it's what the scheduler throttles on, so a
 * failing update server can't cause a retry storm. `lastCheckSuccessAt` is
 * stamped only when a check *completed* — it's what the UI shows as "Last
 * checked", so a failed check never reads as a fresh successful one.
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
  /** Epoch-ms of the last check *attempt* (success or failure) — the scheduler's
   *  throttle input. `null` if never attempted. */
  lastCheckAt: number | null;
  /** Epoch-ms of the last check that *completed* (reported a result) — what the
   *  UI shows as "Last checked". `null` if no check has ever succeeded. */
  lastCheckSuccessAt: number | null;
}

export const UPDATE_PREFERENCE_KEYS = {
  cadence: 'updates.cadence',
  securityOnly: 'updates.securityOnly',
  lastCheckAt: 'updates.lastCheckAt',
  lastCheckSuccessAt: 'updates.lastCheckSuccessAt',
} as const;

export const DEFAULT_UPDATE_PREFERENCES: UpdatePreferences = {
  cadence: 'daily',
  securityOnly: false,
  lastCheckAt: null,
  lastCheckSuccessAt: null,
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

function readTimestamp(key: string): number | null {
  const raw = readRaw(key);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Read the last check-*attempt* timestamp (epoch ms), or `null` if never / unparseable. */
export function getUpdateLastCheckAt(): number | null {
  return readTimestamp(UPDATE_PREFERENCE_KEYS.lastCheckAt);
}

/** Stamp a check attempt. Call on EVERY check, success or failure — the
 *  scheduler throttles on this. */
export function setUpdateLastCheckAt(at: number): void {
  writeRaw(UPDATE_PREFERENCE_KEYS.lastCheckAt, String(at));
}

/** Read the last *successful*-check timestamp (epoch ms), or `null` if never / unparseable. */
export function getUpdateLastCheckSuccessAt(): number | null {
  return readTimestamp(UPDATE_PREFERENCE_KEYS.lastCheckSuccessAt);
}

/** Stamp a completed check. Call only when the check reported a result
 *  (up-to-date or update-available) — the UI's "Last checked" reads this. */
export function setUpdateLastCheckSuccessAt(at: number): void {
  writeRaw(UPDATE_PREFERENCE_KEYS.lastCheckSuccessAt, String(at));
}

/** Read all preferences at once (the shape the scheduler wants). */
export function readUpdatePreferences(): UpdatePreferences {
  return {
    cadence: getUpdateCadence(),
    securityOnly: getUpdateSecurityOnly(),
    lastCheckAt: getUpdateLastCheckAt(),
    lastCheckSuccessAt: getUpdateLastCheckSuccessAt(),
  };
}
