import {Drawer} from '@/components';
import HomeButton from '@/components/HomeButton';
import {useHud, useNavigation} from '@/providers';
import ProfileMenu from '@/components/ProfileMenu';
import TrashDialog from '@/components/TrashDialog';
import WorkspaceSelectMenu from '@/components/WorkspaceSelectMenu';
import SettingsButton from '@/components/SettingsButton';
import FavoritesNav from '@/components/FavoritesNav';
import {RecentsNav, SuggestedNav} from '@/components/SidebarSections';
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
          <HomeButton />
          <CommandToggle />
          <SettingsButton />
          <TrashDialog />
        </div>
        <FavoritesNav />
        <RecentsNav />
        <SuggestedNav />
        <div className="mt-1 min-h-0 flex-1 overflow-hidden">
          <WorkspaceNavigationTree />
        </div>
        <div className="flex items-center border-t border-border/60 px-2 py-1.5">
          <ProfileMenu />
        </div>
      </div>
    </Drawer>
  );
}
