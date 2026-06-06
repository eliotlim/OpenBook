import {NavBar, SideNav} from '@/components';
import {CommandMenu} from '@/components/CommandMenu';
import Settings from '@/components/Settings';
import TitlebarTabs from '@/components/TitlebarTabs';

export interface DefaultLayoutProps {
  children: React.ReactNode;
}

export default function DefaultLayout(props: DefaultLayoutProps) {
  return (
    <div className="flex h-screen flex-col">
      {/* The overlay-titlebar strip (desktop): hosts the in-window tab bar and
          sits level with the traffic lights. Its height comes from
          `--ob-titlebar-height`, which the desktop shell sets; it is unset (0)
          on the web, so the web layout is unchanged. */}
      <div className="shrink-0 bg-sheet-1" style={{height: 'var(--ob-titlebar-height, 0px)'}}>
        <TitlebarTabs />
      </div>
      <div className="flex min-h-0 flex-1 flex-row items-stretch overflow-hidden">
        <CommandMenu/>
        <Settings/>
        <SideNav/>
        <div className="flex min-h-0 w-full min-w-0 flex-col">
          <NavBar/>
          {/* The document area owns scrolling, one ScrollArea per pane, so the
              split panes can scroll independently. */}
          <main className="min-h-0 flex-1 overflow-hidden">
            {props.children}
          </main>
        </div>
      </div>
    </div>
  );
}
