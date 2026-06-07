import {Button} from '@/components/ui/button';
import {DoubleArrowLeftIcon, HamburgerMenuIcon} from '@radix-ui/react-icons';
import {cn} from '@/lib/utils';
import {useHud} from '@/providers';

export default function SideNavToggle({className}: {className?: string}) {
  const {hud, setHud} = useHud();
  return (
    <Button
      variant="ghost"
      className={cn('px-3 py-1', className)}
      onClick={() => setHud((draft) => {
        draft.sideNav.open = !draft.sideNav.docked;
        draft.sideNav.docked = !draft.sideNav.docked;
        return draft;
      })}
    >
      {hud.sideNav.docked ? <DoubleArrowLeftIcon className="h-4 w-4"/> : <HamburgerMenuIcon className="h-4 w-4"/>}
    </Button>
  );
}
