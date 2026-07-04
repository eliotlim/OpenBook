/**
 * The single-flight update pipeline shared by the Settings "Check for updates"
 * button and the background scheduler. Module-singleton promises (one app, one
 * update platform) guarantee that however the two callers interleave, at most
 * one `checkForUpdate` and at most one `downloadAndInstall` is ever in flight —
 * a background tick landing mid-manual-check (or vice versa) just joins the
 * running call instead of doubling it.
 *
 * Timestamp stamping lives here, centrally, so both callers keep the
 * `updatePreferences` semantics intact: `lastCheckAt` on EVERY attempt
 * (success or failure — the scheduler's throttle, so a failing server can't
 * cause a retry storm), `lastCheckSuccessAt` only when the check completed
 * (what the Settings section shows as "Last checked").
 */

import type {UpdateCheckResult, UpdatesPlatform} from '../providers/PlatformLibraryProvider';
import {setUpdateLastCheckAt, setUpdateLastCheckSuccessAt} from './updatePreferences';

let checkInFlight: Promise<UpdateCheckResult> | null = null;
let installInFlight: Promise<void> | null = null;

/**
 * Run (or join) the update check. Never rejects — `checkForUpdate` promises
 * not to, and a broken implementation is normalized to `{status: 'error'}`.
 * Concurrent callers share one platform call and one timestamp stamp.
 */
export function runUpdateCheck(updates: UpdatesPlatform): Promise<UpdateCheckResult> {
  if (checkInFlight) return checkInFlight;
  checkInFlight = (async (): Promise<UpdateCheckResult> => {
    let result: UpdateCheckResult;
    try {
      result = await updates.checkForUpdate();
    } catch (e) {
      // The contract says checkForUpdate never rejects; belt-and-braces anyway.
      result = {status: 'error', error: e instanceof Error ? e.message : String(e)};
    }
    const now = Date.now();
    setUpdateLastCheckAt(now);
    if (result.status !== 'error') setUpdateLastCheckSuccessAt(now);
    return result;
  })().finally(() => {
    checkInFlight = null;
  });
  return checkInFlight;
}

/**
 * Run (or join) the download+stage step. Unlike the check, failures REJECT
 * (per the `downloadAndInstall` contract) — every joined caller sees the same
 * rejection and owns its own surface (the scheduler stays silent, Settings
 * could show an inline error). A later call after settle starts fresh.
 */
export function runDownloadAndInstall(updates: UpdatesPlatform): Promise<void> {
  if (!installInFlight) {
    installInFlight = updates.downloadAndInstall().finally(() => {
      installInFlight = null;
    });
  }
  return installInFlight;
}

/** Test-only: forget any in-flight promises (isolate unit tests). */
export function resetUpdateRunnerForTests(): void {
  checkInFlight = null;
  installInFlight = null;
}
