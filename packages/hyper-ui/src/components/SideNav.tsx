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
import {
  GearIcon,
  GlobeIcon,
  ShadowIcon,
  ShadowNoneIcon
} from '@radix-ui/react-icons';
import {Badge} from '@/components/ui/badge';
import {
  ChevronUpDownIcon,
  SunIcon
} from '@heroicons/react/24/outline';
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription, DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog';
import {Label} from '@/components/ui/label';
import {Input} from '@/components/ui/input';
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
          className="flex flex-col h-full justify-between"
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
            <ScrollArea className="h-60">
              {[
                {
                  emoji: '🏠',
                  title: 'Home',
                },
                ...(new Array(20).fill(0).map((_, i) => ({
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
                <Button variant="ghost" className="flex-grow">
                  <GearIcon className="w-4 h-4 mr-2"/>
                  Settings
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                  <DialogTitle>Settings</DialogTitle>
                  <DialogDescription>
                    Make changes to your profile here.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid grid-cols-4 items-center gap-4">
                    <Label htmlFor="name" className="text-right">
                      Name
                    </Label>
                    <Input id="name" value="Pedro Duarte" className="col-span-3"/>
                  </div>
                  <div className="grid grid-cols-4 items-center gap-4">
                    <Label htmlFor="username" className="text-right">
                      Username
                    </Label>
                    <Input id="username" value="@peduarte" className="col-span-3"/>
                  </div>
                </div>
                <DialogFooter>
                  <Button type="submit">Save changes</Button>
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