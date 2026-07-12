/**
 * The JS-driven update *check* against the account service (OB-342). This is
 * the informational half of the update story — "is there something newer, and
 * is it a security fix?" — consumed by the Settings Updates section and the
 * background scheduler. The *install* half never goes through here: downloads
 * are performed by the Tauri updater plugin against the manifest endpoint +
 * pubkey pinned in `tauri.conf.json` (see `UpdatesPlatform.downloadAndInstall`).
 *
 * Contract (account epic OB-338, v1):
 *   GET {account}/api/updates/check?version=<semver>&target=<darwin|linux|windows>&arch=<aarch64|x86_64>
 *   → { latestVersion, latestMajor, latestForCurrentMajor,
 *       security: { updateAvailable: boolean, fixedIn: string|null } }
 *
 * The base URL honors the same `resolveAccountUrl()` localStorage override the
 * rest of the account client uses (dev / self-host), unlike the Tauri-config
 * manifest endpoint which stays the pinned prod constant.
 *
 * `checkForUpdateViaAccount` NEVER rejects: transport failures, non-OK
 * statuses, malformed JSON and unrecognized shapes all resolve as
 * `{status: 'error'}` so callers can render a calm inline error.
 */

import {resolveAccountUrl} from '@book.dev/sdk';
import type {UpdateCheckResult, UpdateSecurityInfo} from '../providers/PlatformCapabilitiesProvider';

/** What the caller knows about the running build. */
export interface UpdateCheckParams {
  /** The running app version, e.g. "1.69.1". */
  version: string;
  /** OS family in the check API's vocabulary: `darwin` | `linux` | `windows`. */
  target: string;
  /** CPU architecture: `aarch64` | `x86_64`. */
  arch: string;
}

export interface UpdateCheckOptions {
  /** Injectable fetch (tests / non-window hosts). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Override the account base URL. Defaults to `resolveAccountUrl()` (which
   *  itself honors the `openbook.accountUrl` localStorage override). */
  baseUrl?: string;
}

const parseSemver = (v: string): [number, number, number] | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/**
 * Compare two `x.y.z` versions (-1 / 0 / 1). Pre-release/build suffixes are
 * ignored (releases here are plain nx-release triples). Unparseable input
 * compares equal — the check must never invent a phantom update out of
 * garbage, and "no update" is the safe reading of a version we can't order.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** The major component of an `x.y.z` version, or `null` when unparseable. */
export function semverMajor(v: string): number | null {
  const p = parseSemver(v);
  return p ? p[0] : null;
}

const asVersionString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/**
 * Map the check endpoint's response body onto {@link UpdateCheckResult}.
 * Availability is decided by comparing the current version against
 * `latestForCurrentMajor` (falling back to `latestVersion`): updates never
 * cross a major automatically, so a newer major alone is *not*
 * "update-available" — it rides along in `latestMajor` for an explicit user
 * action. A body without any recognizable version field maps to an error.
 */
export function mapUpdateCheckResponse(currentVersion: string, body: unknown): UpdateCheckResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {status: 'error', error: 'update check returned an unrecognized response'};
  }
  const r = body as Record<string, unknown>;
  const latestVersion = asVersionString(r.latestVersion);
  const latestMajor = asVersionString(r.latestMajor);
  const latestForCurrentMajor = asVersionString(r.latestForCurrentMajor);
  if (!latestVersion && !latestForCurrentMajor) {
    return {status: 'error', error: 'update check returned an unrecognized response'};
  }

  let security: UpdateSecurityInfo | undefined;
  if (typeof r.security === 'object' && r.security !== null) {
    const s = r.security as Record<string, unknown>;
    // `fixedIn` arrives as string|null on the wire; null normalizes to absent.
    security = {updateAvailable: s.updateAvailable === true, fixedIn: asVersionString(s.fixedIn)};
  }

  const candidate = latestForCurrentMajor ?? latestVersion!;
  const available = compareSemver(candidate, currentVersion) > 0;
  return {
    status: available ? 'update-available' : 'up-to-date',
    latestVersion,
    latestMajor,
    latestForCurrentMajor,
    security,
  };
}

/**
 * Ask the account service whether a newer build exists. Never rejects — see
 * the module doc. The desktop platform layer supplies `params` from the Tauri
 * runtime (`getVersion()` + the compile-time build target).
 */
export async function checkForUpdateViaAccount(
  params: UpdateCheckParams,
  opts: UpdateCheckOptions = {},
): Promise<UpdateCheckResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl ?? resolveAccountUrl();
  const url =
    `${base}/api/updates/check` +
    `?version=${encodeURIComponent(params.version)}` +
    `&target=${encodeURIComponent(params.target)}` +
    `&arch=${encodeURIComponent(params.arch)}`;
  try {
    const res = await fetchImpl(url, {headers: {accept: 'application/json'}});
    if (!res.ok) return {status: 'error', error: `update check failed (HTTP ${res.status})`};
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return {status: 'error', error: 'update check returned malformed JSON'};
    }
    return mapUpdateCheckResponse(params.version, body);
  } catch (e) {
    return {status: 'error', error: e instanceof Error ? e.message : String(e)};
  }
}
