import {Select} from '@/components/ui/select';
import {useTranslation} from '@/providers';
import type {Locale} from '@/i18n';

/** General app settings — currently the display language. */
export default function GeneralSettings() {
  const {t, locale, setLocale, locales} = useTranslation();

  return (
    <div className="flex flex-col gap-7">
      <h3 className="text-lg font-semibold">{t('settings.tab.general')}</h3>

      <section className="flex flex-col gap-1.5">
        <label htmlFor="ob-language" className="text-sm font-medium">
          {t('settings.language')}
        </label>
        <span className="text-xs text-muted-foreground">{t('settings.languageHint')}</span>
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
      </section>
    </div>
  );
}
