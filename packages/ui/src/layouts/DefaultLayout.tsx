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
import {useEffect} from 'react';
import {useHud, useNavigation} from '@/providers';
import {ConfirmProvider} from '@/providers/ConfirmProvider';

export interface DefaultLayoutProps {
  children: React.ReactNode;
}

export default function DefaultLayout(props: DefaultLayoutProps) {
  const {hud, setHud} = useHud();
  const {currentPageId} = useNavigation();
  // The page binds straight into the sidebar (no left inset) only while it is
  // pinned open — i.e. taking layout space. Undocked/closed leaves the inset.
  const sidebarPinned = hud.sideNav.docked && hud.sideNav.open;
  // The sidebar floats as an overlay when open-but-undocked (the narrow-screen
  // state the hamburger produces). A backdrop + close-on-navigate make it read
  // like a mobile drawer; both are gated below `md` so wide layouts never see
  // them. (The desktop edge-hover overlay stays a no-backdrop peek.)
  const sidebarOverlay = hud.sideNav.open && !hud.sideNav.docked;
  const closeSidebar = (): void => setHud((draft) => {
    draft.sideNav.open = false;
    return draft;
  });
  // Dismiss the overlay when navigating on a narrow screen, so the freshly
  // opened page isn't left hidden behind it.
  useEffect(() => {
    // Keyed on navigation only (sidebarOverlay/closeSidebar are read fresh each
    // commit). The project's eslint has no exhaustive-deps rule, so no disable.
    if (sidebarOverlay && typeof window !== 'undefined' && window.innerWidth < 768) closeSidebar();
  }, [currentPageId]);
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
          {/* Mobile drawer scrim: dim the page behind the floating sidebar and
              dismiss it on tap. `md:hidden` keeps it off wide layouts entirely,
              so the desktop edge-hover peek is unaffected. Sits below the
              sidebar's own z-50, above the page; starts below the nav bar so the
              hamburger stays tappable. */}
          {sidebarOverlay && (
            <div
              className="fixed inset-x-0 bottom-0 top-14 z-40 bg-foreground/20 md:hidden"
              onClick={closeSidebar}
              aria-hidden
            />
          )}
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
