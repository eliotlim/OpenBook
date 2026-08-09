import {DoubleArrowLeftIcon, HamburgerMenuIcon} from '@radix-ui/react-icons';
import {cn} from '@/lib/utils';
import {SIDEBAR_PRESS} from '@/lib/sidebarStyles';
import {toggleSideNav} from '@/lib/hud';
import {useHud, useTranslation} from '@/providers';
import {IconButton} from '@/components/ui/icon-button';

export default function SideNavToggle({className}: {className?: string}) {
  const {hud, setHud} = useHud();
  const {t} = useTranslation();
  return (
    <>
      {/* Keep the hardcoded narrow size large enough for a practical touch target. */}
      <IconButton
        aria-label={t('nav.toggleSidebar')}
        className={cn(SIDEBAR_PRESS, 'md:hidden', 'h-9 w-9 md:h-8 md:w-8', className)}
        data-sidebar-toggle
        onClick={() => setHud((draft) => {
          toggleSideNav(draft, {narrow: true});
          return draft;
        })}
      >
        <HamburgerMenuIcon className="h-4 w-4" />
      </IconButton>
      <IconButton
        aria-label={t('nav.toggleSidebar')}
        className={cn(SIDEBAR_PRESS, 'hidden md:inline-flex', 'h-9 w-9 md:h-8 md:w-8', className)}
        data-sidebar-toggle
        onClick={() => setHud((draft) => {
          toggleSideNav(draft, {narrow: false});
          return draft;
        })}
      >
        {hud.sideNav.docked ? <DoubleArrowLeftIcon className="h-4 w-4"/> : <HamburgerMenuIcon className="h-4 w-4"/>}
      </IconButton>
    </>
  );
}
