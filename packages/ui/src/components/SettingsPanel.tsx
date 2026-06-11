import {type ComponentType} from 'react';
import {
  Cross2Icon,
  EnterFullScreenIcon,
  ExitFullScreenIcon,
  PersonIcon,
  MixerHorizontalIcon,
  RocketIcon,
  EnvelopeClosedIcon,
  HeartIcon,
  MixIcon,
} from '@radix-ui/react-icons';
import {ArchiveBoxIcon, CpuChipIcon, PaintBrushIcon, ServerStackIcon, WrenchIcon} from '@heroicons/react/24/outline';
import {Button} from '@/components/ui/button';
import AppearanceSettings from '@/components/AppearanceSettings';
import GeneralSettings from '@/components/GeneralSettings';
import AiSettings from '@/components/AiSettings';
import ProfileSettings from '@/components/settings/ProfileSettings';
import CustomisationSettings from '@/components/settings/CustomisationSettings';
import ConnectionSettings from '@/components/settings/ConnectionSettings';
import AdminSettings from '@/components/settings/AdminSettings';
import {SignupSettings, SigninSettings, SupportSettings, IntegrationsSettings} from '@/components/settings/stubs';
import {cn} from '@/lib/utils';
import {usePreferences, useTranslation} from '@/providers';
import type {TKey} from '@/i18n';
import {SETTINGS_SECTIONS, type SettingsMode, type SettingsTab} from '@/lib/hud';

const TAB_META: Record<SettingsTab, {labelKey: TKey; icon: ComponentType<{className?: string}>}> = {
  general: {labelKey: 'settings.tab.general', icon: WrenchIcon},
  profile: {labelKey: 'settings.tab.profile', icon: PersonIcon},
  appearance: {labelKey: 'settings.tab.appearance', icon: PaintBrushIcon},
  customisation: {labelKey: 'settings.tab.customisation', icon: MixerHorizontalIcon},
  signup: {labelKey: 'settings.tab.signup', icon: RocketIcon},
  signin: {labelKey: 'settings.tab.signin', icon: EnvelopeClosedIcon},
  support: {labelKey: 'settings.tab.support', icon: HeartIcon},
  connection: {labelKey: 'settings.tab.connection', icon: ServerStackIcon},
  integrations: {labelKey: 'settings.tab.integrations', icon: MixIcon},
  ai: {labelKey: 'settings.tab.ai', icon: CpuChipIcon},
  admin: {labelKey: 'settings.tab.admin', icon: ArchiveBoxIcon},
};

const SECTION_LABEL: Record<(typeof SETTINGS_SECTIONS)[number]['id'], TKey> = {
  preferences: 'settings.section.preferences',
  account: 'settings.section.account',
  workspace: 'settings.section.workspace',
};

const PANELS: Record<SettingsTab, ComponentType> = {
  general: GeneralSettings,
  ai: AiSettings,
  profile: ProfileSettings,
  appearance: AppearanceSettings,
  customisation: CustomisationSettings,
  signup: SignupSettings,
  signin: SigninSettings,
  support: SupportSettings,
  connection: ConnectionSettings,
  integrations: IntegrationsSettings,
  admin: AdminSettings,
};

export interface SettingsPanelProps {
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  mode: SettingsMode;
  onModeChange: (mode: SettingsMode) => void;
  onClose: () => void;
}

/** A small user chip at the foot of the nav; clicking it opens the Profile tab. */
function ProfileChip({onClick}: {onClick: () => void}) {
  const {t} = useTranslation();
  const {profile} = usePreferences().preferences;
  const name = profile.displayName.trim() || profile.name.trim() || t('profile.anonymous');
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-base leading-none">
        {profile.avatar}
      </span>
      <span className="truncate text-sm font-medium">{name}</span>
    </button>
  );
}

/**
 * The settings UI (grouped tab rail + active panel + window controls), fully
 * controlled. Rendered identically inside the modal and fullscreen surfaces so
 * the two only differ in how the surrounding surface is sized.
 */
export default function SettingsPanel({tab, onTabChange, mode, onModeChange, onClose}: SettingsPanelProps) {
  const fullscreen = mode === 'fullscreen';
  const {t} = useTranslation();
  const Panel = PANELS[tab];

  return (
    <div className="relative flex h-full min-h-0 w-full flex-row">
      <nav
        className={cn(
          'flex w-[210px] shrink-0 flex-col gap-1 overflow-y-auto bg-sheet-1 px-3 pb-4 pt-8 text-sheet-1-foreground',
          !fullscreen && 'rounded-l-lg',
        )}
      >
        <h4 className="px-2 pb-1 text-sm font-semibold">{t('settings.title')}</h4>
        {SETTINGS_SECTIONS.map((section) => (
          <div key={section.id} className="flex flex-col gap-0.5">
            <span className="px-2 pb-0.5 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t(SECTION_LABEL[section.id])}
            </span>
            {section.tabs.map((id) => {
              const {labelKey, icon: Icon} = TAB_META[id];
              return (
                <Button
                  key={id}
                  variant={tab === id ? 'secondary' : 'ghost'}
                  className="flex h-7 justify-start px-2 font-normal"
                  onClick={() => onTabChange(id)}
                >
                  <Icon className="mr-2 h-4 w-4 shrink-0" />
                  <span className="truncate">{t(labelKey)}</span>
                </Button>
              );
            })}
          </div>
        ))}
        <div className="mt-auto">
          <ProfileChip onClick={() => onTabChange('profile')} />
        </div>
      </nav>

      <div className="flex min-h-0 w-full flex-col overflow-y-auto px-8 pb-8 pt-12">
        <Panel />
      </div>

      <div className="absolute right-3 top-3 flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={fullscreen ? t('settings.exitFullscreen') : t('settings.enterFullscreen')}
          title={fullscreen ? t('settings.exitFullscreen') : t('settings.fullscreen')}
          onClick={() => onModeChange(fullscreen ? 'modal' : 'fullscreen')}
        >
          {fullscreen ? <ExitFullScreenIcon className="h-4 w-4" /> : <EnterFullScreenIcon className="h-4 w-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={t('settings.closeSettings')}
          title={t('common.close')}
          onClick={onClose}
        >
          <Cross2Icon className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
