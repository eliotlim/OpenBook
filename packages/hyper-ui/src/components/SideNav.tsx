import {Drawer} from '@/components';
import {ColorMode, useSideNav, useTheme} from '@/providers';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import {Button} from '@/components/ui/button';
import {ChevronDownIcon, GlobeIcon, ShadowIcon, ShadowNoneIcon} from '@radix-ui/react-icons';
import {Badge} from '@/components/ui/badge';
import {SunIcon} from "@heroicons/react/24/outline";

export default function SideNav() {
  const {mode, setMode} = useTheme();
  const {sideNav} = useSideNav();
  return (
    <>
      <Drawer
        open={sideNav.open}
        docked={sideNav.docked}
      >
        <div
          className="flex flex-col h-full"
        >
          <div
            className="flex flex-col gap-y-2 justify-start"
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                >
                  Workspaces
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-56">
                <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
                <DropdownMenuSeparator/>
                <DropdownMenuItem>
                  <div className="flex items-center h-5">
                    <GlobeIcon className="h-8 w-8"/>
                  </div>
                  <div className="ml-2 text-sm">
                    <label htmlFor="helper-checkbox-1" className="font-medium">
                      <div>Workspace 1 <Badge variant="outline" className="px-1">Cloud</Badge></div>
                      <p id="helper-checkbox-text-1" className="text-xs font-normal">https://workspace1.hyper.app</p>
                    </label>
                  </div>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div
            className="flex flex-col align-self-end"
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost">
                  {(() => {
                    switch (mode) {
                      case "light":
                        return <><SunIcon className="w-4 h-4 mr-2"/> Light Mode</>;
                      case "dark":
                        return <><ShadowIcon className="w-4 h-4 mr-2"/> Dark Mode</>;
                      case "system":
                        return <><ShadowNoneIcon className="w-4 h-4 mr-2"/> System Mode</>;
                    }
                  })()}
                  <ChevronDownIcon className="w-4 h-4 ml-2"/>
                </Button>
              </DropdownMenuTrigger>
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
          </div>
        </div>
      </Drawer>
    </>
  );
}