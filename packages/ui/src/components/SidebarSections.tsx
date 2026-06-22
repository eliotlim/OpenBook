import {useEffect, useMemo, useState, type ReactNode} from 'react';
import type {PageMeta} from '@book.dev/sdk';
import {ChevronRight} from 'lucide-react';
import {ContextMenu, ContextMenuContent, ContextMenuTrigger} from '@/components/ui/context-menu';
import {PageMenuItems} from '@/components/PageContextMenu';
import {useNavigation, useTranslation} from '@/providers';
import {readPageIcon, subscribePageIcon} from '@/lib/pageIcon';
import {PageIcon} from '@/components/PageIcon';
import {readFavorites, subscribeFavorites} from '@/lib/favorites';
import {readRecents, subscribeRecents} from '@/lib/recents';
import {SIDEBAR_ACTIVE, SIDEBAR_HOVER} from '@/lib/sidebarStyles';
import {cn} from '@/lib/utils';
import {t as bareT} from '@/i18n';

/**
 * The sidebar's flat page sections — Recents (last visited, device-local) and
 * Suggested (recently edited elsewhere, e.g. by collaborators or in another
 * tab, that you haven't just been to). Each is a collapsible labelled group
 * above the page tree, sharing one header + row anatomy with Favorites so the
 * sidebar reads as a single structured surface.
 */

const SECTIONS_KEY = 'openbook.sidebar.sections';

const readSections = (): Record<string, boolean> => {
  try {
    const raw = localStorage.getItem(SECTIONS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
};

/** A collapsible labelled sidebar group. Open by default; state persists. */
export function SidebarSection({id, label, children}: {id: string; label: string; children: ReactNode}) {
  // Default open; localStorage is adopted post-mount (SSR-safe).
  const [open, setOpen] = useState(true);
  useEffect(() => {
    setOpen(readSections()[id] !== false);
  }, [id]);

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(SECTIONS_KEY, JSON.stringify({...readSections(), [id]: next}));
    } catch {
      // private mode / quota — collapse state just won't persist
    }
  };

  return (
    <div className="flex flex-col" data-sidebar-section={id}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="group/section flex w-full cursor-pointer items-center gap-1 px-3 pb-1 pt-1 text-left"
      >
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 transition-colors group-hover/section:text-muted-foreground">
          {label}
        </span>
        <ChevronRight
          className={cn(
            'h-3 w-3 text-muted-foreground/50 opacity-0 transition-all group-hover/section:opacity-100',
            open && 'rotate-90',
          )}
        />
      </button>
      {open && children}
    </div>
  );
}

const displayName = (name: string | null): string => (name && name.trim().length > 0 ? name : bareT('common.untitled'));

/** A flat page row: icon + name, selectable, with the shared page context menu. */
export function SidebarPageRow({page}: {page: PageMeta}) {
  const {currentPageId, selectPageInPane} = useNavigation();
  const selected = page.id === currentPageId;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onClick={() => selectPageInPane(page.id, 'primary')}
          className={cn(
            'mx-1 flex cursor-pointer items-center rounded-md py-1 pl-2 pr-1.5 text-sm text-foreground/75 transition-colors',
            SIDEBAR_HOVER,
            selected && cn(SIDEBAR_ACTIVE, 'font-medium'),
          )}
        >
          <PageIcon
            value={readPageIcon(page.id)}
            className="mr-2 h-4 w-4 shrink-0 text-center text-xs leading-4"
          />
          <span className="grow truncate">{displayName(page.name)}</span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <PageMenuItems pageId={page.id} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Re-render on localStorage-backed signals that React can't see. */
function useSidebarSignals(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => subscribeRecents(() => setVersion((v) => v + 1)), []);
  useEffect(() => subscribeFavorites(() => setVersion((v) => v + 1)), []);
  useEffect(() => subscribePageIcon(() => setVersion((v) => v + 1)), []);
  return version;
}

// (Recents lives in the command palette and on Home — a sidebar section of it
// proved too noisy; `readRecents` below only feeds the Suggested skip-list.)
const SKIP_RECENTS = 5;
const SHOWN_SUGGESTED = 4;

/**
 * Pages that changed recently but aren't in your recent trail — the "you
 * might be looking for this" shelf. Empty (and hidden) in a fresh workspace.
 */
export function SuggestedNav() {
  const {pages} = useNavigation();
  const {t} = useTranslation();
  const version = useSidebarSignals();

  const items = useMemo<PageMeta[]>(() => {
    void version;
    const skip = new Set([...readRecents().slice(0, SKIP_RECENTS), ...readFavorites()]);
    return [...pages]
      .filter((p) => !skip.has(p.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, SHOWN_SUGGESTED);
  }, [pages, version]);

  if (items.length === 0) return null;
  return (
    <SidebarSection id="suggested" label={t('nav.suggested')}>
      {items.map((page) => (
        <SidebarPageRow key={page.id} page={page} />
      ))}
    </SidebarSection>
  );
}
