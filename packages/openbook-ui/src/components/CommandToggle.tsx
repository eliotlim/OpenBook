import {useHud} from '@/providers';
import {Button} from '@/components/ui/button';
import {MagnifyingGlassIcon} from '@radix-ui/react-icons';
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from '@/components/ui/tooltip';


export default function CommandToggle() {
  const {setHud} = useHud();
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            className="flex flex-grow justify-start h-7"
            onClick={() => {
              setHud(draft => {
                draft.commandPalette.open = !draft.commandPalette.open;
                return draft;
              });
            }}
          >
            <MagnifyingGlassIcon className="w-4 h-4 mr-2"/>
            Search
          </Button>
        </TooltipTrigger>
        <TooltipContent side={'right'} className="flex flex-col bg-background">
          <span className="text-foreground">
            Search or perform an action
          </span>
          <span className="text-muted-foreground">
            (Ctrl+K)
          </span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
