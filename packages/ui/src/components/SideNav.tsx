import {Drawer} from '@/components';
import {useHud} from '@/providers';
import ColorSchemeMenu from '@/components/ColorSchemeMenu';
import AboutDialog from '@/components/AboutDialog';
import WorkspaceSelectMenu from '@/components/WorkspaceSelectMenu';
import SettingsButton from '@/components/SettingsButton';
import WorkspaceNavigationTree from '@/components/WorkspaceNavigationTree';
import CommandToggle from '@/components/CommandToggle';

export default function SideNav() {
  const {hud} = useHud();
  return (
    <Drawer open={hud.sideNav.open} docked={hud.sideNav.docked}>
      <div className="flex h-full flex-col">
        <div className="px-2 pt-2">
          <WorkspaceSelectMenu />
        </div>
        <div className="flex flex-col gap-0.5 px-2 pb-1 pt-1">
          <CommandToggle />
          <SettingsButton />
        </div>
        <div className="mt-1 min-h-0 flex-1 overflow-hidden">
          <WorkspaceNavigationTree />
        </div>
        <div className="flex items-center justify-between border-t border-border/60 px-2 py-1.5">
          <AboutDialog />
          <ColorSchemeMenu />
        </div>
      </div>
    </Drawer>
  );
}
