import {NavBar, SideNav} from '@/components';
import {CommandMenu} from '@/components/CommandMenu';
import GlobalShortcuts from '@/components/GlobalShortcuts';
import WindowTitle from '@/components/WindowTitle';
import TemplateGallery from '@/components/TemplateGallery';
import {AiSearchDialog} from '@/components/AiSearchDialog';
import {SplitPane} from '@/components/SplitPane';
import PluginBoot from '@/components/PluginBoot';
import {AiBridgeHost} from '@/components/AiBridgeHost';
import {PageAppearanceHost} from '@/components/PageAppearanceHost';
import Settings from '@/components/Settings';
import PresentMode from '@/components/PresentMode';
import EmojiPickerHost from '@/components/EmojiPickerHost';
import TitlebarTabs from '@/components/TitlebarTabs';
import WindowControls from '@/components/WindowControls';
import {useHud} from '@/providers';
import {ConfirmProvider} from '@/providers/ConfirmProvider';

export interface DefaultLayoutProps {
  children: React.ReactNode;
}

export default function DefaultLayout(props: DefaultLayoutProps) {
  const {hud} = useHud();
  // The page binds straight into the sidebar (no left inset) only while it is
  // pinned open — i.e. taking layout space. Undocked/closed leaves the inset.
  const sidebarPinned = hud.sideNav.docked && hud.sideNav.open;
  return (
    <ConfirmProvider>
      <div className="flex h-screen flex-col">
        {/* The titlebar strip (desktop): the in-window tab bar, plus frameless
            window controls on the right (Windows/Linux). Its height comes from
            `--ob-titlebar-height`, which the desktop shell sets; it is unset (0)
            on the web, so the web layout is unchanged. */}
        <div className="flex shrink-0 bg-sheet-1 print:hidden" style={{height: 'var(--ob-titlebar-height, 0px)'}}>
          <div className="min-w-0 flex-1">
            <TitlebarTabs />
          </div>
          <WindowControls />
        </div>
        <div className="flex min-h-0 flex-1 flex-row items-stretch overflow-hidden">
          <GlobalShortcuts/>
          <PluginBoot/>
          <WindowTitle/>
          <CommandMenu/>
          <Settings/>
          <PresentMode/>
          <TemplateGallery/>
          <AiSearchDialog/>
          <AiBridgeHost/>
          <PageAppearanceHost/>
          <EmojiPickerHost/>
          <SideNav/>
          {/* The book cover: the primary page and the split pane sit on it as
              rounded "notebook" sheets, inset from the window (no left inset
              while the sidebar is pinned). */}
          <div
            className="ob-desk flex min-h-0 w-full min-w-0 flex-row overflow-hidden"
            data-sidebar-pinned={sidebarPinned}
          >
            <div className="ob-sheet flex min-h-0 w-full min-w-0 flex-col">
              <NavBar/>
              {/* The document area owns scrolling, one ScrollArea per pane, so the
                  split panes can scroll independently. */}
              <main className="min-h-0 flex-1 overflow-hidden">
                {props.children}
              </main>
            </div>
            <SplitPane/>
          </div>
        </div>
      </div>
    </ConfirmProvider>
  );
}
