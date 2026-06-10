import {Select} from '@/components/ui/select';
import {usePreferences, useTranslation} from '@/providers';
import {SettingsScreen, SettingsSection, SettingsToggle} from '@/components/settings/primitives';
import type {Locale} from '@/i18n';

/** General app settings — display language + basic editor/behavior toggles. */
export default function GeneralSettings() {
  const {t, locale, setLocale, locales} = useTranslation();
  const {preferences, update} = usePreferences();

  return (
    <SettingsScreen title={t('general.title')} description={t('general.description')}>
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

      <SettingsSection title={t('general.behavior')}>
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
        <SettingsToggle
          label={t('general.blockEditor')}
          hint={t('general.blockEditorHint')}
          checked={preferences.general.blockEditor}
          onCheckedChange={(blockEditor) => update({general: {blockEditor}})}
        />
      </SettingsSection>
    </SettingsScreen>
  );
}
