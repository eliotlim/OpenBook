import {useState, type ComponentType} from 'react';
import {Button} from '@/components/ui/button';
import {PersonIcon} from '@radix-ui/react-icons';
import {PaintBrushIcon, ServerStackIcon, WrenchIcon} from '@heroicons/react/24/outline';
import ServerSettings from '@/components/ServerSettings';

type Tab = 'general' | 'appearance' | 'server' | 'profile';

const TABS: {id: Tab; label: string; icon: ComponentType<{className?: string}>}[] = [
  {id: 'general', label: 'General', icon: WrenchIcon},
  {id: 'appearance', label: 'Appearance', icon: PaintBrushIcon},
  {id: 'server', label: 'Server', icon: ServerStackIcon},
  {id: 'profile', label: 'Profile', icon: PersonIcon},
];

export default function SettingsDialogContent() {
  const [tab, setTab] = useState<Tab>('server');

  return (
    <div className="flex flex-row gap-2 m-0">
      <div className="flex flex-col bg-sheet-1 text-sheet-1-foreground pl-4 pt-8 pb-8 pr-4 rounded-l-lg gap-1 min-w-[160px]">
        <h4 className="text-sm font-semibold pb-2 px-2">Settings</h4>
        {TABS.map(({id, label, icon: Icon}) => (
          <Button
            key={id}
            variant={tab === id ? 'secondary' : 'ghost'}
            className="flex justify-start h-7 px-2"
            onClick={() => setTab(id)}
          >
            <Icon className="w-4 h-4 mr-2" />
            {label}
          </Button>
        ))}
      </div>
      <div className="flex flex-col pl-4 pt-8 pb-8 pr-8 min-h-[440px] w-full overflow-y-auto">
        {tab === 'server' ? (
          <ServerSettings />
        ) : (
          <div className="flex flex-col gap-1">
            <h3 className="text-lg font-semibold capitalize">{tab}</h3>
            <p className="text-sm text-muted-foreground">These settings are coming soon.</p>
          </div>
        )}
      </div>
    </div>
  );
}
