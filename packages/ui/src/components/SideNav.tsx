import {Drawer} from '@/components';
import HomeButton from '@/components/HomeButton';
import {useHud, useNavigation, usePlatformCapabilities} from '@/providers';
import ProfileMenu from '@/components/ProfileMenu';
import TrashDialog from '@/components/TrashDialog';
import LibrarySelectMenu from '@/components/LibrarySelectMenu';
import SettingsButton from '@/components/SettingsButton';
import FavoritesNav from '@/components/FavoritesNav';
import {SuggestedNav} from '@/components/SidebarSections';
import LibraryNavigationTree from '@/components/LibraryNavigationTree';
import CommandToggle from '@/components/CommandToggle';
import OnboardingNudge from '@/components/OnboardingNudge';

export default function SideNav() {
  const {hud} = useHud();
  // On desktop the library switcher lives in the titlebar instead.
  const {inWindowTabs} = useNavigation();
  // The sidecar-served LAN UI renders for a network guest: drop the account
  // footer (ProfileMenu self-hides too) and its bordered strip — sign-in is
  // unsupported over a plain-LAN origin (STAB-9).
  const {servedSameOrigin} = usePlatformCapabilities();
  return (
    <Drawer open={hud.sideNav.open} docked={hud.sideNav.docked}>
      <div className="flex h-full flex-col">
        {!inWindowTabs && (
          <div className="px-3 pt-2">
            <LibrarySelectMenu />
          </div>
        )}
        <div className="flex flex-col gap-0.5 px-3 pb-1.5 pt-1">
          <HomeButton />
          <CommandToggle />
          <SettingsButton />
          <TrashDialog />
        </div>
        {/* Separate the action buttons from the navigable content below. */}
        <div className="mx-3 border-t border-border/60" />
        {/* Favourites + recent — scrollable, so a long list never crowds out the
            page tree (which keeps the remaining space). */}
        <div className="min-h-0 max-h-[42%] shrink-0 overflow-y-auto py-1">
          <FavoritesNav />
          <SuggestedNav />
        </div>
        <div className="mt-1 min-h-0 flex-1 overflow-hidden border-t border-border/40">
          <LibraryNavigationTree />
        </div>
        <OnboardingNudge />
        {!servedSameOrigin && (
          <div className="flex items-center border-t border-border/60 px-3 py-1.5">
            <ProfileMenu />
          </div>
        )}
      </div>
    </Drawer>
  );
}
