import {Drawer} from '@/components';
import {useHud} from '@/providers';
import {ScrollArea} from '@/components/ui/scroll-area';
import ColorSchemeMenu from '@/components/ColorSchemeMenu';
import AboutDialog from '@/components/AboutDialog';
import WorkspaceSelectMenu from '@/components/WorkspaceSelectMenu';
import SettingsDialog from '@/components/SettingsDialog';
import WorkspaceNavigationTree from '@/components/WorkspaceNavigationTree';
import CommandToggle from "@/components/CommandToggle";

export default function SideNav() {
  const {hud} = useHud();
  const offset = 12;
  return (
    <>
      <Drawer
        open={hud.sideNav.open}
        docked={hud.sideNav.docked}
      >
        <div
          className="flex flex-col flex-grow justify-between"
        >
          <div
            className="flex flex-col gap-y-2 justify-start"
          >
            <WorkspaceSelectMenu/>
            <div className="flex flex-col gap-y-0.5 justify-start">
              <CommandToggle/>
              <SettingsDialog/>
            </div>
            <ScrollArea className={hud.sideNav.docked ? `h-[calc(100vh-${offset}rem)]` : `h-[calc(100vh-${offset+8}rem)]`}>
              <WorkspaceNavigationTree/>
            </ScrollArea>
          </div>
          <div
            className="flex flex-row align-self-end"
          >
            <AboutDialog/>
            <ColorSchemeMenu/>
          </div>
        </div>
      </Drawer>
    </>
  );
}