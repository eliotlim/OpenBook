import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from "@/components/ui/tooltip";
import {Button} from "@/components/ui/button";
import {ChevronUpDownIcon, SunIcon} from "@heroicons/react/24/outline";
import {ShadowIcon, ShadowNoneIcon} from "@radix-ui/react-icons";
import {ColorMode, useTheme} from "@/providers";

export default function ColorSchemeMenu () {
  const {mode, setMode} = useTheme();

  return (
    <DropdownMenu>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="px-2">
                {(() => {
                  switch (mode) {
                    case 'light':
                      return <><SunIcon className="w-4 h-4"/></>;
                    case 'dark':
                      return <><ShadowIcon className="w-4 h-4"/></>;
                    case 'system':
                      return <><ShadowNoneIcon className="w-4 h-4"/></>;
                  }
                })()}
                <ChevronUpDownIcon className="w-4 h-4 ml-2"/>
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>
            {(() => {
              switch (mode) {
                case 'light':
                  return <>Light Mode</>;
                case 'dark':
                  return <>Dark Mode</>;
                case 'system':
                  return <>System Mode</>;
              }
            })()}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent className="w-56">
        <DropdownMenuLabel>Color Scheme</DropdownMenuLabel>
        <DropdownMenuSeparator/>
        <DropdownMenuRadioGroup value={mode} onValueChange={e => setMode(e as ColorMode)}>
          <DropdownMenuRadioItem value="light">Light Mode</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Dark Mode</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">System Mode</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}