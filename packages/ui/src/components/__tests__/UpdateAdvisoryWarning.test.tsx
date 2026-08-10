import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import type {ReactNode} from 'react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {I18nProvider} from '../../providers/I18nProvider';
import {ConfirmProvider} from '../../providers/ConfirmProvider';
import type {UpdateAdvisory, UpdateCheckResult, UpdatesPlatform} from '../../providers/PlatformCapabilitiesProvider';
import {
  UPDATE_ADVISORY_SNOOZE_MS,
  UPDATE_PREFERENCE_KEYS,
  isUpdateAdvisoryDismissed,
  setLastSeenUpdateAdvisory,
  setUpdateAdvisorySnooze,
} from '../../lib/updatePreferences';
import {resetUpdateRunnerForTests, runUpdateCheck} from '../../lib/updateRunner';
import {UpdateAdvisoryHost, UpdateAdvisoryWarning} from '../UpdateAdvisoryWarning';

const ADVISORY: UpdateAdvisory = {
  id: 'cm4advisory01',
  severity: 'vulnerable',
  message: 'This version has a security flaw. Update now.',
  minSafeVersion: '1.72.3',
  affectedRange: '>=1.70.0 <1.72.3',
};

function makePlatform(result?: UpdateCheckResult): UpdatesPlatform & {
  check: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  relaunch: ReturnType<typeof vi.fn>;
} {
  const fallback: UpdateCheckResult = {status: 'update-available', advisory: ADVISORY};
  const check = vi.fn(async (): Promise<UpdateCheckResult> => result ?? fallback);
  const install = vi.fn(async () => true);
  const relaunch = vi.fn(async () => {});
  return {
    getAppVersion: async () => '1.71.0',
    checkForUpdate: check,
    downloadAndInstall: install,
    relaunch,
    check,
    install,
  };
}

function shell(children: ReactNode) {
  return render(
    <I18nProvider>
      <ConfirmProvider>{children}</ConfirmProvider>
    </I18nProvider>,
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  localStorage.clear();
  resetUpdateRunnerForTests();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('UpdateAdvisoryWarning', () => {
  it('is an accessible modal and renders hostile message text inert', async () => {
    const hostile = {
      ...ADVISORY,
      message: '<script>alert("owned")</script> https://danger.example',
    };
    shell(
      <UpdateAdvisoryWarning
        advisory={hostile}
        currentVersion="1.71.0"
        updates={makePlatform()}
        onSnooze={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    await flush();

    const dialog = screen.getByRole('alertdialog', {name: 'Security warning'});
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByLabelText('Acknowledgement').getAttribute('aria-describedby')).toMatch(/-hint$/);
    expect(screen.getByText(hostile.message)).toBeTruthy();
    expect(dialog.querySelector('script')).toBeNull();
    expect(dialog.querySelector('a')).toBeNull();
    expect(screen.queryByRole('button', {name: 'Close'})).toBeNull();
    expect(screen.getByText('1.71.0')).toBeTruthy();
    expect(screen.getByText('>=1.70.0 <1.72.3')).toBeTruthy();
    expect(screen.getByText('1.72.3')).toBeTruthy();
  });

  it('gates dismissal on the localized phrase, case-insensitive and trimmed', () => {
    const onDismiss = vi.fn();
    shell(
      <UpdateAdvisoryWarning
        advisory={ADVISORY}
        currentVersion="1.71.0"
        updates={makePlatform()}
        onSnooze={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    const input = screen.getByLabelText('Acknowledgement');
    const dismiss = screen.getByRole('button', {name: 'Dismiss'});
    expect((dismiss as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, {target: {value: 'understood'}});
    expect((dismiss as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, {target: {value: '  I UNDERSTAND  '}});
    expect((dismiss as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('runs the existing signed install and relaunch flow from Update now', async () => {
    const platform = makePlatform();
    shell(
      <UpdateAdvisoryWarning
        advisory={ADVISORY}
        currentVersion="1.71.0"
        updates={platform}
        onSnooze={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', {name: 'Update now'}));
    await flush();
    expect(platform.install).toHaveBeenCalledTimes(1);
    expect(platform.relaunch).toHaveBeenCalledTimes(1);
  });
});

describe('UpdateAdvisoryHost', () => {
  it('reopens a persisted snooze from a previous launch without another check', async () => {
    setLastSeenUpdateAdvisory(ADVISORY);
    setUpdateAdvisorySnooze(ADVISORY.id, Date.now(), 'previous-launch');
    const platform = makePlatform();
    shell(<UpdateAdvisoryHost updates={platform} />);
    await flush();

    expect(screen.getByRole('alertdialog', {name: 'Security warning'})).toBeTruthy();
    expect(platform.check).not.toHaveBeenCalled();
  });

  it('snoozes until 24 hours and then reopens without another check', async () => {
    vi.useFakeTimers({now: new Date('2026-08-10T00:00:00Z')});
    const platform = makePlatform();
    shell(<UpdateAdvisoryHost updates={platform} />);
    await act(async () => {
      await runUpdateCheck(platform);
    });
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', {name: 'Snooze'}));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_ADVISORY_SNOOZE_MS - 1);
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(platform.check).toHaveBeenCalledTimes(1);
  });

  it('persists dismissal per id and re-fires for a new advisory id', async () => {
    const platform = makePlatform();
    shell(<UpdateAdvisoryHost updates={platform} />);
    await act(async () => {
      await runUpdateCheck(platform);
    });

    fireEvent.change(screen.getByLabelText('Acknowledgement'), {target: {value: 'i understand'}});
    fireEvent.click(screen.getByRole('button', {name: 'Dismiss'}));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(isUpdateAdvisoryDismissed(ADVISORY.id)).toBe(true);
    expect(localStorage.getItem(UPDATE_PREFERENCE_KEYS.dismissedAdvisoryIds)).toContain(ADVISORY.id);

    await act(async () => {
      await runUpdateCheck(platform);
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();

    platform.check.mockResolvedValueOnce({
      status: 'update-available',
      advisory: {...ADVISORY, id: 'cm4advisory02', severity: 'major-bug'},
    });
    await act(async () => {
      await runUpdateCheck(platform);
    });
    expect(screen.getByRole('alertdialog', {name: 'Critical update warning'})).toBeTruthy();
  });
});
