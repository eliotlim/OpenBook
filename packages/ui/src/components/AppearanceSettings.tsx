import {type ComponentType} from 'react';
import {SunIcon} from '@heroicons/react/24/outline';
import {MoonIcon, DesktopIcon} from '@radix-ui/react-icons';
import {ColorMode, useTheme, useTranslation} from '@/providers';
import {Switch} from '@/components/ui/switch';
import {AccentPicker, Field, LevelPicker, NeutralPicker, Segmented} from '@/components/appearance/AppearanceControls';
import type {TKey} from '@/i18n';

const MODES: Array<{value: ColorMode; key: TKey; icon: ComponentType<{className?: string}>}> = [
  {value: 'light', key: 'appearance.light', icon: SunIcon},
  {value: 'dark', key: 'appearance.dark', icon: MoonIcon},
  {value: 'system', key: 'appearance.system', icon: DesktopIcon},
];

/** Color mode + the full appearance model: accent palette, interface tint,
 *  control-accent intensity, and a tinted sidebar toggle. */
export default function AppearanceSettings() {
  const {mode, setMode, appearance, setAppearance, colorScheme} = useTheme();
  const {t} = useTranslation();

  return (
    <div className="flex flex-col gap-7">
      <h3 className="text-lg font-semibold">{t('appearance.title')}</h3>

      <Field label={t('appearance.colorMode')}>
        <Segmented
          options={MODES.map(({value, key, icon}) => ({value, label: t(key), icon}))}
          value={mode}
          onChange={setMode}
        />
      </Field>

      <Field label={t('appearance.colorTheme')} hint={t('appearance.colorThemeHint')}>
        <AccentPicker
          value={appearance.themeId}
          onChange={(themeId) => setAppearance({themeId})}
          scheme={colorScheme}
        />
      </Field>

      <Field label={t('appearance.interfaceTint')} hint={t('appearance.interfaceTintHint')}>
        <NeutralPicker value={appearance.neutral} onChange={(neutral) => setAppearance({neutral})} />
        <div className="mt-1.5">
          <LevelPicker
            value={appearance.tint}
            onChange={(tint) => setAppearance({tint})}
            labels={[
              t('appearance.levelOff'),
              t('appearance.levelSubtle'),
              t('appearance.levelMedium'),
              t('appearance.levelStrong'),
            ]}
          />
        </div>
      </Field>

      <Field label={t('appearance.controlAccent')} hint={t('appearance.controlAccentHint')}>
        <LevelPicker
          value={appearance.accentIntensity}
          onChange={(accentIntensity) => setAppearance({accentIntensity})}
          labels={[
            t('appearance.levelSoft'),
            t('appearance.levelMedium'),
            t('appearance.levelStrong'),
            t('appearance.levelVivid'),
          ]}
        />
      </Field>

      <label className="flex cursor-pointer items-center justify-between gap-4">
        <span className="flex flex-col gap-1">
          <span className="text-sm font-medium">{t('appearance.tintedSidebar')}</span>
          <span className="text-xs text-muted-foreground">{t('appearance.tintedSidebarHint')}</span>
        </span>
        <Switch
          checked={appearance.tintedSidebar}
          onCheckedChange={(tintedSidebar) => setAppearance({tintedSidebar})}
        />
      </label>
    </div>
  );
}
