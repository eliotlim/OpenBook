import {beforeEach, describe, expect, it} from 'vitest';
import {
  DEFAULT_UPDATE_PREFERENCES,
  UPDATE_PREFERENCE_KEYS,
  getUpdateCadence,
  getDismissedUpdateAdvisoryIds,
  getUpdateLastCheckAt,
  getUpdateLastCheckSuccessAt,
  getUpdateSecurityOnly,
  getUpdateAdvisorySnooze,
  isUpdateAdvisoryDismissed,
  isUpdateAdvisorySnoozed,
  readUpdatePreferences,
  dismissUpdateAdvisory,
  setUpdateCadence,
  setUpdateAdvisorySnooze,
  setUpdateLastCheckAt,
  setUpdateLastCheckSuccessAt,
  setUpdateSecurityOnly,
} from '../updatePreferences';

describe('update preferences accessor', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to daily / not-security-only / never-checked', () => {
    expect(readUpdatePreferences()).toEqual(DEFAULT_UPDATE_PREFERENCES);
    expect(DEFAULT_UPDATE_PREFERENCES.cadence).toBe('daily');
  });

  it('round-trips cadence through its own key', () => {
    setUpdateCadence('weekly');
    expect(localStorage.getItem(UPDATE_PREFERENCE_KEYS.cadence)).toBe('weekly');
    expect(getUpdateCadence()).toBe('weekly');
    setUpdateCadence('never');
    expect(getUpdateCadence()).toBe('never');
  });

  it('falls back to daily for a missing or invalid cadence value', () => {
    expect(getUpdateCadence()).toBe('daily');
    localStorage.setItem(UPDATE_PREFERENCE_KEYS.cadence, 'hourly');
    expect(getUpdateCadence()).toBe('daily');
  });

  it('round-trips the security-only flag', () => {
    expect(getUpdateSecurityOnly()).toBe(false);
    setUpdateSecurityOnly(true);
    expect(localStorage.getItem(UPDATE_PREFERENCE_KEYS.securityOnly)).toBe('true');
    expect(getUpdateSecurityOnly()).toBe(true);
    setUpdateSecurityOnly(false);
    expect(getUpdateSecurityOnly()).toBe(false);
  });

  it('round-trips the last-check timestamp and rejects garbage', () => {
    expect(getUpdateLastCheckAt()).toBeNull();
    const now = Date.now();
    setUpdateLastCheckAt(now);
    expect(getUpdateLastCheckAt()).toBe(now);
    localStorage.setItem(UPDATE_PREFERENCE_KEYS.lastCheckAt, 'not-a-number');
    expect(getUpdateLastCheckAt()).toBeNull();
  });

  it('keeps the attempt and success timestamps independent (failed check must not refresh "Last checked")', () => {
    expect(getUpdateLastCheckSuccessAt()).toBeNull();
    const succeeded = Date.now() - 60_000;
    setUpdateLastCheckAt(succeeded);
    setUpdateLastCheckSuccessAt(succeeded);
    // A later FAILED attempt stamps only the attempt key…
    const failed = Date.now();
    setUpdateLastCheckAt(failed);
    // …so the scheduler sees the fresh attempt, but the UI's success time is unmoved.
    expect(getUpdateLastCheckAt()).toBe(failed);
    expect(getUpdateLastCheckSuccessAt()).toBe(succeeded);
  });

  it('reads all fields at once', () => {
    setUpdateCadence('weekly');
    setUpdateSecurityOnly(true);
    setUpdateLastCheckAt(1234);
    setUpdateLastCheckSuccessAt(1200);
    setUpdateAdvisorySnooze('advisory-a', 1100, 'launch-a');
    dismissUpdateAdvisory('advisory-old');
    expect(readUpdatePreferences()).toEqual({
      cadence: 'weekly',
      securityOnly: true,
      lastCheckAt: 1234,
      lastCheckSuccessAt: 1200,
      advisorySnooze: {advisoryId: 'advisory-a', snoozedAt: 1100, launchId: 'launch-a'},
      dismissedAdvisoryIds: ['advisory-old'],
    });
  });

  it('snoozes only the same advisory for 24 hours in the current launch', () => {
    const now = new Date('2026-08-10T00:00:00Z').getTime();
    setUpdateAdvisorySnooze('advisory-a', now, 'launch-a');

    expect(isUpdateAdvisorySnoozed('advisory-a', now + 1, 'launch-a')).toBe(true);
    expect(isUpdateAdvisorySnoozed('advisory-b', now + 1, 'launch-a')).toBe(false);
    expect(isUpdateAdvisorySnoozed('advisory-a', now + 1, 'launch-b')).toBe(false);
    expect(isUpdateAdvisorySnoozed('advisory-a', now + 24 * 60 * 60 * 1000, 'launch-a')).toBe(false);
  });

  it('persists dismissal per id and a new id is not dismissed', () => {
    dismissUpdateAdvisory('advisory-a');
    dismissUpdateAdvisory('advisory-a');

    expect(getDismissedUpdateAdvisoryIds()).toEqual(['advisory-a']);
    expect(isUpdateAdvisoryDismissed('advisory-a')).toBe(true);
    expect(isUpdateAdvisoryDismissed('advisory-b')).toBe(false);
  });

  it('rejects corrupt persisted advisory state', () => {
    localStorage.setItem(UPDATE_PREFERENCE_KEYS.advisorySnooze, '{bad json');
    localStorage.setItem(UPDATE_PREFERENCE_KEYS.dismissedAdvisoryIds, JSON.stringify([null, '', 42]));
    expect(getUpdateAdvisorySnooze()).toBeNull();
    expect(getDismissedUpdateAdvisoryIds()).toEqual([]);
  });
});
