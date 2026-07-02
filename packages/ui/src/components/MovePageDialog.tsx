import {useEffect, useMemo, useState} from 'react';
import type {PageMeta} from '@book.dev/sdk';
import {ArrowUpToLine} from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {useNavigation, useTranslation} from '@/providers';
import {onMovePageRequest} from '@/lib/pageActions';
import {readPageIcon} from '@/lib/pageIcon';
import {PageIcon} from '@/components/PageIcon';
import {t as bareT} from '@/i18n';

const displayName = (name: string | null): string => (name && name.trim().length > 0 ? name : bareT('common.untitled'));

/** The page's ancestor chain as "Parent / Child" — a disambiguating subtitle. */
function pathLabel(page: PageMeta, byId: Map<string, PageMeta>): string {
  const parts: string[] = [];
  let cur = page.parentId ? byId.get(page.parentId) : undefined;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(displayName(cur.name));
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join(' / ');
}

/**
 * The "Move to…" picker: a searchable destination list (top level + every page
 * that isn't the moved page or one of its descendants). The keyboard/menu
 * counterpart to the sidebar's drag-to-move — opened via
 * {@link requestMovePage} from any context menu. Mounted once in DefaultLayout.
 */
export default function MovePageDialog() {
  const {t} = useTranslation();
  const {pages, movePage} = useNavigation();
  const [movingId, setMovingId] = useState<string | null>(null);

  useEffect(() => onMovePageRequest(setMovingId), []);

  const byId = useMemo(() => new Map(pages.map((p) => [p.id, p] as const)), [pages]);

  // Destinations: every page except the moved one and its subtree (a page
  // cannot become its own descendant).
  const candidates = useMemo(() => {
    if (!movingId) return [];
    const childrenOf = new Map<string | null, PageMeta[]>();
    for (const p of pages) {
      const list = childrenOf.get(p.parentId) ?? [];
      list.push(p);
      childrenOf.set(p.parentId, list);
    }
    const excluded = new Set<string>([movingId]);
    const queue = [movingId];
    while (queue.length > 0) {
      const next = queue.pop()!;
      for (const child of childrenOf.get(next) ?? []) {
        if (!excluded.has(child.id)) {
          excluded.add(child.id);
          queue.push(child.id);
        }
      }
    }
    return pages.filter((p) => !excluded.has(p.id));
  }, [pages, movingId]);

  const moving = movingId ? byId.get(movingId) : undefined;

  const moveTo = (parentId: string | null): void => {
    if (!movingId) return;
    // Append to the end of the destination's sibling group (the page list is
    // already in sidebar order, so the existing order is preserved).
    const siblings = pages.filter((p) => p.parentId === parentId && p.id !== movingId).map((p) => p.id);
    void movePage(movingId, parentId, [...siblings, movingId]);
    setMovingId(null);
  };

  return (
    <CommandDialog
      open={movingId !== null}
      onOpenChange={(open) => {
        if (!open) setMovingId(null);
      }}
      title={t('move.title')}
      description={t('move.placeholder')}
    >
      <CommandInput placeholder={t('move.placeholder')} />
      <CommandList>
        <CommandEmpty>{t('move.noResults')}</CommandEmpty>
        <CommandGroup heading={moving ? t('move.heading', {page: displayName(moving.name)}) : t('move.title')}>
          {moving?.parentId != null && (
            <CommandItem value="__top__" onSelect={() => moveTo(null)}>
              <ArrowUpToLine className="mr-2 h-4 w-4" />
              {t('move.topLevel')}
            </CommandItem>
          )}
          {candidates.map((p) => (
            <CommandItem
              key={p.id}
              // The page name isn't unique — the ancestor path + id keep cmdk
              // values distinct (and let a typed parent name match).
              value={`${displayName(p.name)} ${pathLabel(p, byId)} ${p.id}`}
              disabled={p.id === moving?.parentId}
              onSelect={() => moveTo(p.id)}
            >
              <PageIcon value={readPageIcon(p.id)} className="mr-2 text-base leading-none" />
              <span className="min-w-0 truncate">{displayName(p.name)}</span>
              {pathLabel(p, byId) && (
                <span className="ml-2 min-w-0 truncate text-xs text-muted-foreground">{pathLabel(p, byId)}</span>
              )}
              {p.id === moving?.parentId && (
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{t('move.currentLocation')}</span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
