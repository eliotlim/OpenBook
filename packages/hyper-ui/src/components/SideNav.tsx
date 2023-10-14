import {Drawer} from '@/components';
import {useSideNav} from '@/providers';
import {ScrollArea} from '@/components/ui/scroll-area';
import ColorSchemeMenu from "@/components/ColorSchemeMenu";
import AboutDialog from "@/components/AboutDialog";
import WorkspaceSelectMenu from "@/components/WorkspaceSelectMenu";
import SettingsDialog from "@/components/SettingsDialog";
import WorkspaceNavigationTree from "@/components/WorkspaceNavigationTree";

export default function SideNav() {
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
            <WorkspaceSelectMenu/>
            <SettingsDialog/>
            <ScrollArea className={sideNav.docked ? 'h-[calc(100vh-10rem)]' : 'h-[calc(100vh-20rem)]'}>
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