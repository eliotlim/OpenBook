import {beforeEach, describe, expect, it} from 'vitest';
import {
  DEFAULT_UPDATE_PREFERENCES,
  UPDATE_PREFERENCE_KEYS,
  getUpdateCadence,
  getUpdateLastCheckAt,
  getUpdateLastCheckSuccessAt,
  getUpdateSecurityOnly,
  readUpdatePreferences,
  setUpdateCadence,
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
    expect(readUpdatePreferences()).toEqual({
      cadence: 'weekly',
      securityOnly: true,
      lastCheckAt: 1234,
      lastCheckSuccessAt: 1200,
    });
  });
});
