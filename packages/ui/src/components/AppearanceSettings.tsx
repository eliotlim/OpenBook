import {type ComponentType} from 'react';
import {SunIcon} from '@heroicons/react/24/outline';
import {MoonIcon, DesktopIcon, CheckIcon} from '@radix-ui/react-icons';
import {cn} from '@/lib/utils';
import {ColorMode, useTheme, useTranslation} from '@/providers';
import type {TKey} from '@/i18n';

const MODES: Array<{value: ColorMode; key: TKey; icon: ComponentType<{className?: string}>}> = [
  {value: 'light', key: 'appearance.light', icon: SunIcon},
  {value: 'dark', key: 'appearance.dark', icon: MoonIcon},
  {value: 'system', key: 'appearance.system', icon: DesktopIcon},
];

/** Color mode (light/dark/system) + named color-theme picker. */
export default function AppearanceSettings() {
  const {mode, setMode, themeId, setThemeId, themes, colorScheme} = useTheme();
  const {t} = useTranslation();

  return (
    <div className="flex flex-col gap-7">
      <h3 className="text-lg font-semibold">{t('appearance.title')}</h3>

      <section className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t('appearance.colorMode')}</span>
        <div className="flex gap-2">
          {MODES.map(({value, key, icon: Icon}) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={cn(
                'flex flex-1 cursor-pointer flex-col items-center gap-1.5 rounded-md border px-3 py-3 text-sm transition-colors',
                mode === value ? 'border-primary bg-accent' : 'border-border hover:bg-accent',
              )}
            >
              <Icon className="h-5 w-5" />
              {t(key)}
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t('appearance.colorTheme')}</span>
        <span className="text-xs text-muted-foreground">{t('appearance.colorThemeHint')}</span>
        <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {themes.map((theme) => {
            const tokens = colorScheme === 'dark' ? theme.dark : theme.light;
            const active = theme.id === themeId;
            return (
              <button
                key={theme.id}
                type="button"
                onClick={() => setThemeId(theme.id)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-sm transition-colors',
                  active ? 'border-primary bg-accent' : 'border-border hover:bg-accent',
                )}
              >
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border"
                  style={{backgroundColor: `hsl(${tokens.primary})`}}
                >
                  {active && <CheckIcon className="h-3.5 w-3.5 text-white" />}
                </span>
                <span className="truncate">{t(theme.nameKey as TKey)}</span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
