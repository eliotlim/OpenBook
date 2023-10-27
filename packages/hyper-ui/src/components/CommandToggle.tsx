import {useHud} from "@/providers";
import {Button} from "@/components/ui/button";
import {MagnifyingGlassIcon} from "@radix-ui/react-icons";


export default function CommandToggle() {
  const {setHud} = useHud();
  return (
    <Button
      variant="ghost"
      className="flex flex-grow justify-start h-7"
      onClick={() => {
        setHud(draft => {
          draft.commandPalette.open = !draft.commandPalette.open;
          return draft;
        })
      }}
    >
      <MagnifyingGlassIcon className="w-4 h-4 mr-2"/>
      Search
    </Button>
  );
}
