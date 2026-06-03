import {GearIcon} from '@radix-ui/react-icons';
import {Button} from '@/components/ui/button';
import {useHud} from '@/providers';

/** Sidebar launcher that opens the settings surface (modal or fullscreen). */
export default function SettingsButton() {
  const {setHud} = useHud();
  return (
    <Button
      variant="ghost"
      className="flex h-7 flex-grow justify-start"
      onClick={() => setHud((draft) => {draft.settings.open = true; return draft;})}
    >
      <GearIcon className="mr-2 h-4 w-4" />
      Settings
    </Button>
  );
}
