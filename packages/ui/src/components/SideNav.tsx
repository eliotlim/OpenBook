import {Drawer} from '@/components';
import {useHud, useNavigation} from '@/providers';
import ColorSchemeMenu from '@/components/ColorSchemeMenu';
import AboutDialog from '@/components/AboutDialog';
import TrashDialog from '@/components/TrashDialog';
import WorkspaceSelectMenu from '@/components/WorkspaceSelectMenu';
import SettingsButton from '@/components/SettingsButton';
import WorkspaceNavigationTree from '@/components/WorkspaceNavigationTree';
import CommandToggle from '@/components/CommandToggle';

export default function SideNav() {
  const {hud} = useHud();
  // On desktop the workspace switcher lives in the titlebar instead.
  const {inWindowTabs} = useNavigation();
  return (
    <Drawer open={hud.sideNav.open} docked={hud.sideNav.docked}>
      <div className="flex h-full flex-col">
        {!inWindowTabs && (
          <div className="px-2 pt-2">
            <WorkspaceSelectMenu />
          </div>
        )}
        <div className="flex flex-col gap-0.5 px-2 pb-1 pt-1">
          <CommandToggle />
          <SettingsButton />
        </div>
        <div className="mt-1 min-h-0 flex-1 overflow-hidden">
          <WorkspaceNavigationTree />
        </div>
        <div className="flex items-center justify-between border-t border-border/60 px-2 py-1.5">
          <AboutDialog />
          <div className="flex items-center gap-0.5">
            <TrashDialog />
            <ColorSchemeMenu />
          </div>
        </div>
      </div>
    </Drawer>
  );
}
