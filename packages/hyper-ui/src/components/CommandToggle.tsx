import {useHud} from "@/providers";
import {Button} from "@/components/ui/button";
import {MagnifyingGlassIcon} from "@radix-ui/react-icons";


export default function CommandToggle() {
  const {hud, setHud} = useHud();
  return (
    <Button
      variant="ghost"
      className="flex flex-grow justify-start h-7"
      onClick={() => setHud({...hud, commandPalette: {...hud.commandPalette, open: !hud.commandPalette.open}})}
    >
      <MagnifyingGlassIcon className="w-4 h-4 mr-2"/>
      Search
    </Button>
  );
}
