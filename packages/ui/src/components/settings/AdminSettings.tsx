import {useCallback} from 'react';
import {Button} from '@/components/ui/button';
import BackupSettings from '@/components/BackupSettings';
import {useConfirm, useTranslation} from '@/providers';
import {SettingsScreen, SettingsSection} from '@/components/settings/primitives';

// localStorage keys that hold appearance / language / layout / behavior — but
// NOT workspace connections (`openbook.workspaces`), page icons
// (`openbook.icon.*`), or any server-side pages. Verified against the providers
// that own them (ThemeProvider, I18nProvider, HudProvider, PreferencesProvider).
const RESETTABLE_KEYS = ['hud', 'theme', 'openbook.theme', 'openbook.locale', 'openbook.preferences'];

/** Workspace maintenance: backup & restore, plus a guarded danger zone. */
export default function AdminSettings() {
  const {t} = useTranslation();
  const confirm = useConfirm();

  const resetPreferences = useCallback(async () => {
    const ok = await confirm({
      title: t('admin.resetConfirmTitle'),
      description: t('admin.resetConfirmBody'),
      confirmText: t('admin.resetConfirmButton'),
      destructive: true,
    });
    if (!ok) return;
    try {
      for (const k of RESETTABLE_KEYS) localStorage.removeItem(k);
    } catch {
      // ignore (private mode)
    }
    if (typeof window !== 'undefined') window.location.reload();
  }, [confirm, t]);

  return (
    <SettingsScreen title={t('admin.title')} description={t('admin.description')}>
      <BackupSettings />

      <SettingsSection title={t('admin.dangerZone')} description={t('admin.dangerZoneHint')} className="gap-3">
        <div className="flex items-center justify-between gap-6 rounded-md border border-destructive/40 px-3.5 py-3">
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-medium">{t('admin.resetPrefs')}</span>
            <span className="text-xs text-muted-foreground">{t('admin.resetPrefsHint')}</span>
          </span>
          <Button variant="destructive" onClick={() => void resetPreferences()} className="shrink-0">
            {t('admin.resetPrefsButton')}
          </Button>
        </div>
      </SettingsSection>
    </SettingsScreen>
  );
}
