import {type ComponentType} from 'react';
import {Cross2Icon, EnterFullScreenIcon, ExitFullScreenIcon, PersonIcon} from '@radix-ui/react-icons';
import {PaintBrushIcon, ServerStackIcon, WrenchIcon} from '@heroicons/react/24/outline';
import {Button} from '@/components/ui/button';
import ServerSettings from '@/components/ServerSettings';
import {cn} from '@/lib/utils';
import {SETTINGS_TABS, type SettingsMode, type SettingsTab} from '@/lib/hud';

const TAB_META: Record<SettingsTab, {label: string; icon: ComponentType<{className?: string}>}> = {
  general: {label: 'General', icon: WrenchIcon},
  appearance: {label: 'Appearance', icon: PaintBrushIcon},
  server: {label: 'Server', icon: ServerStackIcon},
  profile: {label: 'Profile', icon: PersonIcon},
};

export interface SettingsPanelProps {
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  mode: SettingsMode;
  onModeChange: (mode: SettingsMode) => void;
  onClose: () => void;
}

/**
 * The settings UI (tab rail + active panel + window controls), fully controlled.
 * Rendered identically inside the modal and the fullscreen presentations so the
 * two only differ in how the surrounding surface is sized.
 */
export default function SettingsPanel({tab, onTabChange, mode, onModeChange, onClose}: SettingsPanelProps) {
  const fullscreen = mode === 'fullscreen';

  return (
    <div className="relative flex h-full min-h-0 w-full flex-row">
      <nav
        className={cn(
          'flex w-[180px] shrink-0 flex-col gap-1 bg-sheet-1 px-3 pb-6 pt-8 text-sheet-1-foreground',
          !fullscreen && 'rounded-l-lg',
        )}
      >
        <h4 className="px-2 pb-2 text-sm font-semibold">Settings</h4>
        {SETTINGS_TABS.map((id) => {
          const {label, icon: Icon} = TAB_META[id];
          return (
            <Button
              key={id}
              variant={tab === id ? 'secondary' : 'ghost'}
              className="flex h-7 justify-start px-2"
              onClick={() => onTabChange(id)}
            >
              <Icon className="mr-2 h-4 w-4" />
              {label}
            </Button>
          );
        })}
      </nav>

      <div className="flex min-h-0 w-full flex-col overflow-y-auto px-8 pb-8 pt-12">
        {tab === 'server' ? (
          <ServerSettings />
        ) : (
          <div className="flex flex-col gap-1">
            <h3 className="text-lg font-semibold">{TAB_META[tab].label}</h3>
            <p className="text-sm text-muted-foreground">These settings are coming soon.</p>
          </div>
        )}
      </div>

      <div className="absolute right-3 top-3 flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={fullscreen ? 'Exit full screen' : 'Enter full screen'}
          title={fullscreen ? 'Exit full screen' : 'Full screen'}
          onClick={() => onModeChange(fullscreen ? 'modal' : 'fullscreen')}
        >
          {fullscreen ? <ExitFullScreenIcon className="h-4 w-4" /> : <EnterFullScreenIcon className="h-4 w-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Close settings"
          title="Close"
          onClick={onClose}
        >
          <Cross2Icon className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
