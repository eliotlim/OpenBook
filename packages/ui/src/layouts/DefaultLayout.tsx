import {NavBar, SideNav} from '@/components';
import {CommandMenu} from '@/components/CommandMenu';
import Settings from '@/components/Settings';

export interface DefaultLayoutProps {
  children: React.ReactNode;
}

export default function DefaultLayout(props: DefaultLayoutProps) {
  return (
    <div className="flex h-screen flex-col">
      {/* Reserve a strip at the top for the macOS overlay titlebar — the native
          tab bar and traffic lights sit over it. The height comes from
          `--ob-titlebar-height`, which the desktop shell sets; it is unset (0)
          on the web, so the web layout is unchanged. */}
      <div
        data-tauri-drag-region
        className="shrink-0"
        style={{height: 'var(--ob-titlebar-height, 0px)'}}
      />
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
