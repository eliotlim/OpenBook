import {useCallback} from 'react';
import {Select} from '@/components/ui/select';
import {Button} from '@/components/ui/button';
import {useConfirm, usePreferences, useTranslation} from '@/providers';
import {SettingsScreen, SettingsSection, SettingsToggle} from '@/components/settings/primitives';
import {SETTINGS_SECTION_GENERAL_BEHAVIOR} from '@/lib/settingsIndex';
import {UpdatesSection} from '@/components/settings/UpdatesSection';
import type {Locale} from '@/i18n';

// localStorage keys that hold appearance / language / layout / behavior — but
// NOT library connections (`openbook.libraries`), page icons
// (`openbook.icon.*`), or any server-side pages. Verified against the providers
// that own them (ThemeProvider, I18nProvider, HudProvider, PreferencesProvider).
const RESETTABLE_KEYS = ['hud', 'theme', 'openbook.theme', 'openbook.locale', 'openbook.preferences'];

/** General app settings — display language + basic editor/behavior toggles. */
export default function GeneralSettings() {
  const {t, locale, setLocale, locales} = useTranslation();
  const {preferences, update} = usePreferences();
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
    <SettingsScreen title={t('general.title')} description={t('general.description')} scope="device">
      <SettingsSection title={t('general.languageSection')} description={t('general.languageHint')}>
        <label htmlFor="ob-language" className="sr-only">
          {t('general.language')}
        </label>
        <Select
          id="ob-language"
          wrapperClassName="mt-1 max-w-xs"
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
        >
          {locales.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </Select>
      </SettingsSection>

      <SettingsSection id={SETTINGS_SECTION_GENERAL_BEHAVIOR} title={t('general.behavior')}>
        <SettingsToggle
          label={t('general.confirmTrash')}
          hint={t('general.confirmTrashHint')}
          checked={preferences.general.confirmOnTrash}
          onCheckedChange={(confirmOnTrash) => update({general: {confirmOnTrash}})}
        />
        <SettingsToggle
          label={t('general.spellcheck')}
          hint={t('general.spellcheckHint')}
          checked={preferences.general.spellcheck}
          onCheckedChange={(spellcheck) => update({general: {spellcheck}})}
        />
      </SettingsSection>

      {/* Desktop only — renders nothing when the platform can't self-update. */}
      <UpdatesSection />

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
