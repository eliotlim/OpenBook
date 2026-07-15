import {type ComponentType} from 'react';
import {SunIcon} from '@heroicons/react/24/outline';
import {MoonIcon, DesktopIcon} from '@radix-ui/react-icons';
import {ColorMode, useTheme, useTranslation} from '@/providers';
import {AccentPicker, Field, LevelPicker, Segmented} from '@/components/appearance/AppearanceControls';
import {SettingsScreen, SettingsToggle} from '@/components/settings/primitives';
import type {TKey} from '@/i18n';

const MODES: Array<{value: ColorMode; key: TKey; icon: ComponentType<{className?: string}>}> = [
  {value: 'light', key: 'appearance.light', icon: SunIcon},
  {value: 'dark', key: 'appearance.dark', icon: MoonIcon},
  {value: 'system', key: 'appearance.system', icon: DesktopIcon},
];

/** Color mode + the full appearance model: accent palette, interface tint,
 *  control-accent intensity, and an overlay-blur toggle. */
export default function AppearanceSettings() {
  const {mode, setMode, appearance, setAppearance, colorScheme} = useTheme();
  const {t} = useTranslation();

  return (
    <SettingsScreen title={t('appearance.title')} scope="device">
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

      <Field label={t('appearance.sidebar')} hint={t('appearance.sidebarHint')}>
        <Segmented
          options={[
            {value: 'tinted', label: t('appearance.sidebarTinted')},
            {value: 'accent', label: t('appearance.sidebarAccent')},
          ]}
          value={appearance.sidebar}
          onChange={(sidebar) => setAppearance({sidebar})}
        />
      </Field>

      <Field label={t('appearance.interfaceIntensity')} hint={t('appearance.interfaceIntensityHint')}>
        <LevelPicker
          value={appearance.interfaceIntensity}
          onChange={(interfaceIntensity) => setAppearance({interfaceIntensity})}
          labels={[
            t('appearance.levelOff'),
            t('appearance.levelSubtle'),
            t('appearance.levelMedium'),
            t('appearance.levelStrong'),
          ]}
        />
      </Field>

      <Field label={t('appearance.controlIntensity')} hint={t('appearance.controlIntensityHint')}>
        <LevelPicker
          value={appearance.controlIntensity}
          onChange={(controlIntensity) => setAppearance({controlIntensity})}
          labels={[
            t('appearance.levelSoft'),
            t('appearance.levelMedium'),
            t('appearance.levelStrong'),
            t('appearance.levelVivid'),
          ]}
        />
      </Field>

      <Field label={t('appearance.dataColors')} hint={t('appearance.dataColorsHint')}>
        <Segmented
          options={[
            {value: 'pastel', label: t('appearance.dataColorsPastel')},
            {value: 'vivid', label: t('appearance.dataColorsVivid')},
            {value: 'muted', label: t('appearance.dataColorsMuted')},
          ]}
          value={appearance.dataColors}
          onChange={(dataColors) => setAppearance({dataColors})}
        />
      </Field>

      <SettingsToggle
        label={t('appearance.blurOverlays')}
        hint={t('appearance.blurOverlaysHint')}
        checked={appearance.blurOverlays ?? false}
        onCheckedChange={(blurOverlays) => setAppearance({blurOverlays})}
      />
    </SettingsScreen>
  );
}
