import {NavBar, SideNav} from '@/components';
import {CommandMenu} from '@/components/CommandMenu';
import Settings from '@/components/Settings';

export interface DefaultLayoutProps {
  children: React.ReactNode;
}

export default function DefaultLayout(props: DefaultLayoutProps) {
  return (
    <>
      <div className="flex flex-row items-stretch overflow-hidden">
        <CommandMenu/>
        <Settings/>
        <SideNav/>
        <div className="flex flex-col h-screen w-full min-w-0">
          <NavBar/>
          {/* The document area owns scrolling, one ScrollArea per pane, so the
              split panes can scroll independently. */}
          <main className="min-h-0 flex-1 overflow-hidden">
            {props.children}
          </main>
        </div>
      </div>
    </>
  );
}
