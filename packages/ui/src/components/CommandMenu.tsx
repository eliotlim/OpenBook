import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import React from 'react';
import type {AiSearchResult, PageMeta} from '@book.dev/sdk';
import {FileText} from 'lucide-react';
import {useData} from '@/data';
import {useHud, useNavigation, useTranslation} from '@/providers';
import {useAppCommands, type AppCommand, type CommandGroup as CmdGroup} from '@/components/useAppCommands';
import {formatShortcut} from '@/lib/shortcuts';
import {readPageIcon} from '@/lib/pageIcon';
import {PageIcon} from '@/components/PageIcon';
import type {PageLinkResult} from '@/lib/pageLinks';
import {readFavorites, subscribeFavorites} from '@/lib/favorites';
import {readRecents, subscribeRecents} from '@/lib/recents';
import {pagePathLabel} from '@/lib/pagePath';
import {featureShown, isAiFeature, readFeatureVisibility} from '@/lib/aiFeatures';
import {t} from '@/i18n';

const displayName = (name: string | null): string =>
  name && name.trim().length > 0 ? name : t('common.untitled');

/** Command groups in display order, with their localised headings. */
const GROUP_ORDER: CmdGroup[] = ['create', 'view', 'navigation', 'app'];

// The palette is a unified search surface (IA-1): page titles are matched
// client-side by cmdk, while database ROWS and content SNIPPETS come from async
// searches. Fire those only once the query has some substance, so a single
// keystroke doesn't list every table or hit the note index.
const MIN_ASYNC_QUERY = 2;

/** Async search results, tagged with the query they answer so cmdk only surfaces
 *  them while they still match what's typed (stale results self-hide on the next
 *  keystroke until the refetch lands). */
interface AsyncResults {
  query: string;
  rows: PageLinkResult[];
  notes: AiSearchResult[];
}

export function CommandMenu() {
  const {hud, setHud} = useHud();
  const {pages, currentPageId, selectPage, selectPageAtBlock, searchRows, setPageHint} = useNavigation();
  const {t} = useTranslation();
  const client = useData();
  const commands = useAppCommands();
  const open = hud.commandPalette.open;

  // Controlled query so AI features set to "enabled" surface only while the
  // user is searching (disabled ones never; recommended ones always).
  const [search, setSearch] = React.useState('');
  React.useEffect(() => {
    if (!open) setSearch('');
  }, [open]);
  const searching = search.trim().length > 0;
  // Every query token must be a substring of a `searchOnly` command's
  // title/keywords for it to surface. These commands (export-*, settings-*)
  // carry a large aggregated keyword blob, and cmdk's fuzzy scorer will scatter-
  // match that blob against arbitrary content queries with a vanishingly small
  // (but > 0, so "shown") score — e.g. a settings-tab command matching
  // "migration rollback". A weak match like that then wins the palette's default
  // selection during the ~180ms gap before the real async note/row results load,
  // and cmdk keeps that stale selection even once the exact content hit arrives —
  // so Enter opens Settings instead of the page. Requiring a genuine substring
  // hit keeps real settings/export search working (agents, mcp, usage, pdf, …)
  // while never surfacing these commands as noise for a content query.
  const searchTokens = React.useMemo(
    () => search.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [search],
  );
  const searchOnlyMatches = React.useCallback(
    (c: AppCommand): boolean => {
      if (searchTokens.length === 0) return false;
      const haystack = `${c.title} ${c.keywords ?? ''}`.toLowerCase();
      return searchTokens.every((tok) => haystack.includes(tok));
    },
    [searchTokens],
  );
  const visibleCommands = React.useMemo(
    () =>
      commands.filter(
        (c) =>
          (!isAiFeature(c.id) || featureShown(readFeatureVisibility(c.id), searching)) &&
          (!c.searchOnly || searchOnlyMatches(c)),
      ),
    [commands, searching, searchOnlyMatches],
  );

  // ── Unified search: database rows + content snippets ────────────────────────
  // Rows (searchRows) work on every transport. Content snippets (client.aiSearch,
  // the engine-independent BM25 index — never gated by AI-feature visibility, so
  // lexical search is always available) return block-anchored hits on BOTH
  // transports: the hosted server and the in-webview local client, which runs the
  // same BM25 index over its embedded PGlite (Epic 3.1) — so the pure-web build
  // gets content search too, not just page/row matches.
  const [async_, setAsync] = React.useState<AsyncResults>({query: '', rows: [], notes: []});
  const reqRef = React.useRef(0);
  React.useEffect(() => {
    const q = search.trim();
    if (!open || q.length < MIN_ASYNC_QUERY) {
      setAsync({query: '', rows: [], notes: []});
      return;
    }
    const seq = ++reqRef.current;
    const timer = setTimeout(() => {
      void Promise.allSettled([searchRows(q, 6), client.aiSearch(q, 6)]).then(([rowsRes, notesRes]) => {
        if (seq !== reqRef.current) return; // a newer keystroke superseded this
        setAsync({
          query: q,
          rows: rowsRes.status === 'fulfilled' ? rowsRes.value : [],
          notes: notesRes.status === 'fulfilled' ? notesRes.value.results : [],
        });
      });
    }, 180);
    return () => clearTimeout(timer);
  }, [search, open, searchRows, client]);

  // Favourites + recents live in localStorage; bump on change so the palette
  // reflects a pin/visit made while it's open.
  const [version, setVersion] = React.useState(0);
  React.useEffect(() => subscribeFavorites(() => setVersion((v) => v + 1)), []);
  React.useEffect(() => subscribeRecents(() => setVersion((v) => v + 1)), []);

  const setOpen = React.useCallback(
    (open: boolean) => {
      setHud((draft) => {
        draft.commandPalette.open = open;
        return draft;
      });
    },
    [setHud],
  );

  const run = React.useCallback(
    (action: () => void) => {
      action();
      setOpen(false);
    },
    [setOpen],
  );

  const byId = React.useMemo(() => new Map(pages.map((p) => [p.id, p] as const)), [pages]);
  // Resolve stored id lists to live pages (dropping any since deleted).
  const resolve = React.useCallback(
    (ids: string[]): PageMeta[] => ids.map((id) => byId.get(id)).filter((p): p is PageMeta => !!p),
    [byId],
  );
  // `version` participates so a pin/visit re-derives these lists.
  const favorites = React.useMemo(() => {
    void version;
    return resolve(readFavorites());
  }, [resolve, version]);
  const recents = React.useMemo(() => {
    void version;
    return resolve(readRecents())
      .filter((p) => p.id !== currentPageId)
      .slice(0, 6);
  }, [resolve, version, currentPageId]);

  const groupHeading: Record<CmdGroup, string> = {
    create: t('command.groupCreate'),
    view: t('command.groupView'),
    navigation: t('command.groupNavigation'),
    app: t('command.groupApp'),
  };

  // Names aren't unique: the ancestor path disambiguates same-named rows (and
  // joins the cmdk value so typing a parent's name finds the right child).
  const pageItem = (page: PageMeta, scope: string) => {
    const path = pagePathLabel(page, byId);
    return (
      <CommandItem
        key={`${scope}:${page.id}`}
        value={`${displayName(page.name)} ${path} ${page.id} ${scope}`}
        onSelect={() => run(() => selectPage(page.id))}
      >
        <PageIcon
          value={readPageIcon(page.id)}
          className="mr-2 inline-flex h-4 w-4 shrink-0 items-center justify-center text-center text-sm leading-none"
        />
        <span className="truncate">{displayName(page.name)}</span>
        {path && <span className="ml-2 min-w-0 truncate text-xs text-muted-foreground">{path}</span>}
        {page.id === currentPageId && (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{t('command.current')}</span>
        )}
      </CommandItem>
    );
  };

  // Async rows/snippets already matched server-side, but cmdk still filters every
  // item by its `value`. Prefix the value with the query the results answer so
  // cmdk keeps them (a snippet whose body — not its title — matched would
  // otherwise be filtered out), and they self-hide the moment the query moves on.
  const showAsync = async_.query.length >= MIN_ASYNC_QUERY;

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title={t('command.title')} description={t('command.placeholder')}>
      <CommandInput placeholder={t('command.placeholder')} value={search} onValueChange={setSearch} />
      <CommandList>
        <CommandEmpty>{t('command.noResults')}</CommandEmpty>
        {favorites.length > 0 && (
          <CommandGroup heading={t('command.groupFavorites')}>
            {favorites.map((page) => pageItem(page, 'favorite'))}
          </CommandGroup>
        )}
        {recents.length > 0 && (
          <CommandGroup heading={t('command.groupRecent')}>
            {recents.map((page) => pageItem(page, 'recent'))}
          </CommandGroup>
        )}
        <CommandGroup heading={t('command.pages')}>
          {pages.map((page) => pageItem(page, 'page'))}
          {pages.length === 0 && (
            <CommandItem disabled value="__no_pages__">
              <FileText className="mr-2 h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">{t('command.noPages')}</span>
            </CommandItem>
          )}
        </CommandGroup>
        {showAsync && async_.rows.length > 0 && (
          <CommandGroup heading={t('command.rows')}>
            {async_.rows.map((row) => (
              <CommandItem
                key={`row:${row.id}`}
                value={`${async_.query} row ${row.id}`}
                data-search-row
                onSelect={() =>
                  run(() => {
                    setPageHint(row.id, row.label);
                    selectPage(row.id);
                  })
                }
              >
                <PageIcon
                  value={row.icon || readPageIcon(row.id)}
                  className="mr-2 inline-flex h-4 w-4 shrink-0 items-center justify-center text-center text-sm leading-none"
                />
                <span className="truncate">{row.label}</span>
                {row.path && (
                  <span className="ml-2 min-w-0 truncate text-xs text-muted-foreground">{row.path}</span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {showAsync && async_.notes.length > 0 && (
          <CommandGroup heading={t('command.notes')}>
            {async_.notes.map((note) => (
              <CommandItem
                key={`note:${note.pageId}:${note.blockId ?? note.title}`}
                value={`${async_.query} note ${note.pageId} ${note.blockId ?? ''}`}
                data-search-snippet
                onSelect={() =>
                  run(() =>
                    // Land on the matched block when the hit carries one (block-native
                    // pages); otherwise just open the page (legacy / title-only hits).
                    note.blockId ? selectPageAtBlock(note.pageId, note.blockId) : selectPage(note.pageId),
                  )
                }
              >
                <PageIcon
                  value={readPageIcon(note.pageId)}
                  className="mr-2 mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center text-center text-sm leading-none"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{note.title}</span>
                  <span className="line-clamp-1 text-xs text-muted-foreground">{note.snippet}</span>
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {GROUP_ORDER.map((group) => {
          const items = visibleCommands.filter((c) => c.group === group);
          if (items.length === 0) return null;
          return (
            <React.Fragment key={group}>
              <CommandSeparator />
              <CommandGroup heading={groupHeading[group]}>
                {items.map((cmd: AppCommand) => {
                  const Icon = cmd.icon;
                  return (
                    <CommandItem
                      key={cmd.id}
                      value={`${cmd.title} ${cmd.keywords ?? ''}`}
                      disabled={cmd.disabled}
                      onSelect={() => run(cmd.run)}
                    >
                      <Icon className="mr-2 h-4 w-4 text-muted-foreground" />
                      <span className="truncate">{cmd.title}</span>
                      {cmd.shortcut && <CommandShortcut>{formatShortcut(cmd.shortcut)}</CommandShortcut>}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </React.Fragment>
          );
        })}
      </CommandList>
    </CommandDialog>
  );
}
