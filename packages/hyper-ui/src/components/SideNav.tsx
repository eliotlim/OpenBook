import {Drawer} from '@/components';
import {ColorMode, useSideNav, useTheme} from '@/providers';
import {
  DropdownMenu,
  DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import {Button} from '@/components/ui/button';

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
          className="flex flex-col bg-background text-foreground h-full"
        >
          <div
            className="flex flex-col gap-y-2 justify-start"
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                >
                  Workspaces
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-56">
                <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem>
                  <div className="flex items-center h-5">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="w-6 h-6">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
                    </svg>
                  </div>
                  <div className="ml-2 text-sm">
                    <label htmlFor="helper-checkbox-1" className="font-medium">
                      <div>Workspace 1</div>
                      <p id="helper-checkbox-text-1" className="text-xs font-normal">https://workspace1.hyper.app</p>
                    </label>
                  </div>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div
            className="justify-end"
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">{`${mode} Mode`}</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-56">
                <DropdownMenuLabel>Color Scheme</DropdownMenuLabel>
                <DropdownMenuSeparator />
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