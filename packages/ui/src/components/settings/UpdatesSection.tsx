import {useCallback, useEffect, useState} from 'react';
import {Download, Loader2, RefreshCw} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Select} from '@/components/ui/select';
import {useConfirm, usePlatformLibrary, useTranslation} from '@/providers';
import type {UpdateCheckResult} from '@/providers';
import {SettingsSection, SettingsField, SettingsToggle} from '@/components/settings/primitives';
import {anyPageSavePending} from '@/lib/pageSaveStatus';
import {
  getUpdateCadence,
  getUpdateLastCheckSuccessAt,
  getUpdateSecurityOnly,
  setUpdateCadence,
  setUpdateSecurityOnly,
  type UpdateCadence,
} from '@/lib/updatePreferences';
import {runDownloadAndInstall, runUpdateCheck} from '@/lib/updateRunner';
import {getLatestMajorSeen} from '@/lib/updateScheduler';
import {semverMajor} from '@/lib/updateCheck';
import {cn} from '@/lib/utils';

/** Compact relative time ("just now", "5m ago", "2h ago", "3d ago"). */
function relativeWhen(t: ReturnType<typeof useTranslation>['t'], ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return t('updates.justNow');
  const mins = Math.round(secs / 60);
  if (mins < 60) return t('updates.minutesAgo', {n: mins});
  const hours = Math.round(mins / 60);
  if (hours < 24) return t('updates.hoursAgo', {n: hours});
  return t('updates.daysAgo', {n: Math.round(hours / 24)});
}

type Tone = 'ok' | 'available' | 'error';

/**
 * The desktop self-update controls, shown only when the host platform supports
 * updates (`platform.updates`). The web shell leaves that undefined, so this
 * renders nothing there. Cadence + "security only" are persisted through the
 * `lib/updatePreferences` accessor (shared with a future background scheduler);
 * "Check for updates" runs a one-off check regardless of cadence.
 */
export function UpdatesSection() {
  const platform = usePlatformLibrary();
  const {t} = useTranslation();
  const confirm = useConfirm();
  const updates = platform.updates;

  const [cadence, setCadence] = useState<UpdateCadence>('daily');
  const [securityOnly, setSecurityOnly] = useState(false);
  // The last *successful* check — what "Last checked" shows. The attempt
  // timestamp (updates.lastCheckAt) is stamped too but not displayed: it exists
  // for the scheduler's throttle, and showing it would make a failed check read
  // as a fresh successful one.
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  // The one-click install action's progress: `downloading` while the signed
  // update is fetched+staged (runDownloadAndInstall), `installing` while the
  // relaunch that applies it is invoked. On desktop the process ends during
  // `installing`; on web the stub resolves and the button just stays inert.
  const [installPhase, setInstallPhase] = useState<'downloading' | 'installing' | null>(null);
  // A download / signature-verification / relaunch failure, surfaced inline
  // (assertively — an action the user just took failed) rather than swallowed.
  const [installError, setInstallError] = useState<string | null>(null);
  // The `latestMajor` the most recent successful check reported (recorded by
  // the shared runner) — the durable "a new major exists" surface. The
  // once-per-major toast is a ~7s signal; this line is what a user who missed
  // it finds, and it survives between checks and sessions.
  const [majorSeen, setMajorSeen] = useState<string | null>(null);

  // Adopt persisted preferences once on the client (SSR-safe: the accessor reads
  // localStorage, which the server render must not touch).
  useEffect(() => {
    setCadence(getUpdateCadence());
    setSecurityOnly(getUpdateSecurityOnly());
    setLastSuccessAt(getUpdateLastCheckSuccessAt());
    setMajorSeen(getLatestMajorSeen());
  }, []);

  // Show the running app version when the platform can report it.
  useEffect(() => {
    if (!updates) return;
    let cancelled = false;
    updates
      .getAppVersion()
      .then((v) => {
        if (!cancelled) setVersion(v);
      })
      .catch(() => {
        // A version we can't read just stays hidden — not worth an error state.
      });
    return () => {
      cancelled = true;
    };
  }, [updates]);

  const onCadence = useCallback((next: UpdateCadence) => {
    setCadence(next);
    setUpdateCadence(next);
  }, []);

  const onSecurityOnly = useCallback((next: boolean) => {
    setSecurityOnly(next);
    setUpdateSecurityOnly(next);
  }, []);

  const check = useCallback(async () => {
    if (!updates || checking) return; // no double-click; the runner also single-flights
    setChecking(true);
    setInstallError(null); // a fresh check supersedes any stale install failure
    // The shared single-flight runner (same pipeline the background scheduler
    // uses, so manual + background can never double-run) stamps the timestamps:
    // the attempt on every check, the success one only when it completed —
    // "Last checked" must not read as fresh after a failure. Re-read it after
    // the run rather than duplicating that policy here.
    const r: UpdateCheckResult = await runUpdateCheck(updates);
    setLastSuccessAt(getUpdateLastCheckSuccessAt());
    setMajorSeen(getLatestMajorSeen());
    setResult(r);
    setChecking(false);
  }, [updates, checking]);

  // One-click: download+stage the signed update through the pinned channel, then
  // relaunch to apply it — the same runner pipeline the background scheduler
  // uses (single-flighted, so a background download in flight is joined, never
  // doubled). The restart is guarded exactly like UpdateScheduler.restart(): a
  // save mid-flight (or failed) is the only case that risks data loss, so confirm
  // only then; the debounced autosave means the common path restarts without
  // ceremony.
  const install = useCallback(async () => {
    if (!updates || installPhase) return;
    setInstallError(null);
    setInstallPhase('downloading');
    try {
      await runDownloadAndInstall(updates);
      if (anyPageSavePending()) {
        const ok = await confirm({
          title: t('updates.restartConfirmTitle'),
          description: t('updates.restartConfirmBody'),
          confirmText: t('updates.restartConfirmAction'),
          destructive: true, // data-loss class → red confirm (matches the toast idiom)
        });
        if (!ok) {
          setInstallPhase(null); // update stays staged; applies on the next restart
          return;
        }
      }
      setInstallPhase('installing');
      await updates.relaunch(); // on desktop the process ends here
    } catch (e) {
      console.error('OpenBook: update install failed:', e);
      setInstallError(t('updates.installError'));
      setInstallPhase(null);
    }
  }, [updates, installPhase, confirm, t]);

  if (!updates) return null;

  const describe = (): {text: string; tone: Tone} | null => {
    if (!result) return null;
    if (result.status === 'error') return {text: t('updates.checkError'), tone: 'error'};
    if (result.status === 'update-available') {
      // A manual check reports the true state; the "security only" preference
      // governs what the background scheduler acts on, not what we surface here.
      const security = result.security?.updateAvailable;
      const v = (security && result.security?.fixedIn) || result.latestVersion || '';
      return {
        text: security
          ? t('updates.securityUpdateAvailable', {version: v})
          : t('updates.updateAvailable', {version: v}),
        tone: 'available',
      };
    }
    const when = relativeWhen(t, lastSuccessAt ?? Date.now());
    return {text: `${t('updates.upToDate')} · ${t('updates.checkedWhen', {when})}`, tone: 'ok'};
  };

  const outcome = describe();
  const lastChecked =
    lastSuccessAt == null ? t('updates.neverChecked') : t('updates.lastChecked', {when: relativeWhen(t, lastSuccessAt)});
  // Show the newer-major line only when it IS newer than the running build —
  // both majors must parse; a stale record from before an upgrade clears on
  // the next successful check (the runner rewrites it every time).
  const seenMajorNum = majorSeen ? semverMajor(majorSeen) : null;
  const currentMajorNum = version ? semverMajor(version) : null;
  const newerMajor = seenMajorNum !== null && currentMajorNum !== null && seenMajorNum > currentMajorNum ? seenMajorNum : null;

  return (
    <SettingsSection title={t('updates.section')} description={t('updates.sectionHint')}>
      <SettingsField label={t('updates.cadence')} hint={t('updates.cadenceHint')} htmlFor="ob-update-cadence">
        <Select
          id="ob-update-cadence"
          wrapperClassName="max-w-xs"
          value={cadence}
          onChange={(e) => onCadence(e.target.value as UpdateCadence)}
        >
          <option value="daily">{t('updates.cadenceDaily')}</option>
          <option value="weekly">{t('updates.cadenceWeekly')}</option>
          <option value="never">{t('updates.cadenceNever')}</option>
        </Select>
      </SettingsField>

      {cadence === 'never' && <p className="text-xs text-muted-foreground">{t('updates.cadenceNeverHint')}</p>}

      {/* No automatic checks → nothing for the filter to act on; keep the
          stored value intact so re-enabling a cadence restores the choice. */}
      <SettingsToggle
        label={t('updates.securityOnly')}
        hint={t('updates.securityOnlyHint')}
        checked={securityOnly}
        onCheckedChange={onSecurityOnly}
        disabled={cadence === 'never'}
      />

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button
          variant="secondary"
          size="sm"
          onClick={check}
          disabled={checking}
          aria-busy={checking}
          data-testid="check-for-updates"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} aria-hidden />
          {checking ? t('updates.checking') : t('updates.checkNow')}
        </Button>
        {/* One-click download+install+relaunch, offered only once a check has
            found something to install. Primary tone so it reads as the action
            to take when an update is waiting. */}
        {result?.status === 'update-available' && (
          <Button
            variant="default"
            size="sm"
            onClick={install}
            disabled={installPhase !== null}
            aria-busy={installPhase !== null}
            data-testid="install-update"
          >
            {installPhase ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Download className="h-3.5 w-3.5" aria-hidden />
            )}
            {installPhase === 'downloading'
              ? t('updates.downloading')
              : installPhase === 'installing'
                ? t('updates.installing')
                : t('updates.installAction')}
          </Button>
        )}
        {/* Always mounted so the live region exists before its first
            announcement — a region inserted with its content is often skipped. */}
        <span
          role="status"
          aria-live="polite"
          data-testid="update-check-result"
          className={cn(
            'text-sm',
            outcome?.tone === 'error' && 'text-destructive',
            outcome?.tone === 'available' && 'font-medium text-foreground',
            outcome?.tone === 'ok' && 'text-muted-foreground',
          )}
        >
          {outcome?.text}
        </span>
      </div>

      {/* Durable major-availability surface (advisory M1): informational, same
          styling as the "available" check outcome. Never an install control —
          majors are an explicit, user-driven move. */}
      {newerMajor !== null && (
        <p data-testid="major-available" className="text-sm font-medium text-foreground">
          {t('updates.majorAvailable', {major: newerMajor})}
        </p>
      )}

      {installError && (
        <p role="alert" data-testid="install-error" className="text-sm text-destructive">
          {installError}
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        {version ? t('updates.version', {version}) : ''}
        {version ? ' · ' : ''}
        {lastChecked}
      </p>
    </SettingsSection>
  );
}

export default UpdatesSection;
