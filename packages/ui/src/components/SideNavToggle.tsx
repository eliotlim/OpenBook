import {DoubleArrowLeftIcon, HamburgerMenuIcon} from '@radix-ui/react-icons';
import {cn} from '@/lib/utils';
import {SIDEBAR_PRESS} from '@/lib/sidebarStyles';
import {useHud, useTranslation} from '@/providers';
import {IconButton} from '@/components/ui/icon-button';

export default function SideNavToggle({className}: {className?: string}) {
  const {hud, setHud} = useHud();
  const {t} = useTranslation();
  return (
    <>
      <IconButton
        aria-label={t('nav.toggleSidebar')}
        className={cn(SIDEBAR_PRESS, 'md:hidden', className)}
        onClick={() => setHud((draft) => {
          draft.sideNav.open = !draft.sideNav.open;
          return draft;
        })}
      >
        <HamburgerMenuIcon className="h-4 w-4" />
      </IconButton>
      <IconButton
        aria-label={t('nav.toggleSidebar')}
        className={cn(SIDEBAR_PRESS, 'hidden md:inline-flex', className)}
        onClick={() => setHud((draft) => {
          draft.sideNav.open = !draft.sideNav.docked;
          draft.sideNav.docked = !draft.sideNav.docked;
          return draft;
        })}
      >
        {hud.sideNav.docked ? <DoubleArrowLeftIcon className="h-4 w-4"/> : <HamburgerMenuIcon className="h-4 w-4"/>}
      </IconButton>
    </>
  );
}
