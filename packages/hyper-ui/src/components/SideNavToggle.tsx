import {Button} from '@/components/ui/button';
import {DoubleArrowLeftIcon, HamburgerMenuIcon} from '@radix-ui/react-icons';
import {useSideNav} from '@/providers';

export default function SideNavToggle() {
  const {sideNav, setSideNav} = useSideNav();
  return (
    <Button
      variant="ghost"
      className="px-3 py-1"
      onClick={() => setSideNav({...sideNav, docked: !sideNav.docked, open: !sideNav.docked})}
    >
      {sideNav.docked ? <DoubleArrowLeftIcon className="h-4 w-4"/> : <HamburgerMenuIcon className="h-4 w-4"/>}
    </Button>
  );
}
