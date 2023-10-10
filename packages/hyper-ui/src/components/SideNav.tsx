import {
  Drawer,
  SettingsDialogContent
} from '@/components';
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
import {
  GearIcon,
  GlobeIcon,
  ShadowIcon,
  ShadowNoneIcon
} from '@radix-ui/react-icons';
import {Badge} from '@/components/ui/badge';
import {
  ChevronUpDownIcon, InformationCircleIcon,
  SunIcon
} from '@heroicons/react/24/outline';
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog';
import {ScrollArea} from '@/components/ui/scroll-area';

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
          className="flex flex-col flex-grow justify-between"
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
                  <ChevronUpDownIcon className="w-4 h-4"/>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-72 bg-sheet-2 text-sheet-2-foreground">
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
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="ghost" className="flex flex-grow justify-start">
                  <GearIcon className="w-4 h-4 mr-2"/>
                  Settings
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[800px] p-0">
                <SettingsDialogContent/>
              </DialogContent>
            </Dialog>
            <ScrollArea className={sideNav.docked ? "h-[calc(100vh-10rem)]" : "h-[calc(100vh-14rem)]"}>
              {[
                {
                  emoji: '🏠',
                  title: 'Home',
                },
                ...(new Array(40).fill(0).map((_, i) => ({
                  emoji: '📄',
                  title: `Untitled Page ${i + 1}`,
                }))),
              ].map((pageDetails) => (
                <Button
                  variant="ghost"
                  key={`breadcrumb-${pageDetails.title}`}
                  className="flex items-center gap-2 px-2 py-1"
                >
                  <span className="text-2xl">{pageDetails.emoji}</span>
                  <span>{pageDetails.title}</span>
                </Button>
              ))}
            </ScrollArea>
          </div>
          <div
            className="flex flex-row align-self-end"
          >
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="ghost" className="flex flex-grow gap-2">
                  <InformationCircleIcon className="h-4 w-4"/>
                  About
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                  <DialogTitle>About Hyper</DialogTitle>
                  <DialogDescription>
                    Hyper is a new way to make a space your own on the web.
                  </DialogDescription>
                </DialogHeader>
                <DialogDescription>
                  Doggo Ipsum woofers long bois, borkdrive puggo. Puggo wrinkler puggo, borkf long bois. Puggo long bois.
                </DialogDescription>
                <DialogFooter>
                  <Button variant="ghost">Learn more</Button>
                  <Button variant="ghost">Get support</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <DropdownMenu>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
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
          </div>
        </div>
      </Drawer>
    </>
  );
}