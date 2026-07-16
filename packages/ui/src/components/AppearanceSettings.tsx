import {type ComponentType} from 'react';
import {SlidersHorizontal} from 'lucide-react';
import {SunIcon} from '@heroicons/react/24/outline';
import {MoonIcon, DesktopIcon} from '@radix-ui/react-icons';
import {ColorMode, useHud, useNavigation, useTheme, useTranslation} from '@/providers';
import {AccentPicker, Field, LevelPicker, Segmented} from '@/components/appearance/AppearanceControls';
import {SettingsScreen, SettingsToggle} from '@/components/settings/primitives';
import {Button} from '@/components/ui/button';
import {CUSTOMISE_PANE_ID} from '@/lib/homePage';
import {setPageCustomiseTarget} from '@/lib/pageCustomise';
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
  const {hud, setHud} = useHud();
  const {currentPageId, openInSplit} = useNavigation();

  // Cross-link to the per-page scope: close settings and open the current page's
  // Customise pane (cover, width, theme, fonts). Mirrors the reverse pointer the
  // Customise pane shows back to app-wide Appearance (PageCustomiseBody).
  const openPageCustomise = () => {
    if (currentPageId) setPageCustomiseTarget(currentPageId);
    setHud((draft) => {
      draft.settings.open = false;
      return draft;
    });
    openInSplit(CUSTOMISE_PANE_ID);
  };

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

      {/* Auto-hide sidebar (moved out of the Shortcuts tab, SET2-7): a layout
          preference that belongs with the other look-and-feel controls. It docks
          when off; auto-hides (collapses until you reach the screen edge) when on. */}
      <SettingsToggle
        label={t('appearance.autoHideSidebar')}
        hint={t('appearance.autoHideSidebarHint')}
        checked={!hud.sideNav.docked}
        onCheckedChange={(v) =>
          setHud((draft) => {
            draft.sideNav.docked = !v;
            if (!draft.sideNav.docked) draft.sideNav.open = false;
            return draft;
          })
        }
      />

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

      {/* Scope cross-link (SET2-7): these controls theme the whole app on this
          device; a single page's look lives in its own Customise pane. Point
          there so the two scopes stay distinct. */}
      <div className="flex items-center justify-between gap-4 rounded-md border border-border px-3.5 py-3">
        <span className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">{t('appearance.perPageTitle')}</span>
          <span className="text-xs text-muted-foreground">{t('appearance.perPagePointer')}</span>
        </span>
        <Button variant="secondary" size="sm" className="shrink-0" onClick={openPageCustomise}>
          <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" />
          {t('appearance.openPageCustomise')}
        </Button>
      </div>
    </SettingsScreen>
  );
}
