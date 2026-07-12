/**
 * Decision logic for the background update scheduler (OB update-scheduler).
 * Pure — no timers, no platform calls, no React — so the whole
 * cadence × security-only × check-outcome matrix is unit-testable. The host
 * component (`components/UpdateScheduler.tsx`) owns the clock and the side
 * effects (running the check, downloading, toasting) and consults this module
 * for the two questions that matter:
 *
 *   1. {@link isBackgroundCheckDue} — should a background check run *now*,
 *      given the cadence preference and the last check *attempt*? (`never`
 *      means literally zero requests; a manual Settings check still works.)
 *   2. {@link decideUpdateAction} — given a completed check, what do we do?
 *      Install the same-major update (security updates always qualify; other
 *      updates only when "security only" is off), and/or announce — once per
 *      major, informationally, never installing — that a newer MAJOR exists.
 *
 * Majors are never crossed automatically: `downloadAndInstall` goes through
 * the Tauri manifest which only serves the current major line, and the
 * decision here mirrors that (a newer major is a toast, not a download).
 */

import type {UpdateCheckResult} from '../providers/PlatformCapabilitiesProvider';
import {compareSemver, semverMajor} from './updateCheck';
import type {UpdateCadence} from './updatePreferences';

const HOUR_MS = 60 * 60 * 1000;

/** How often the host re-evaluates whether a check is due. Low-frequency on
 *  purpose: the tick is cheap (a couple of localStorage reads) and the real
 *  throttle is the cadence threshold, so 15min granularity is plenty. */
export const SCHEDULER_TICK_MS = 15 * 60 * 1000;

/** Base staleness thresholds per cadence (before jitter). */
export const CADENCE_BASE_MS: Record<Exclude<UpdateCadence, 'never'>, number> = {
  daily: 24 * HOUR_MS,
  weekly: 7 * 24 * HOUR_MS,
};

/** Jitter half-width as a fraction of the base threshold (±10%). */
export const CADENCE_JITTER_RATIO = 0.1;

/**
 * The effective staleness threshold for a cadence, or `null` for `never`.
 * `jitter` ∈ [0,1] spreads the threshold across ±{@link CADENCE_JITTER_RATIO}
 * of the base (0 → 90%, 0.5 → 100%, 1 → 110%), so on a release day the
 * installed base doesn't hit the update server on the same tick ("thundering
 * herd"). Out-of-range jitter is clamped.
 */
export function cadenceThresholdMs(cadence: UpdateCadence, jitter: number): number | null {
  if (cadence === 'never') return null;
  const base = CADENCE_BASE_MS[cadence];
  const clamped = Math.min(1, Math.max(0, jitter));
  const factor = 1 - CADENCE_JITTER_RATIO + 2 * CADENCE_JITTER_RATIO * clamped;
  return Math.round(base * factor);
}

export interface BackgroundCheckInput {
  cadence: UpdateCadence;
  /** The last check *attempt* (success or failure) — `updates.lastCheckAt`. */
  lastCheckAt: number | null;
  /** The current time (epoch ms). */
  now: number;
  /** Random draw ∈ [0,1) for this evaluation (the host passes `Math.random()`). */
  jitter: number;
}

/**
 * Should a background check run now?
 * - `never` → false, unconditionally (zero requests, even if never checked).
 * - never attempted (`lastCheckAt` null) → true.
 * - `lastCheckAt` in the future (clock set back / bad stamp) → treated as
 *   stale → true, so a skewed clock can't silence updates forever.
 * - otherwise → elapsed time exceeds the jittered cadence threshold.
 */
export function isBackgroundCheckDue(input: BackgroundCheckInput): boolean {
  const threshold = cadenceThresholdMs(input.cadence, input.jitter);
  if (threshold === null) return false;
  if (input.lastCheckAt === null) return true;
  if (input.lastCheckAt > input.now) return true;
  return input.now - input.lastCheckAt > threshold;
}

/** What the scheduler should do after a completed (non-error handled by the
 *  host) check. Both fields can be set at once: a same-major update installs
 *  while a newer major is announced. */
export interface UpdateAction {
  /** Download + stage the same-major update: `'security'` (persistent toast)
   *  or `'update'` (normal toast). `null` = don't install anything. */
  install: 'security' | 'update' | null;
  /** A newer major to announce informationally (e.g. `2`), or `null`. Never
   *  installed; announced at most once per major (see `announcedMajor`). */
  announceMajor: number | null;
}

export interface UpdateDecisionInput {
  /** The running app version (e.g. "1.69.1"). */
  currentVersion: string;
  /** The "security updates only" preference. */
  securityOnly: boolean;
  /** The highest major already announced on this device, or `null`. */
  announcedMajor: number | null;
}

const NO_ACTION: UpdateAction = {install: null, announceMajor: null};

/**
 * Map a completed check onto an action. Errors are the host's problem (it
 * stays silent); this only reads successful results — including `up-to-date`,
 * which can still carry a newer `latestMajor` to announce.
 *
 * Install rules:
 * - the installable candidate is `latestForCurrentMajor` (falling back to
 *   `latestVersion` only when it's on the current major), and it must compare
 *   strictly newer than the running version;
 * - security-only ON → install only when the check flags a security fix;
 * - security-only OFF → install any newer same-major (a security flag just
 *   upgrades the toast to persistent).
 * A security fix that only exists on a *newer major* is not installable here
 * (the pinned manifest never crosses majors) — it surfaces as the major
 * announcement instead.
 *
 * Announce rules: `latestMajor` strictly above the running major AND strictly
 * above the last announced major (so re-announcing an already-seen or older
 * major is impossible). Independent of security-only: it's informational —
 * nothing downloads — and it fires at most once per major ever.
 */
export function decideUpdateAction(result: UpdateCheckResult, input: UpdateDecisionInput): UpdateAction {
  if (result.status === 'error') return NO_ACTION;

  const currentMajor = semverMajor(input.currentVersion);

  let install: UpdateAction['install'] = null;
  if (result.status === 'update-available') {
    let candidate = result.latestForCurrentMajor;
    if (!candidate && result.latestVersion && semverMajor(result.latestVersion) === currentMajor) {
      candidate = result.latestVersion;
    }
    const newerSameMajor = candidate ? compareSemver(candidate, input.currentVersion) > 0 : false;
    const security = result.security?.updateAvailable === true;
    if (newerSameMajor && (security || !input.securityOnly)) {
      install = security ? 'security' : 'update';
    }
  }

  let announceMajor: number | null = null;
  const latestMajorNum = result.latestMajor ? semverMajor(result.latestMajor) : null;
  if (
    latestMajorNum !== null &&
    currentMajor !== null &&
    latestMajorNum > currentMajor &&
    latestMajorNum > (input.announcedMajor ?? Number.NEGATIVE_INFINITY)
  ) {
    announceMajor = latestMajorNum;
  }

  return install === null && announceMajor === null ? NO_ACTION : {install, announceMajor};
}

// ── Once-per-major announcement persistence ─────────────────────────────────

/** localStorage key recording the highest major already announced here. */
export const MAJOR_ANNOUNCED_KEY = 'updates.majorAnnounced';

/** The highest major announced on this device, or `null`. SSR/quota-safe. */
export function getAnnouncedMajor(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(MAJOR_ANNOUNCED_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Record that `major` has been announced (never announce it again). */
export function setAnnouncedMajor(major: number): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(MAJOR_ANNOUNCED_KEY, String(major));
  } catch {
    // ignore (private mode / quota) — worst case the major is announced again.
  }
}

// ── Last-seen newer major (the durable Settings surface) ─────────────────────
//
// The once-per-major toast is a ~7s signal; miss it and nothing in the app
// says a new major exists (the Updates section reads "Up to date" when the
// *current line* is current). So the shared runner records the `latestMajor`
// every successful check reports — manual or background — and the Updates
// section renders it as a persistent informational line between checks.

/** localStorage key holding the `latestMajor` version string from the most
 *  recent successful check (e.g. "2.3.0"); absent when none was reported. */
export const LATEST_MAJOR_SEEN_KEY = 'updates.latestMajorSeen';

/** The `latestMajor` the last successful check reported, or `null`. */
export function getLatestMajorSeen(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(LATEST_MAJOR_SEEN_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * Record the `latestMajor` of a successful check — pass `null` to clear when
 * the check reported none (e.g. after upgrading onto that major), so a stale
 * "2.x is available" can't outlive its truth. Errors never call this: a
 * failed check says nothing about majors.
 */
export function setLatestMajorSeen(latestMajor: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (latestMajor) localStorage.setItem(LATEST_MAJOR_SEEN_KEY, latestMajor);
    else localStorage.removeItem(LATEST_MAJOR_SEEN_KEY);
  } catch {
    // ignore (private mode / quota) — the line just won't persist.
  }
}
