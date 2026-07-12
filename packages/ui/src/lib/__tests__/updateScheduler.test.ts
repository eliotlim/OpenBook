import {describe, it, expect, beforeEach} from 'vitest';
import type {UpdateCheckResult} from '../../providers/PlatformCapabilitiesProvider';
import type {UpdateCadence} from '../updatePreferences';
import {
  CADENCE_BASE_MS,
  LATEST_MAJOR_SEEN_KEY,
  MAJOR_ANNOUNCED_KEY,
  cadenceThresholdMs,
  decideUpdateAction,
  getAnnouncedMajor,
  getLatestMajorSeen,
  isBackgroundCheckDue,
  setAnnouncedMajor,
  setLatestMajorSeen,
  type UpdateAction,
} from '../updateScheduler';

const CURRENT = '1.69.1';

// ── Check outcomes, one per matrix column ────────────────────────────────────

const OUTCOMES: Record<string, UpdateCheckResult> = {
  // Nothing newer anywhere.
  noUpdate: {status: 'up-to-date', latestVersion: '1.69.1', latestForCurrentMajor: '1.69.1'},
  // A routine same-major update.
  minor: {status: 'update-available', latestVersion: '1.72.0', latestForCurrentMajor: '1.72.0'},
  // A same-major security fix.
  security: {
    status: 'update-available',
    latestVersion: '1.72.0',
    latestForCurrentMajor: '1.72.0',
    security: {updateAvailable: true, fixedIn: '1.72.0'},
  },
  // A newer major with the current line already up to date. Note the status:
  // `mapUpdateCheckResponse` compares against latestForCurrentMajor, so a
  // major-only bump arrives as `up-to-date` + latestMajor.
  newMajor: {status: 'up-to-date', latestVersion: '1.69.1', latestForCurrentMajor: '1.69.1', latestMajor: '2.3.0'},
  // The check failed.
  error: {status: 'error', error: 'boom'},
};

type OutcomeName = keyof typeof OUTCOMES;

/** What the scheduler ends up doing on a tick: mirrors the host's composition
 *  of isBackgroundCheckDue → (run check) → decideUpdateAction. */
type Effect = 'no-op' | 'install-update' | 'install-security' | 'announce-major';

function effectsOfTick(cadence: UpdateCadence, securityOnly: boolean, outcome: OutcomeName): Effect[] {
  // A well-stale attempt timestamp so daily/weekly are always due; `never`
  // must win regardless.
  const due = isBackgroundCheckDue({
    cadence,
    lastCheckAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
    now: Date.now(),
    jitter: 0.5,
  });
  if (!due) return ['no-op'];
  const result = OUTCOMES[outcome];
  if (result.status === 'error') return ['no-op']; // the host returns silently
  const action = decideUpdateAction(result, {currentVersion: CURRENT, securityOnly, announcedMajor: null});
  const effects: Effect[] = [];
  if (action.announceMajor !== null) effects.push('announce-major');
  if (action.install === 'update') effects.push('install-update');
  if (action.install === 'security') effects.push('install-security');
  return effects.length ? effects : ['no-op'];
}

describe('decision matrix: cadence × security-only × outcome', () => {
  // Every cell, exactly. `never` = no check at all, so every outcome is a
  // no-op (and in the host no request is even made — covered by the e2e).
  const TABLE: Array<[UpdateCadence, boolean, OutcomeName, Effect[]]> = [
    // cadence   securityOnly  outcome      expected effects
    ['daily', false, 'noUpdate', ['no-op']],
    ['daily', false, 'minor', ['install-update']],
    ['daily', false, 'security', ['install-security']],
    ['daily', false, 'newMajor', ['announce-major']],
    ['daily', false, 'error', ['no-op']],
    ['daily', true, 'noUpdate', ['no-op']],
    ['daily', true, 'minor', ['no-op']],
    ['daily', true, 'security', ['install-security']],
    ['daily', true, 'newMajor', ['announce-major']],
    ['daily', true, 'error', ['no-op']],
    ['weekly', false, 'noUpdate', ['no-op']],
    ['weekly', false, 'minor', ['install-update']],
    ['weekly', false, 'security', ['install-security']],
    ['weekly', false, 'newMajor', ['announce-major']],
    ['weekly', false, 'error', ['no-op']],
    ['weekly', true, 'noUpdate', ['no-op']],
    ['weekly', true, 'minor', ['no-op']],
    ['weekly', true, 'security', ['install-security']],
    ['weekly', true, 'newMajor', ['announce-major']],
    ['weekly', true, 'error', ['no-op']],
    ['never', false, 'noUpdate', ['no-op']],
    ['never', false, 'minor', ['no-op']],
    ['never', false, 'security', ['no-op']],
    ['never', false, 'newMajor', ['no-op']],
    ['never', false, 'error', ['no-op']],
    ['never', true, 'noUpdate', ['no-op']],
    ['never', true, 'minor', ['no-op']],
    ['never', true, 'security', ['no-op']],
    ['never', true, 'newMajor', ['no-op']],
    ['never', true, 'error', ['no-op']],
  ];

  it.each(TABLE)('%s / securityOnly=%s / %s → %j', (cadence, securityOnly, outcome, expected) => {
    expect(effectsOfTick(cadence, securityOnly, outcome)).toEqual(expected);
  });
});

describe('decideUpdateAction edge cases', () => {
  const decide = (result: UpdateCheckResult, securityOnly = false, announcedMajor: number | null = null): UpdateAction =>
    decideUpdateAction(result, {currentVersion: CURRENT, securityOnly, announcedMajor});

  it('installs AND announces when a same-major update and a newer major coexist', () => {
    const both: UpdateCheckResult = {
      status: 'update-available',
      latestVersion: '1.72.0',
      latestForCurrentMajor: '1.72.0',
      latestMajor: '2.3.0',
    };
    expect(decide(both)).toEqual({install: 'update', announceMajor: 2});
  });

  it('never re-announces an already-announced major, and never a lower one', () => {
    const major3: UpdateCheckResult = {...OUTCOMES.newMajor, latestMajor: '3.0.0'};
    expect(decide(OUTCOMES.newMajor, false, 2)).toEqual({install: null, announceMajor: null});
    expect(decide(OUTCOMES.newMajor, false, 3)).toEqual({install: null, announceMajor: null});
    // A genuinely newer major than the last announced one is announced again.
    expect(decide(major3, false, 2)).toEqual({install: null, announceMajor: 3});
  });

  it('announces the major even under security-only (informational, no download)', () => {
    expect(decide(OUTCOMES.newMajor, true)).toEqual({install: null, announceMajor: 2});
  });

  it('a security fix only on a newer major is not installable — announce only', () => {
    // The pinned manifest never crosses majors, so there is nothing to stage.
    const crossMajorFix: UpdateCheckResult = {
      status: 'update-available',
      latestVersion: '2.0.0',
      latestMajor: '2.0.0',
      security: {updateAvailable: true, fixedIn: '2.0.0'},
    };
    expect(decide(crossMajorFix, true)).toEqual({install: null, announceMajor: 2});
  });

  it('falls back to latestVersion only when it stays on the current major', () => {
    const sameMajorViaLatest: UpdateCheckResult = {status: 'update-available', latestVersion: '1.72.0'};
    expect(decide(sameMajorViaLatest)).toEqual({install: 'update', announceMajor: null});
    const crossMajorLatest: UpdateCheckResult = {status: 'update-available', latestVersion: '2.0.0'};
    expect(decide(crossMajorLatest).install).toBeNull();
  });

  it('does not install when the candidate is not strictly newer', () => {
    const stale: UpdateCheckResult = {status: 'update-available', latestForCurrentMajor: '1.69.1'};
    expect(decide(stale)).toEqual({install: null, announceMajor: null});
    const older: UpdateCheckResult = {status: 'update-available', latestForCurrentMajor: '1.60.0'};
    expect(decide(older)).toEqual({install: null, announceMajor: null});
  });

  it('unparseable versions decide nothing (no phantom installs or announces)', () => {
    const garbage: UpdateCheckResult = {status: 'update-available', latestForCurrentMajor: 'garbage', latestMajor: 'nope'};
    expect(decide(garbage)).toEqual({install: null, announceMajor: null});
  });
});

describe('staleness math', () => {
  const NOW = 1_800_000_000_000;
  const due = (cadence: UpdateCadence, lastCheckAt: number | null, jitter = 0.5, now = NOW): boolean =>
    isBackgroundCheckDue({cadence, lastCheckAt, now, jitter});

  it('daily: due strictly beyond 24h (at mid jitter), not before', () => {
    expect(due('daily', NOW - 23 * 60 * 60 * 1000)).toBe(false);
    expect(due('daily', NOW - CADENCE_BASE_MS.daily)).toBe(false); // exactly at threshold: not yet
    expect(due('daily', NOW - 25 * 60 * 60 * 1000)).toBe(true);
  });

  it('weekly: due strictly beyond 7d (at mid jitter), not before', () => {
    expect(due('weekly', NOW - 6 * 24 * 60 * 60 * 1000)).toBe(false);
    expect(due('weekly', NOW - 8 * 24 * 60 * 60 * 1000)).toBe(true);
  });

  it('never: not due, even when never attempted', () => {
    expect(due('never', null)).toBe(false);
    expect(due('never', NOW - 365 * 24 * 60 * 60 * 1000)).toBe(false);
  });

  it('never attempted (null) → due immediately', () => {
    expect(due('daily', null)).toBe(true);
    expect(due('weekly', null)).toBe(true);
  });

  it('clock skew: a future lastCheckAt is treated as stale → due', () => {
    expect(due('daily', NOW + 60 * 60 * 1000)).toBe(true);
    expect(due('weekly', NOW + 1)).toBe(true);
  });

  it('jitter spans exactly ±10% of the base threshold', () => {
    expect(cadenceThresholdMs('daily', 0)).toBe(Math.round(CADENCE_BASE_MS.daily * 0.9));
    expect(cadenceThresholdMs('daily', 0.5)).toBe(CADENCE_BASE_MS.daily);
    expect(cadenceThresholdMs('daily', 1)).toBe(Math.round(CADENCE_BASE_MS.daily * 1.1));
    expect(cadenceThresholdMs('weekly', 0)).toBe(Math.round(CADENCE_BASE_MS.weekly * 0.9));
    expect(cadenceThresholdMs('weekly', 1)).toBe(Math.round(CADENCE_BASE_MS.weekly * 1.1));
    // Out-of-range draws are clamped, never widening the band.
    expect(cadenceThresholdMs('daily', -3)).toBe(Math.round(CADENCE_BASE_MS.daily * 0.9));
    expect(cadenceThresholdMs('daily', 7)).toBe(Math.round(CADENCE_BASE_MS.daily * 1.1));
    expect(cadenceThresholdMs('never', 0.5)).toBeNull();
  });

  it('jitter changes the due decision only inside the ±10% band', () => {
    // 23.5h ago: inside [21.6h, 26.4h] → due depends on the draw.
    const at = NOW - 23.5 * 60 * 60 * 1000;
    expect(due('daily', at, 0)).toBe(true); // low draw → 21.6h threshold
    expect(due('daily', at, 1)).toBe(false); // high draw → 26.4h threshold
    // Outside the band the draw is irrelevant.
    expect(due('daily', NOW - 27 * 60 * 60 * 1000, 1)).toBe(true);
    expect(due('daily', NOW - 21 * 60 * 60 * 1000, 0)).toBe(false);
  });
});

describe('announced-major persistence', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips and defaults to null', () => {
    expect(getAnnouncedMajor()).toBeNull();
    setAnnouncedMajor(2);
    expect(localStorage.getItem(MAJOR_ANNOUNCED_KEY)).toBe('2');
    expect(getAnnouncedMajor()).toBe(2);
  });

  it('ignores garbage values', () => {
    localStorage.setItem(MAJOR_ANNOUNCED_KEY, 'two');
    expect(getAnnouncedMajor()).toBeNull();
    localStorage.setItem(MAJOR_ANNOUNCED_KEY, '-1');
    expect(getAnnouncedMajor()).toBeNull();
  });
});

describe('latest-major-seen persistence (durable Settings surface)', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips the version string and defaults to null', () => {
    expect(getLatestMajorSeen()).toBeNull();
    setLatestMajorSeen('2.3.0');
    expect(localStorage.getItem(LATEST_MAJOR_SEEN_KEY)).toBe('2.3.0');
    expect(getLatestMajorSeen()).toBe('2.3.0');
  });

  it('clears on null (a successful check that reports no newer major)', () => {
    setLatestMajorSeen('2.3.0');
    setLatestMajorSeen(null);
    expect(localStorage.getItem(LATEST_MAJOR_SEEN_KEY)).toBeNull();
    expect(getLatestMajorSeen()).toBeNull();
  });
});
