/**
 * Local, device-scoped preferences for the desktop app's self-update behaviour
 * (OB update-preferences). These are read by two consumers: the Updates section
 * in General settings (the UI that edits them) and — later — a background
 * scheduler that decides when to run an automatic check. Both go through this
 * typed accessor rather than touching `localStorage` directly, so the storage
 * keys and value shapes have a single source of truth.
 *
 * Storage: discrete keys (`updates.cadence`, `updates.securityOnly`,
 * `updates.lastCheckAt`, `updates.lastCheckSuccessAt`, and advisory state)
 * rather than one blob, so
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

import type {UpdateAdvisory} from '../providers/PlatformCapabilitiesProvider';

/** How often the app checks for updates on its own. `never` = don't contact the
 *  update server at all (a manual "Check for updates" still works). */
export type UpdateCadence = 'daily' | 'weekly' | 'never';

export interface UpdateAdvisorySnooze {
  advisoryId: string;
  snoozedAt: number;
  /** A process-local token: a different app launch expires the snooze early. */
  launchId: string;
}

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
  /** The one active advisory snooze, if its stored shape is valid. */
  advisorySnooze: UpdateAdvisorySnooze | null;
  /** Advisory ids whose typed acknowledgement was completed on this device. */
  dismissedAdvisoryIds: string[];
  /** Last active advisory returned by a completed check, for relaunch display. */
  lastSeenAdvisory: UpdateAdvisory | null;
}

export const UPDATE_PREFERENCE_KEYS = {
  cadence: 'updates.cadence',
  securityOnly: 'updates.securityOnly',
  lastCheckAt: 'updates.lastCheckAt',
  lastCheckSuccessAt: 'updates.lastCheckSuccessAt',
  advisorySnooze: 'updates.advisorySnooze',
  dismissedAdvisoryIds: 'updates.dismissedAdvisoryIds',
  lastSeenAdvisory: 'updates.lastSeenAdvisory',
} as const;

export const DEFAULT_UPDATE_PREFERENCES: UpdatePreferences = {
  cadence: 'daily',
  securityOnly: false,
  lastCheckAt: null,
  lastCheckSuccessAt: null,
  advisorySnooze: null,
  dismissedAdvisoryIds: [],
  lastSeenAdvisory: null,
};

export const UPDATE_ADVISORY_SNOOZE_MS = 24 * 60 * 60 * 1000;

// One token per loaded desktop UI. It survives component remounts, while a
// relaunch loads a fresh bundle and therefore makes every snooze visible again.
const UPDATE_ADVISORY_LAUNCH_ID = `${Date.now()}-${Math.random()}`;

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

function removeRaw(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore (private mode)
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

/** Read the persisted advisory snooze, rejecting partial/corrupt JSON. */
export function getUpdateAdvisorySnooze(): UpdateAdvisorySnooze | null {
  const value = readRaw(UPDATE_PREFERENCE_KEYS.advisorySnooze);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return typeof parsed.advisoryId === 'string' &&
      parsed.advisoryId.length > 0 &&
      typeof parsed.snoozedAt === 'number' &&
      Number.isFinite(parsed.snoozedAt) &&
      parsed.snoozedAt > 0 &&
      typeof parsed.launchId === 'string' &&
      parsed.launchId.length > 0
      ? {
        advisoryId: parsed.advisoryId,
        snoozedAt: parsed.snoozedAt,
        launchId: parsed.launchId,
      }
      : null;
  } catch {
    return null;
  }
}

/** Hide one advisory for this launch, for no longer than 24 hours. */
export function setUpdateAdvisorySnooze(
  advisoryId: string,
  snoozedAt = Date.now(),
  launchId = UPDATE_ADVISORY_LAUNCH_ID,
): void {
  writeRaw(UPDATE_PREFERENCE_KEYS.advisorySnooze, JSON.stringify({advisoryId, snoozedAt, launchId}));
}

/** True only during the launch that created the still-fresh 24-hour snooze. */
export function isUpdateAdvisorySnoozed(
  advisoryId: string,
  now = Date.now(),
  launchId = UPDATE_ADVISORY_LAUNCH_ID,
): boolean {
  const snooze = getUpdateAdvisorySnooze();
  return (
    snooze?.advisoryId === advisoryId &&
    snooze.launchId === launchId &&
    now < snooze.snoozedAt + UPDATE_ADVISORY_SNOOZE_MS
  );
}

/** Read the locally acknowledged advisory ids, ignoring corrupt entries. */
export function getDismissedUpdateAdvisoryIds(): string[] {
  const value = readRaw(UPDATE_PREFERENCE_KEYS.dismissedAdvisoryIds);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  } catch {
    return [];
  }
}

export function isUpdateAdvisoryDismissed(advisoryId: string): boolean {
  return getDismissedUpdateAdvisoryIds().includes(advisoryId);
}

/** Persist a completed typed acknowledgement for this exact advisory id. */
export function dismissUpdateAdvisory(advisoryId: string): void {
  const ids = getDismissedUpdateAdvisoryIds();
  if (!ids.includes(advisoryId)) ids.push(advisoryId);
  writeRaw(UPDATE_PREFERENCE_KEYS.dismissedAdvisoryIds, JSON.stringify(ids));
}

/** Read the last validated advisory snapshot used to restore a snooze on launch. */
export function getLastSeenUpdateAdvisory(): UpdateAdvisory | null {
  const value = readRaw(UPDATE_PREFERENCE_KEYS.lastSeenAdvisory);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<UpdateAdvisory>;
    if (
      typeof parsed.id !== 'string' ||
      parsed.id.length === 0 ||
      (parsed.severity !== 'vulnerable' && parsed.severity !== 'major-bug') ||
      typeof parsed.message !== 'string' ||
      parsed.message.length === 0 ||
      Array.from(parsed.message).length > 500 ||
      typeof parsed.affectedRange !== 'string' ||
      parsed.affectedRange.length === 0 ||
      Array.from(parsed.affectedRange).length > 200 ||
      (parsed.minSafeVersion !== undefined &&
        (typeof parsed.minSafeVersion !== 'string' ||
          parsed.minSafeVersion.length === 0 ||
          Array.from(parsed.minSafeVersion).length > 64))
    ) {
      return null;
    }
    return {
      id: parsed.id,
      severity: parsed.severity,
      message: parsed.message,
      affectedRange: parsed.affectedRange,
      minSafeVersion: parsed.minSafeVersion,
    };
  } catch {
    return null;
  }
}

/** Replace (or clear) the advisory snapshot after a completed update check. */
export function setLastSeenUpdateAdvisory(advisory: UpdateAdvisory | null): void {
  if (advisory === null) {
    removeRaw(UPDATE_PREFERENCE_KEYS.lastSeenAdvisory);
    return;
  }
  writeRaw(UPDATE_PREFERENCE_KEYS.lastSeenAdvisory, JSON.stringify(advisory));
}

/** Read all preferences at once (the shape the scheduler wants). */
export function readUpdatePreferences(): UpdatePreferences {
  return {
    cadence: getUpdateCadence(),
    securityOnly: getUpdateSecurityOnly(),
    lastCheckAt: getUpdateLastCheckAt(),
    lastCheckSuccessAt: getUpdateLastCheckSuccessAt(),
    advisorySnooze: getUpdateAdvisorySnooze(),
    dismissedAdvisoryIds: getDismissedUpdateAdvisoryIds(),
    lastSeenAdvisory: getLastSeenUpdateAdvisory(),
  };
}
