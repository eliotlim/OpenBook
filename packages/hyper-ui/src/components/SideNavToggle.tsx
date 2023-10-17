import {Button} from '@/components/ui/button';
import {DoubleArrowLeftIcon, HamburgerMenuIcon} from '@radix-ui/react-icons';
import {useHud} from '@/providers';

export default function SideNavToggle() {
  const {hud, setHud} = useHud();
  return (
    <Button
      variant="ghost"
      className="px-3 py-1"
      onClick={() => setHud({...hud, sideNav: {docked: !hud.sideNav.docked, open: !hud.sideNav.docked}})}
    >
      {hud.sideNav.docked ? <DoubleArrowLeftIcon className="h-4 w-4"/> : <HamburgerMenuIcon className="h-4 w-4"/>}
    </Button>
  );
}
