import {Plus, X} from 'lucide-react';
import {useNavigation} from '@/providers';
import {readPageIcon} from '@/lib/pageIcon';
import {cn} from '@/lib/utils';
import WorkspaceSelectMenu from '@/components/WorkspaceSelectMenu';
import SideNavToggle from '@/components/SideNavToggle';

/**
 * The in-window tab bar, drawn in the titlebar (Chrome/Arc style) on the
 * desktop. Tabs sit to the right of the macOS traffic lights; the empty regions
 * are `data-tauri-drag-region` so the window can still be dragged by them
 * (interactive elements — tabs, buttons — are not drag regions, so clicks work).
 *
 * Off the desktop (`inWindowTabs` false) this is just a draggable filler; the
 * titlebar strip collapses to 0 height on the web, so nothing shows.
 */
export default function TitlebarTabs() {
  const {inWindowTabs, tabs, activeTabId, selectTab, closeTab, newPageIn, pageLabel} = useNavigation();

  if (!inWindowTabs) {
    return <div data-tauri-drag-region className="h-full w-full" />;
  }

  const multiple = tabs.length > 1;

  return (
    <div className="flex h-full items-stretch select-none">
      {/* Leading inset past the window controls, draggable. macOS sets this to
          clear the traffic lights; elsewhere it is ~0 (controls aren't here). */}
      <div data-tauri-drag-region className="shrink-0" style={{width: 'var(--ob-titlebar-pad-left, 0px)'}} />

      {/* Desktop-only leading controls: the workspace switcher and the sidebar
          hide button live here (before the tabs) instead of in the sidebar /
          nav bar. Interactive, so not drag regions. */}
      <div className="flex shrink-0 items-center gap-0.5 pr-1">
        <WorkspaceSelectMenu variant="titlebar" />
        <SideNavToggle className="h-7 px-2" />
      </div>

      <div className="flex min-w-0 items-end gap-1 overflow-x-auto pb-1 scrollbar-none">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              onMouseDown={() => selectTab(tab.id)}
              title={pageLabel(tab.pageId)}
              className={cn(
                'group flex h-7 min-w-0 max-w-[200px] cursor-default items-center gap-1.5 rounded-md px-2 text-sm transition-colors',
                active
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-background/40 hover:text-foreground',
              )}
            >
              <span className="shrink-0 text-[0.95em] leading-none">{readPageIcon(tab.pageId)}</span>
              <span className="truncate">{pageLabel(tab.pageId)}</span>
              {multiple && (
                <button
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  aria-label="Close tab"
                  className={cn(
                    'ml-0.5 shrink-0 rounded p-0.5 text-muted-foreground/70 transition',
                    'opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100',
                    active && 'opacity-100',
                  )}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        })}
        <button
          onClick={() => void newPageIn('tab')}
          aria-label="New tab"
          title="New tab"
          className="mb-0.5 flex h-6 shrink-0 items-center rounded p-1 text-muted-foreground transition-colors hover:bg-background/50 hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* Remaining space, draggable. */}
      <div data-tauri-drag-region className="min-w-4 flex-1" />
    </div>
  );
}
