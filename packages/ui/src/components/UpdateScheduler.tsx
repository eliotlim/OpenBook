import {useEffect, useRef} from 'react';
import {showToast} from '@/components/ui/toast';
import {t} from '@/i18n';
import {anyPageSavePending} from '@/lib/pageSaveStatus';
import {readUpdatePreferences} from '@/lib/updatePreferences';
import {runDownloadAndInstall, runUpdateCheck} from '@/lib/updateRunner';
import {
  SCHEDULER_TICK_MS,
  decideUpdateAction,
  getAnnouncedMajor,
  isBackgroundCheckDue,
  setAnnouncedMajor,
} from '@/lib/updateScheduler';
import {useConfirm} from '@/providers/ConfirmProvider';
import {usePlatformLibrary} from '@/providers/PlatformLibraryProvider';

/**
 * The background update scheduler (desktop only — inert without
 * `platform.updates`). Mounted once in DefaultLayout, PluginBoot-style: it has
 * to live *inside* ConfirmProvider (the restart guard) and alongside ToastHost,
 * both of which exist in every shell there, so no per-shell wiring is needed —
 * the capability flag alone decides whether it does anything.
 *
 * On mount and every {@link SCHEDULER_TICK_MS} it re-reads the preferences and
 * runs a check when the cadence says one is due (`lib/updateScheduler` owns
 * that math; `never` means zero requests). Checks and downloads go through
 * `lib/updateRunner`, the single-flight pipeline shared with the Settings
 * "Check for updates" button, so background and manual can never double-run.
 *
 * Everything here is deliberately quiet: a failed background check or download
 * is a `console.debug` and a retry on a later tick — never an error toast, and
 * never a modal. The only dialog is the restart guard, and only when the user
 * explicitly clicks "Restart to update" while a page save is still in flight
 * (or failed): normally edits are already flushed by the autosave loop, so the
 * restart proceeds without ceremony.
 */
export default function UpdateScheduler() {
  const {updates} = usePlatformLibrary();
  const confirm = useConfirm();

  // The interval closure must see the *current* confirm (ConfirmProvider hands
  // out a stable callback, but don't depend on that) without re-arming the
  // scheduler; `t` needs no ref — it's the module-singleton translator.
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;

  // One action pipeline at a time across ticks: a slow download must not be
  // re-entered by the next tick. Module-level would also survive remounts, but
  // the runner's single-flight already covers that; this ref just keeps a
  // single mount from stacking ticks.
  const busyRef = useRef(false);

  useEffect(() => {
    if (!updates) return;

    const restart = async (): Promise<void> => {
      // Saves flush automatically (debounced autosave), so a restart normally
      // needs no confirmation — the toast action *is* the explicit consent.
      // Guard only the risky case: a save mid-flight or failed, where an
      // immediate relaunch could lose the last edit.
      if (anyPageSavePending()) {
        const ok = await confirmRef.current({
          title: t('updates.restartConfirmTitle'),
          description: t('updates.restartConfirmBody'),
          confirmText: t('updates.restartConfirmAction'),
        });
        if (!ok) return;
      }
      try {
        await updates.relaunch();
      } catch (e) {
        console.error('OpenBook: relaunch failed:', e);
      }
    };

    const tick = async (): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        // Preferences are re-read every tick so a cadence change in Settings
        // takes effect immediately, no restart needed.
        const prefs = readUpdatePreferences();
        const due = isBackgroundCheckDue({
          cadence: prefs.cadence,
          lastCheckAt: prefs.lastCheckAt,
          now: Date.now(),
          jitter: Math.random(),
        });
        if (!due) return;

        const result = await runUpdateCheck(updates);
        if (result.status === 'error') {
          // Background failures are silent: retry on a later tick (the attempt
          // timestamp was stamped, so the cadence still throttles retries).
          console.debug('OpenBook: background update check failed:', result.error);
          return;
        }

        const currentVersion = await updates.getAppVersion();
        const action = decideUpdateAction(result, {
          currentVersion,
          securityOnly: prefs.securityOnly,
          announcedMajor: getAnnouncedMajor(),
        });

        // A newer major is informational only — announced at most once per
        // major, never downloaded. Recorded before showing so a toast hiccup
        // can't cause a re-announcement loop.
        if (action.announceMajor !== null) {
          setAnnouncedMajor(action.announceMajor);
          showToast({message: t('updates.majorAvailableToast', {major: action.announceMajor})});
        }

        if (action.install !== null) {
          try {
            await runDownloadAndInstall(updates);
          } catch (e) {
            console.debug('OpenBook: background update download failed:', e);
            return;
          }
          showToast({
            message: action.install === 'security' ? t('updates.securityReadyToast') : t('updates.readyToast'),
            actionLabel: t('updates.restartAction'),
            onAction: () => void restart(),
            // A staged security fix must stay visible until the user deals
            // with it; a routine update can auto-dismiss (it applies on the
            // next natural restart anyway).
            durationMs: action.install === 'security' ? Number.POSITIVE_INFINITY : undefined,
          });
        }
      } finally {
        busyRef.current = false;
      }
    };

    void tick();
    const interval = setInterval(() => void tick(), SCHEDULER_TICK_MS);
    return () => clearInterval(interval);
  }, [updates]);

  return null;
}
