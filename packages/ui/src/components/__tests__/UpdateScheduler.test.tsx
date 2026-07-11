import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {render, cleanup, act} from '@testing-library/react';
import type {UpdateCheckResult, UpdatesPlatform, PlatformLibrary} from '../../providers/PlatformLibraryProvider';
import {PlatformLibraryProvider} from '../../providers/PlatformLibraryProvider';
import {ConfirmProvider} from '../../providers/ConfirmProvider';
import {UPDATE_PREFERENCE_KEYS} from '../../lib/updatePreferences';
import {LATEST_MAJOR_SEEN_KEY, MAJOR_ANNOUNCED_KEY} from '../../lib/updateScheduler';
import {resetUpdateRunnerForTests} from '../../lib/updateRunner';
import UpdateScheduler from '../UpdateScheduler';
import {showToast} from '../ui/toast';

// The scheduler's observable output is toasts; mock the singleton so tests
// assert calls instead of DOM (ToastHost isn't mounted here).
vi.mock('@/components/ui/toast', () => ({showToast: vi.fn(() => 1)}));

const showToastMock = vi.mocked(showToast);

const SECURITY_UPDATE: UpdateCheckResult = {
  status: 'update-available',
  latestVersion: '1.72.0',
  latestForCurrentMajor: '1.72.0',
  security: {updateAvailable: true, fixedIn: '1.72.0'},
};
const PLAIN_UPDATE: UpdateCheckResult = {
  status: 'update-available',
  latestVersion: '1.72.0',
  latestForCurrentMajor: '1.72.0',
};
const NEW_MAJOR: UpdateCheckResult = {
  status: 'up-to-date',
  latestVersion: '1.69.1',
  latestForCurrentMajor: '1.69.1',
  latestMajor: '2.3.0',
};

function makePlatform(result: UpdateCheckResult): UpdatesPlatform & {
  check: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  relaunched: ReturnType<typeof vi.fn>;
} {
  const check = vi.fn(async () => result);
  const install = vi.fn(async () => true);
  const relaunched = vi.fn(async () => {});
  return {
    getAppVersion: async () => '1.69.1',
    checkForUpdate: check,
    downloadAndInstall: install,
    relaunch: relaunched,
    check,
    install,
    relaunched,
  };
}

function mount(updates: UpdatesPlatform | undefined) {
  const platform: PlatformLibrary = updates ? {updates} : {};
  return render(
    <PlatformLibraryProvider value={platform}>
      <ConfirmProvider>
        <UpdateScheduler />
      </ConfirmProvider>
    </PlatformLibraryProvider>,
  );
}

/** Let the launch tick's multi-await promise chain drain (check → version →
 *  install → toast). Microtask turns only, so it also works under fake timers. */
const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
};

beforeEach(() => {
  localStorage.clear();
  resetUpdateRunnerForTests();
  showToastMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('UpdateScheduler host', () => {
  it('runs a launch check when never attempted and installs + toasts a plain update', async () => {
    const platform = makePlatform(PLAIN_UPDATE);
    mount(platform);
    await flush();
    expect(platform.check).toHaveBeenCalledTimes(1);
    expect(platform.install).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalledTimes(1);
    const toast = showToastMock.mock.calls[0][0];
    expect(toast.message).toBe('Update ready');
    expect(toast.actionLabel).toBe('Restart to update');
    // Routine updates auto-dismiss (default duration).
    expect(toast.durationMs).toBeUndefined();
  });

  it('security update → persistent toast whose action relaunches', async () => {
    const platform = makePlatform(SECURITY_UPDATE);
    mount(platform);
    await flush();
    expect(platform.install).toHaveBeenCalledTimes(1);
    const toast = showToastMock.mock.calls[0][0];
    expect(toast.message).toBe('Security update ready');
    expect(toast.durationMs).toBe(Number.POSITIVE_INFINITY);
    // No save pending → the action relaunches without a confirm dialog.
    await act(async () => {
      toast.onAction?.();
    });
    await flush();
    expect(platform.relaunched).toHaveBeenCalledTimes(1);
  });

  it('security-only ON: a non-security update is checked but NOT acted on', async () => {
    localStorage.setItem(UPDATE_PREFERENCE_KEYS.securityOnly, 'true');
    const platform = makePlatform(PLAIN_UPDATE);
    mount(platform);
    await flush();
    expect(platform.check).toHaveBeenCalledTimes(1); // the check itself still runs
    expect(platform.install).not.toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('security-only ON: a security update still installs with a persistent toast', async () => {
    localStorage.setItem(UPDATE_PREFERENCE_KEYS.securityOnly, 'true');
    const platform = makePlatform(SECURITY_UPDATE);
    mount(platform);
    await flush();
    expect(platform.install).toHaveBeenCalledTimes(1);
    expect(showToastMock.mock.calls[0][0].durationMs).toBe(Number.POSITIVE_INFINITY);
  });

  it('cadence never → zero checkForUpdate calls, ever', async () => {
    localStorage.setItem(UPDATE_PREFERENCE_KEYS.cadence, 'never');
    vi.useFakeTimers();
    const platform = makePlatform(SECURITY_UPDATE);
    mount(platform);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000); // 8 ticks
    });
    expect(platform.check).not.toHaveBeenCalled();
    expect(platform.install).not.toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('a fresh lastCheckAt throttles the launch tick (no check yet)', async () => {
    localStorage.setItem(UPDATE_PREFERENCE_KEYS.lastCheckAt, String(Date.now() - 60 * 1000));
    const platform = makePlatform(PLAIN_UPDATE);
    mount(platform);
    await flush();
    expect(platform.check).not.toHaveBeenCalled();
  });

  it('a new major is announced once — and never again on later checks', async () => {
    const platform = makePlatform(NEW_MAJOR);
    mount(platform);
    await flush();
    expect(platform.install).not.toHaveBeenCalled(); // majors never auto-install
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(showToastMock.mock.calls[0][0].message).toBe('OpenBook 2.x is available');
    expect(localStorage.getItem(MAJOR_ANNOUNCED_KEY)).toBe('2');
    // The shared runner also recorded the major durably — the Updates section
    // reads this to show "2.x is available" for anyone who missed the toast.
    expect(localStorage.getItem(LATEST_MAJOR_SEEN_KEY)).toBe('2.3.0');

    // A later stale-again check sees the same major: no second announcement.
    cleanup();
    resetUpdateRunnerForTests();
    localStorage.removeItem(UPDATE_PREFERENCE_KEYS.lastCheckAt);
    showToastMock.mockClear();
    mount(platform);
    await flush();
    expect(platform.check).toHaveBeenCalledTimes(2);
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('a background check error is silent (no toast), attempt stamped', async () => {
    const platform = makePlatform({status: 'error', error: 'offline'});
    mount(platform);
    await flush();
    expect(platform.check).toHaveBeenCalledTimes(1);
    expect(showToastMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(UPDATE_PREFERENCE_KEYS.lastCheckAt)).not.toBeNull();
  });

  it('a failed download is silent — no "ready" toast', async () => {
    const platform = makePlatform(PLAIN_UPDATE);
    platform.install.mockRejectedValueOnce(new Error('signature'));
    mount(platform);
    await flush();
    expect(platform.install).toHaveBeenCalledTimes(1);
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('a no-op download (204 → nothing staged) shows no "ready" toast', async () => {
    const platform = makePlatform(PLAIN_UPDATE);
    // The informational check found an update, but the signed manifest staged
    // nothing (already current for this platform) → false. No restart to offer.
    platform.install.mockResolvedValueOnce(false);
    mount(platform);
    await flush();
    expect(platform.install).toHaveBeenCalledTimes(1);
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('does nothing without the updates capability', async () => {
    mount(undefined);
    await flush();
    expect(showToastMock).not.toHaveBeenCalled();
  });
});
