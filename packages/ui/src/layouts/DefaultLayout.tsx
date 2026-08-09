import {NavBar, SideNav} from '@/components';
import {CommandMenu} from '@/components/CommandMenu';
import GlobalShortcuts from '@/components/GlobalShortcuts';
import DragDropGuard from '@/components/DragDropGuard';
import WindowTitle from '@/components/WindowTitle';
import TemplateGallery from '@/components/TemplateGallery';
import ImportDialog from '@/components/ImportDialog';
import MovePageDialog from '@/components/MovePageDialog';
import {ToastHost} from '@/components/ui/toast';
import {TooltipProvider} from '@/components/ui/tooltip';
import {ShareDialogHost} from '@/components/ShareDialog';
import {SplitPane} from '@/components/SplitPane';
import PluginBoot from '@/components/PluginBoot';
import UpdateScheduler from '@/components/UpdateScheduler';
import {AiBridgeHost} from '@/components/AiBridgeHost';
import {AssetBridgeHost} from '@/components/AssetBridgeHost';
import {PageAppearanceHost} from '@/components/PageAppearanceHost';
import Settings from '@/components/Settings';
import PresentMode from '@/components/PresentMode';
import ImageLightbox from '@/components/ImageLightbox';
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
  const {currentPageId, inWindowTabs} = useNavigation();
  // The page binds straight into the sidebar (no left inset) only while it is
  // pinned open — i.e. taking layout space. Undocked/closed leaves the inset.
  const sidebarPinned = hud.sideNav.docked && hud.sideNav.open;
  const closeSidebar = (): void => setHud((draft) => {
    draft.sideNav.open = false;
    return draft;
  });
  // Dismiss the narrow drawer on first mount and after navigation. The CSS
  // breakpoint is authoritative about whether a docked preference takes space;
  // this only synchronises the open state for the overlay presentation.
  useEffect(() => {
    if (hud.sideNav.open && typeof window !== 'undefined' && window.innerWidth < 768) closeSidebar();
  }, [currentPageId]);
  useEffect(() => {
    if (!hud.sideNav.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && window.innerWidth < 768) closeSidebar();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [hud.sideNav.open, setHud]);
  return (
    // skipDelay 0 keeps the per-trigger delay so shortcut discovery stays a deliberate lingering hover (old per-trigger providers could never skip).
    <TooltipProvider delayDuration={350} skipDelayDuration={0}>
      <ConfirmProvider>
        {/* App root fills the viewport. On the desktop in-window-titlebar shell it
          carries the cover tint (`--sheet-1`, painted via `.ob-app-root[data-titlebar]`
          in index.css) so any region NOT covered by a page sheet — behind the
          overlay-titlebar glass / traffic-lights and at the window edges — shows
          the cover tint instead of the white `body`, keeping the notebook-cover
          feel continuous. Web leaves `data-titlebar` unset, so the root stays
          transparent and the web framing is unchanged. */}
        <div className="ob-app-root flex h-screen flex-col" data-titlebar={inWindowTabs}>
          {/* The titlebar strip (desktop): the in-window tab bar, plus frameless
            window controls on the right (Windows/Linux). Its height comes from
            `--ob-titlebar-height`, which the desktop shell sets; it is unset (0)
            on the web, so the web layout is unchanged. */}
          <div className="ob-accent-chrome flex shrink-0 bg-sheet-1 text-sheet-1-foreground print:hidden" style={{height: 'var(--ob-titlebar-height, 0px)'}}>
            <div className="min-w-0 flex-1">
              <TitlebarTabs />
            </div>
            <WindowControls />
          </div>
          {/* The cover row (sidebar + desk). With the desktop in-window titlebar
            it is pulled up 1px (`.ob-desk-row[data-titlebar]` in index.css) so
            the page sheet's top border rides into the titlebar's lower edge and
            the active tab can merge into it — the pull-up lives here (not on
            the desk) because this row clips its children, and the clip box
            must move with the border. */}
          <div
            className="ob-desk-row flex min-h-0 flex-1 flex-row items-stretch overflow-hidden"
            data-titlebar={inWindowTabs}
          >
            <GlobalShortcuts/>
            {/* Window-level guard: a file dropped outside the editor must not
              navigate the document to file://… (desktop `dragDropEnabled` is
              false, so WKWebView owns native drops). See DragDropGuard. */}
            <DragDropGuard/>
            <PluginBoot/>
            {/* Background self-update checks (desktop only — inert without the
              `updates` capability). Inside ConfirmProvider for the restart
              guard; toasts land in the ToastHost below. */}
            <UpdateScheduler/>
            <WindowTitle/>
            <CommandMenu/>
            <ShareDialogHost/>
            <Settings/>
            <PresentMode/>
            {/* Mounted AFTER PresentMode so, opened from a present-mode image, its
              portal stacks above the deck's z-50 Dialog (the lightbox uses z-60). */}
            <ImageLightbox/>
            <TemplateGallery/>
            <ImportDialog/>
            <MovePageDialog/>
            <ToastHost/>
            <AiBridgeHost/>
            <AssetBridgeHost/>
            <PageAppearanceHost/>
            <EmojiPickerHost/>
            <SideNav/>
            {/* Narrow drawer scrim: CSS owns the breakpoint, so it also covers
              a drawer opened from a persisted docked preference. Wide layouts
              hide it, leaving the desktop edge-hover peek unchanged. */}
            {hud.sideNav.open && (
              <div
                className="fixed inset-x-0 bottom-0 top-14 z-overlay bg-foreground/20 md:hidden"
                onClick={closeSidebar}
                data-sidebar-scrim
                aria-hidden
              />
            )}
            {/* The book cover: the primary page and the split pane sit on it as
              rounded "notebook" sheets, inset from the window (no left inset
              while the sidebar is pinned); the sheets stay fully rounded,
              bordered cards on both platforms. */}
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
    </TooltipProvider>
  );
}
