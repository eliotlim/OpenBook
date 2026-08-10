import {useCallback, useEffect, useId, useRef, useState} from 'react';
import {Bug, Loader2, ShieldAlert} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {anyPageSavePending} from '@/lib/pageSaveStatus';
import {
  UPDATE_ADVISORY_SNOOZE_MS,
  dismissUpdateAdvisory,
  getLastSeenUpdateAdvisory,
  getUpdateAdvisorySnooze,
  isUpdateAdvisoryDismissed,
  isUpdateAdvisorySnoozed,
  setLastSeenUpdateAdvisory,
  setUpdateAdvisorySnooze,
} from '@/lib/updatePreferences';
import {runDownloadAndInstall, subscribeUpdateCheckResults} from '@/lib/updateRunner';
import {cn} from '@/lib/utils';
import {useConfirm, useTranslation} from '@/providers';
import type {UpdateAdvisory, UpdatesPlatform} from '@/providers';

/** Typed acknowledgement comparison: exact words, ignoring case and edge whitespace. */
export function matchesAdvisoryAcknowledgement(value: string, phrase: string): boolean {
  return value.trim().toLocaleLowerCase() === phrase.trim().toLocaleLowerCase();
}

interface WarningProps {
  advisory: UpdateAdvisory;
  currentVersion: string | null;
  updates: UpdatesPlatform;
  onSnooze: () => void;
  onDismiss: () => void;
}

/**
 * Modal-grade advisory surface. Radix supplies the focus trap, aria-modal, and
 * focus restoration. Escape, the overlay, and a corner close action are all
 * disabled: the warning closes only through one of its three named actions.
 */
export function UpdateAdvisoryWarning({
  advisory,
  currentVersion,
  updates,
  onSnooze,
  onDismiss,
}: WarningProps) {
  const {t} = useTranslation();
  const confirm = useConfirm();
  const inputId = useId();
  const updateButtonRef = useRef<HTMLButtonElement | null>(null);
  const [acknowledgement, setAcknowledgement] = useState('');
  const [phase, setPhase] = useState<'downloading' | 'installing' | null>(null);
  const [installMessage, setInstallMessage] = useState<{tone: 'error' | 'note'; text: string} | null>(null);

  useEffect(() => {
    setAcknowledgement('');
    setInstallMessage(null);
    setPhase(null);
  }, [advisory.id]);

  const updateNow = useCallback(async () => {
    if (phase !== null) return;
    setInstallMessage(null);
    setPhase('downloading');
    try {
      const staged = await runDownloadAndInstall(updates);
      if (!staged) {
        setPhase(null);
        setInstallMessage({tone: 'note', text: t('updates.installNoop')});
        return;
      }
      if (anyPageSavePending()) {
        const ok = await confirm({
          title: t('updates.restartConfirmTitle'),
          description: t('updates.restartConfirmBody'),
          confirmText: t('updates.restartConfirmAction'),
          destructive: true,
        });
        if (!ok) {
          setPhase(null);
          return;
        }
      }
      setPhase('installing');
      await updates.relaunch();
    } catch (e) {
      console.error('OpenBook: advisory update install failed:', e);
      setInstallMessage({tone: 'error', text: t('updates.installError')});
      setPhase(null);
    }
  }, [confirm, phase, t, updates]);

  const phrase = t('updates.advisory.acknowledgement');
  const canDismiss = matchesAdvisoryAcknowledgement(acknowledgement, phrase);
  const vulnerable = advisory.severity === 'vulnerable';
  const title = vulnerable
    ? t('updates.advisory.vulnerableTitle')
    : t('updates.advisory.majorBugTitle');
  const busy = phase !== null;

  return (
    <Dialog open>
      <DialogContent
        size="sm"
        showClose={false}
        role="alertdialog"
        aria-modal="true"
        className={cn(
          'border-2',
          vulnerable
            ? 'border-destructive bg-destructive/5'
            : 'border-amber-500 bg-amber-500/5',
        )}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          updateButtonRef.current?.focus();
        }}
        data-testid="update-advisory-warning"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-left text-xl">
            <span
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                vulnerable
                  ? 'bg-destructive/15 text-destructive'
                  : 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
              )}
            >
              {vulnerable ? (
                <ShieldAlert className="h-5 w-5" aria-hidden />
              ) : (
                <Bug className="h-5 w-5" aria-hidden />
              )}
            </span>
            {title}
          </DialogTitle>
        </DialogHeader>

        <div
          className="grid max-h-[40vh] gap-4 overflow-y-auto"
          data-testid="update-advisory-scroll-region"
        >
          {/* Deliberately a React text child. No HTML parser, Markdown renderer,
              or linkifier is involved in the server-authored message. */}
          <DialogDescription className="whitespace-pre-wrap break-words text-left text-base font-medium leading-relaxed text-foreground">
            {advisory.message}
          </DialogDescription>

          <dl className="grid gap-1 rounded-md border border-foreground/15 bg-background/70 px-3 py-2 text-sm">
            <div className="flex min-w-0 justify-between gap-4">
              <dt className="text-muted-foreground">{t('updates.advisory.currentVersionLabel')}</dt>
              <dd className="min-w-0 break-all font-mono font-medium">
                {currentVersion ?? t('updates.advisory.unknownVersion')}
              </dd>
            </div>
            <div className="flex min-w-0 justify-between gap-4">
              <dt className="text-muted-foreground">{t('updates.advisory.affectedRangeLabel')}</dt>
              <dd className="min-w-0 break-all font-mono font-medium">{advisory.affectedRange}</dd>
            </div>
            {advisory.minSafeVersion && (
              <div className="flex min-w-0 justify-between gap-4">
                <dt className="text-muted-foreground">{t('updates.advisory.minSafeVersionLabel')}</dt>
                <dd className="min-w-0 break-all font-mono font-medium">
                  {advisory.minSafeVersion}
                </dd>
              </div>
            )}
          </dl>
        </div>

        <div className="grid gap-2">
          <Label htmlFor={inputId}>{t('updates.advisory.ackLabel')}</Label>
          <p id={`${inputId}-hint`} className="text-xs text-muted-foreground">
            {t('updates.advisory.ackPrompt', {phrase})}
          </p>
          <Input
            id={inputId}
            value={acknowledgement}
            onChange={(event) => setAcknowledgement(event.target.value)}
            aria-describedby={`${inputId}-hint`}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {installMessage && (
          <p
            role={installMessage.tone === 'error' ? 'alert' : 'status'}
            className={cn('text-sm', installMessage.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}
          >
            {installMessage.text}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onSnooze} disabled={busy}>
            {t('updates.advisory.snoozeAction')}
          </Button>
          <Button variant="destructive" onClick={onDismiss} disabled={busy || !canDismiss}>
            {t('updates.advisory.dismissAction')}
          </Button>
          <Button ref={updateButtonRef} onClick={() => void updateNow()} disabled={busy} aria-busy={busy}>
            {phase && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {phase === 'downloading'
              ? t('updates.downloading')
              : phase === 'installing'
                ? t('updates.installing')
                : t('updates.advisory.updateNowAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Global bridge from every shared update check to the one advisory dialog. */
export function UpdateAdvisoryHost({updates}: {updates: UpdatesPlatform}) {
  const {t} = useTranslation();
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [advisory, setAdvisory] = useState<UpdateAdvisory | null>(() => {
    const stored = getLastSeenUpdateAdvisory();
    return stored && !isUpdateAdvisoryDismissed(stored.id) && !isUpdateAdvisorySnoozed(stored.id)
      ? stored
      : null;
  });
  const [snoozedAdvisory, setSnoozedAdvisory] = useState<UpdateAdvisory | null>(() => {
    const stored = getLastSeenUpdateAdvisory();
    return stored && !isUpdateAdvisoryDismissed(stored.id) && isUpdateAdvisorySnoozed(stored.id)
      ? stored
      : null;
  });
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    let cancelled = false;
    void updates
      .getAppVersion()
      .then((version) => {
        if (!cancelled) setCurrentVersion(version);
      })
      .catch(() => {
        // The warning remains actionable even if the host cannot name its build.
      });

    const unsubscribe = subscribeUpdateCheckResults((result) => {
      if (result.status === 'error') return;
      const next = result.advisory ?? null;
      setLastSeenUpdateAdvisory(next);
      if (next === null || isUpdateAdvisoryDismissed(next.id)) {
        setAdvisory(null);
        setSnoozedAdvisory(null);
        return;
      }
      if (isUpdateAdvisorySnoozed(next.id)) {
        setAdvisory(null);
        setSnoozedAdvisory(next);
        return;
      }
      setSnoozedAdvisory(null);
      setAdvisory(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [updates]);

  // Restore a snoozed warning without another network request after 24 hours.
  useEffect(() => {
    if (!snoozedAdvisory) return;
    const snooze = getUpdateAdvisorySnooze();
    if (!snooze || snooze.advisoryId !== snoozedAdvisory.id) {
      setSnoozedAdvisory(null);
      return;
    }
    const remaining = snooze.snoozedAt + UPDATE_ADVISORY_SNOOZE_MS - Date.now();
    if (remaining <= 0) {
      if (!isUpdateAdvisoryDismissed(snoozedAdvisory.id)) setAdvisory(snoozedAdvisory);
      setSnoozedAdvisory(null);
      return;
    }
    const timer = setTimeout(() => {
      if (!isUpdateAdvisoryDismissed(snoozedAdvisory.id)) setAdvisory(snoozedAdvisory);
      setSnoozedAdvisory(null);
    }, remaining);
    return () => clearTimeout(timer);
  }, [snoozedAdvisory]);

  useEffect(() => {
    if (!advisory) {
      setAnnouncement('');
      return;
    }
    const title =
      advisory.severity === 'vulnerable'
        ? t('updates.advisory.vulnerableTitle')
        : t('updates.advisory.majorBugTitle');
    setAnnouncement(`${title}. ${advisory.message}`);
  }, [advisory, t]);

  const snooze = useCallback(() => {
    if (!advisory) return;
    setUpdateAdvisorySnooze(advisory.id);
    setSnoozedAdvisory(advisory);
    setAdvisory(null);
  }, [advisory]);

  const dismiss = useCallback(() => {
    if (!advisory) return;
    dismissUpdateAdvisory(advisory.id);
    setSnoozedAdvisory(null);
    setAdvisory(null);
  }, [advisory]);

  return (
    <>
      {/* Always mounted before its text changes so assistive technology hears
          the warning in addition to the alertdialog's own announcement. */}
      <span className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {announcement}
      </span>
      {advisory && (
        <UpdateAdvisoryWarning
          advisory={advisory}
          currentVersion={currentVersion}
          updates={updates}
          onSnooze={snooze}
          onDismiss={dismiss}
        />
      )}
    </>
  );
}
