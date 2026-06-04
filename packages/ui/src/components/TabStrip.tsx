import {Columns2, Plus, X} from 'lucide-react';
import {useNavigation, type PaneState} from '@/providers';
import {activeTab, tabPageId} from '@/providers/tabsModel';
import {readPageIcon} from '@/lib/pageIcon';
import {cn} from '@/lib/utils';

/**
 * The tab bar for a single pane. Each tab shows the page's icon + title, can be
 * activated or closed, and a trailing `+` opens a fresh page in a new tab. The
 * strip belongs to its pane, so a split shows one strip over each side.
 */
export default function TabStrip({pane}: {pane: PaneState}) {
  const {panes, focusedPaneId, selectTab, closeTab, newTab, openInSplit, pageLabel} = useNavigation();
  const focused = pane.id === focusedPaneId;
  const canSplit = panes.length < 2;

  return (
    <div
      className={cn(
        'flex h-9 items-stretch gap-0.5 overflow-x-auto border-b border-border bg-background/60 px-1',
        'scrollbar-none',
      )}
      role="tablist"
    >
      {pane.tabs.map((tab) => {
        const pageId = tabPageId(tab);
        const active = tab.id === pane.activeTabId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            onMouseDown={() => selectTab(pane.id, tab.id)}
            className={cn(
              'group flex min-w-0 max-w-[200px] cursor-pointer items-center gap-1.5 rounded-t px-2 text-sm',
              'border-b-2 transition-colors',
              active
                ? cn('border-b-foreground/70 text-foreground', focused ? 'bg-accent/60' : 'bg-accent/30')
                : 'border-b-transparent text-muted-foreground hover:bg-accent/30 hover:text-foreground',
            )}
            title={pageLabel(pageId)}
          >
            <span className="shrink-0 text-[0.95em] leading-none">{readPageIcon(pageId)}</span>
            <span className="truncate">{pageLabel(pageId)}</span>
            <button
              onMouseDown={(e) => {
                e.stopPropagation();
                closeTab(pane.id, tab.id);
              }}
              className={cn(
                'ml-0.5 shrink-0 rounded p-0.5 text-muted-foreground/70 transition',
                'opacity-0 hover:bg-background hover:text-foreground group-hover:opacity-100',
                active && 'opacity-100',
              )}
              aria-label="Close tab"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <button
        onClick={() => void newTab(pane.id)}
        className="my-1 ml-0.5 flex shrink-0 items-center rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="New tab"
        title="New tab"
      >
        <Plus className="h-4 w-4" />
      </button>
      {canSplit && (
        <button
          onClick={() => openInSplit(tabPageId(activeTab(pane)))}
          className="my-1 flex shrink-0 items-center rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Split view"
          title="Open in split view"
        >
          <Columns2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
