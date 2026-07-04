import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {UpdateCheckResult, UpdatesPlatform} from '../../providers/PlatformLibraryProvider';
import {UPDATE_PREFERENCE_KEYS} from '../updatePreferences';
import {LATEST_MAJOR_SEEN_KEY} from '../updateScheduler';
import {resetUpdateRunnerForTests, runDownloadAndInstall, runUpdateCheck} from '../updateRunner';

const OK: UpdateCheckResult = {status: 'up-to-date', latestVersion: '1.69.1'};
const ERR: UpdateCheckResult = {status: 'error', error: 'boom'};

/** A controllable platform: each method resolves when the test says so. */
function makePlatform(overrides: Partial<UpdatesPlatform> = {}): UpdatesPlatform {
  return {
    getAppVersion: async () => '1.69.1',
    checkForUpdate: async () => OK,
    downloadAndInstall: async () => {},
    relaunch: async () => {},
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetUpdateRunnerForTests();
});

describe('runUpdateCheck', () => {
  it('single-flights: concurrent callers share one platform call and one result', async () => {
    let release!: (r: UpdateCheckResult) => void;
    const gate = new Promise<UpdateCheckResult>((resolve) => (release = resolve));
    const check = vi.fn(() => gate);
    const platform = makePlatform({checkForUpdate: check});

    const a = runUpdateCheck(platform);
    const b = runUpdateCheck(platform);
    release(OK);
    const [ra, rb] = await Promise.all([a, b]);
    expect(check).toHaveBeenCalledTimes(1);
    expect(ra).toBe(rb);
    expect(ra).toBe(OK);
  });

  it('runs a fresh check after the previous one settled', async () => {
    const check = vi.fn(async () => OK);
    const platform = makePlatform({checkForUpdate: check});
    await runUpdateCheck(platform);
    await runUpdateCheck(platform);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('stamps the attempt AND the success timestamp on a completed check', async () => {
    await runUpdateCheck(makePlatform());
    expect(localStorage.getItem(UPDATE_PREFERENCE_KEYS.lastCheckAt)).not.toBeNull();
    expect(localStorage.getItem(UPDATE_PREFERENCE_KEYS.lastCheckSuccessAt)).not.toBeNull();
  });

  it('stamps only the attempt timestamp on a failed check', async () => {
    const result = await runUpdateCheck(makePlatform({checkForUpdate: async () => ERR}));
    expect(result).toBe(ERR);
    expect(localStorage.getItem(UPDATE_PREFERENCE_KEYS.lastCheckAt)).not.toBeNull();
    expect(localStorage.getItem(UPDATE_PREFERENCE_KEYS.lastCheckSuccessAt)).toBeNull();
  });

  it('records latestMajor from a successful check (the durable Settings surface)', async () => {
    const withMajor: UpdateCheckResult = {...OK, latestMajor: '2.3.0'};
    await runUpdateCheck(makePlatform({checkForUpdate: async () => withMajor}));
    expect(localStorage.getItem(LATEST_MAJOR_SEEN_KEY)).toBe('2.3.0');
  });

  it('clears the recorded major when a successful check reports none', async () => {
    localStorage.setItem(LATEST_MAJOR_SEEN_KEY, '2.3.0');
    await runUpdateCheck(makePlatform()); // OK carries no latestMajor
    expect(localStorage.getItem(LATEST_MAJOR_SEEN_KEY)).toBeNull();
  });

  it('leaves the recorded major untouched on a failed check', async () => {
    localStorage.setItem(LATEST_MAJOR_SEEN_KEY, '2.3.0');
    await runUpdateCheck(makePlatform({checkForUpdate: async () => ERR}));
    // A failed check says nothing about majors — the stale-but-true record stays.
    expect(localStorage.getItem(LATEST_MAJOR_SEEN_KEY)).toBe('2.3.0');
  });

  it('never rejects, even against a contract-breaking platform', async () => {
    const result = await runUpdateCheck(
      makePlatform({
        checkForUpdate: async () => {
          throw new Error('broken impl');
        },
      }),
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('broken impl');
    // Still an attempt: the throttle stamp must land so retries stay bounded.
    expect(localStorage.getItem(UPDATE_PREFERENCE_KEYS.lastCheckAt)).not.toBeNull();
    expect(localStorage.getItem(UPDATE_PREFERENCE_KEYS.lastCheckSuccessAt)).toBeNull();
  });
});

describe('runDownloadAndInstall', () => {
  it('single-flights: concurrent callers share one download', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const install = vi.fn(() => gate);
    const platform = makePlatform({downloadAndInstall: install});

    const a = runDownloadAndInstall(platform);
    const b = runDownloadAndInstall(platform);
    release();
    await Promise.all([a, b]);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('propagates a rejection to every joined caller, then allows a fresh run', async () => {
    const install = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('signature'))
      .mockResolvedValueOnce(undefined);
    const platform = makePlatform({downloadAndInstall: install});

    const a = runDownloadAndInstall(platform);
    const b = runDownloadAndInstall(platform);
    await expect(a).rejects.toThrow('signature');
    await expect(b).rejects.toThrow('signature');
    // After the failure settles, the next call starts a new download.
    await expect(runDownloadAndInstall(platform)).resolves.toBeUndefined();
    expect(install).toHaveBeenCalledTimes(2);
  });
});
