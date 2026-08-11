import React, {useEffect, useMemo, useState} from 'react';
import {Check, ChevronDown, MoreHorizontal} from 'lucide-react';
import type {PageMeta} from '@book.dev/sdk';
import {useLibrary, useNavigation, useTranslation} from '@/providers';
import {readPageIcon, subscribePageIcon} from '@/lib/pageIcon';
import {PageIcon} from '@/components/PageIcon';
import {IconButton} from '@/components/ui/icon-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Past this many crumbs the middle of the chain collapses to a "…" menu
 * (`Root / … / Parent / Current`), so deep nesting never overflows the bar.
 */
const MAX_CRUMBS = 4;

/** One rendered slot in the crumb row: a page crumb, or the collapsed middle. */
type CrumbSlot = {kind: 'crumb'; id: string} | {kind: 'ellipsis'; ids: string[]};

export default function BreadcrumbCluster() {
  const {library} = useLibrary();
  const {pages, panes, currentPageId, pageLabel, selectPageInPane} = useNavigation();
  const {t} = useTranslation();
  // Icons live in localStorage; re-render when one changes so the crumb
  // updates the moment the user picks a new page icon.
  const [, setIconVersion] = useState(0);
  useEffect(() => subscribePageIcon(() => setIconVersion((v) => v + 1)), []);

  // The nav bar belongs to the *primary* (left) pane: clicking into the right
  // split pane focuses it, but the breadcrumb keeps tracking the main document
  // rather than following focus into the side pane.
  const primaryPageId = panes[0]?.pageId ?? currentPageId;

  // Crumb clicks act on the primary pane regardless of which pane has focus.
  const goToCrumb = (id: string): void => selectPageInPane(id, 'primary');

  const byId = useMemo(() => new Map(pages.map((p) => [p.id, p] as const)), [pages]);

  // Children per parent, preserving the page list's manual sidebar order
  // (server `position`), so crumb menus mirror the tree. A page whose parent
  // isn't in the list (deleted mid-flight) counts as top-level, matching the
  // sidebar's buildTree fallback. Database rows never appear (listPages
  // excludes them), same as the sidebar.
  const childrenOf = useMemo(() => {
    const map = new Map<string | null, PageMeta[]>();
    for (const p of pages) {
      const key = p.parentId && byId.has(p.parentId) ? p.parentId : null;
      const list = map.get(key);
      if (list) list.push(p);
      else map.set(key, [p]);
    }
    return map;
  }, [pages, byId]);

  // Walk parent links up from the primary page to build the ancestor path.
  const chain: string[] = [];
  if (primaryPageId) {
    let id: string | null = primaryPageId;
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      chain.unshift(id);
      id = byId.get(id)?.parentId ?? null;
    }
  }
  // Pages on the current path get a "you are here" check in the menus.
  const onPath = new Set(chain);

  // Deep chains collapse to `Root / … / Parent / Current`; the elided middle
  // stays reachable through the "…" menu.
  const slots: CrumbSlot[] =
    chain.length > MAX_CRUMBS
      ? [
        {kind: 'crumb', id: chain[0]},
        {kind: 'ellipsis', ids: chain.slice(1, -2)},
        {kind: 'crumb', id: chain[chain.length - 2]},
        {kind: 'crumb', id: chain[chain.length - 1]},
      ]
      : chain.map((id) => ({kind: 'crumb', id}) as const);

  /** The sibling/subpage lists behind a crumb's menu, or `null` for none. */
  const crumbMenu = (id: string): {siblings: PageMeta[]; children: PageMeta[]} | null => {
    const meta = byId.get(id);
    // Pseudo-pages (Home, side panes) and database-row pages have no place in
    // the page tree — their crumbs stay plain buttons.
    if (!meta) return null;
    const parentKey = meta.parentId && byId.has(meta.parentId) ? meta.parentId : null;
    const siblings = childrenOf.get(parentKey) ?? [];
    const children = childrenOf.get(id) ?? [];
    // "Siblings" is only worth a section when there's somewhere lateral to go.
    if (siblings.length <= 1 && children.length === 0) return null;
    return {siblings, children};
  };

  const menuItem = (id: string): React.ReactElement => {
    const here = onPath.has(id);
    return (
      <DropdownMenuItem key={id} onSelect={() => goToCrumb(id)} className="gap-2">
        <PageIcon value={readPageIcon(id)} className="shrink-0 text-[0.95em] leading-none" />
        <span className={`min-w-0 flex-1 truncate ${here ? 'font-medium' : ''}`}>{pageLabel(id)}</span>
        {here && <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      </DropdownMenuItem>
    );
  };

  const renderCrumb = (id: string, last: boolean): React.ReactElement => {
    const menu = crumbMenu(id);
    return (
      // A crumb is a hover group: the navigate button plus (when the page has
      // siblings or subpages) a chevron that opens the jump menu. The chevron
      // always reserves its width so hover-reveal never shifts the row.
      <span className={`group/crumb min-w-0 items-center ${last ? 'flex' : 'hidden sm:flex'}`}>
        <button
          type="button"
          onClick={() => goToCrumb(id)}
          className={cnCrumb(last)}
          title={pageLabel(id)}
          aria-current={last ? 'page' : undefined}
        >
          <PageIcon value={readPageIcon(id)} className="text-[0.95em] leading-none" />
          <span className="truncate">{pageLabel(id)}</span>
        </button>
        {menu && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                size="xs"
                type="button"
                aria-label={t('nav.crumbMenu', {page: pageLabel(id)})}
                className={cnChevron(last)}
              >
                <ChevronDown aria-hidden className="h-3.5 w-3.5" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-w-72">
              {menu.siblings.length > 1 && (
                <>
                  <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                    {t('nav.crumbSiblings')}
                  </DropdownMenuLabel>
                  {menu.siblings.map((p) => menuItem(p.id))}
                </>
              )}
              {menu.siblings.length > 1 && menu.children.length > 0 && <DropdownMenuSeparator />}
              {menu.children.length > 0 && (
                <>
                  <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                    {t('nav.crumbSubpages')}
                  </DropdownMenuLabel>
                  {menu.children.map((p) => menuItem(p.id))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </span>
    );
  };

  const renderEllipsis = (ids: string[]): React.ReactElement => (
    <span className="hidden shrink-0 items-center sm:flex">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('nav.crumbCollapsed')}
            title={t('nav.crumbCollapsed')}
            className="rounded px-1 py-1 text-muted-foreground/70 transition-colors hover:bg-hover hover:text-foreground data-[state=open]:bg-hover data-[state=open]:text-foreground"
          >
            <MoreHorizontal aria-hidden className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-72">
          {ids.map((id) => menuItem(id))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );

  return (
    // Phone widths show only the current-page crumb: the library name (often
    // a server URL) and ancestors don't fit, and an unshrinkable crumb row
    // collided with the save-status cluster on the right.
    <nav className="flex min-w-0 items-center text-sm" aria-label="Breadcrumb">
      <span className="hidden min-w-0 max-w-[180px] items-center gap-1.5 rounded px-1.5 py-0.5 text-foreground/75 sm:flex">
        <span className="shrink-0 text-[0.95em] leading-none">{library?.icon ?? '🗂️'}</span>
        <span className="truncate">{library?.name ?? 'Library'}</span>
      </span>
      {slots.map((slot, index) => {
        const last = index === slots.length - 1;
        return (
          <React.Fragment key={slot.kind === 'crumb' ? slot.id : 'ellipsis'}>
            <span className="mx-0.5 hidden shrink-0 text-muted-foreground/40 sm:inline">/</span>
            {slot.kind === 'crumb' ? renderCrumb(slot.id, last) : renderEllipsis(slot.ids)}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

const cnCrumb = (last: boolean): string =>
  `flex min-w-0 max-w-[200px] items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors hover:bg-hover ${
    last ? 'text-foreground' : 'text-foreground/60'
  }`;

// The jump-menu chevron: hidden until its crumb is hovered/focused (or the
// menu is open) on ancestor crumbs, always visible on the current page — the
// standing "explore from here" affordance and the touch entry point.
const cnChevron = (last: boolean): string =>
  `text-muted-foreground/70 transition-[opacity,background-color,color] focus-visible:opacity-100 data-[state=open]:bg-hover data-[state=open]:text-foreground data-[state=open]:opacity-100 ${
    last ? '' : 'opacity-0 group-hover/crumb:opacity-100 group-focus-within/crumb:opacity-100'
  }`;
