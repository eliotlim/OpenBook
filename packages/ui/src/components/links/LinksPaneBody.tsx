import {useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent} from 'react';
import {Link2, Network, Search} from 'lucide-react';
import type {PageMeta} from '@book.dev/sdk';
import {snapshotText} from '@book.dev/sdk';
import {useData} from '@/data';
import {getLinksTarget, subscribeLinksPane} from '@/lib/linksPane';
import {setGraphTarget} from '@/lib/graphPane';
import {GRAPH_PANE_ID} from '@/lib/homePage';
import {IconButton} from '@/components/ui/icon-button';
import {useNavigation, useTranslation} from '@/providers';
import {hydratePageIcons, readPageIcon, subscribePageIcon} from '@/lib/pageIcon';
import {PageIcon} from '@/components/PageIcon';
import {filterUnlinkedMentions, toSnippet, type MentionRow} from './linksFilter';
import {ContextMenu, ContextMenuContent, ContextMenuTrigger} from '@/components/ui/context-menu';
import {PageMenuItems} from '@/components/PageContextMenu';
import {MENU_WIDTH_MD} from '@/components/ui/menu-components';

/** A backlink row: the linking page plus a short text preview of its content. */
interface BacklinkRow {
  page: PageMeta;
  snippet: string;
}

/**
 * How long to wait after a page-set ping before refetching. The
 * `subscribePages` channel fires per keystroke elsewhere; coalescing bursts
 * keeps the pane from stampeding `listBacklinks` / `aiSearch`.
 */
const REFRESH_DEBOUNCE_MS = 250;

/**
 * Fetch a page's backlinks and, for each, a short content preview. Kept live:
 * refetches whenever the page set changes (a mention added/removed anywhere)
 * and when the pane is re-opened (the bridge's revision bump). Backlinks have no
 * SSE channel of their own — the page-list subscription is the data ping, the
 * same pattern the header chip already used.
 */
function useBacklinks(pageId: string | null, revision: number): {rows: BacklinkRow[]; loading: boolean} {
  const client = useData();
  const [rows, setRows] = useState<BacklinkRow[]>([]);
  const [loading, setLoading] = useState(false);
  // Monotonic request id: a slow in-flight fetch that resolves after a newer
  // refresh started must not clobber the fresher result.
  const reqId = useRef(0);
  // Snippet cache keyed by page id + `updatedAt` so an unchanged backlink skips
  // its per-page `getPage` on every re-ping. Pruned to the live set each refresh.
  const snippetCache = useRef(new Map<string, string>());

  const refresh = useCallback(() => {
    const myReq = ++reqId.current;
    if (!pageId) {
      setRows([]);
      return;
    }
    setLoading(true);
    void client
      .listBacklinks(pageId)
      .then(async (pages) => {
        if (myReq !== reqId.current) return; // superseded
        hydratePageIcons(pages); // backlinks can be DB rows that aren't in the sidebar
        const withSnippets = await Promise.all(
          pages.map(async (page): Promise<BacklinkRow> => {
            const cacheKey = `${page.id}:${page.updatedAt}`;
            const cached = snippetCache.current.get(cacheKey);
            if (cached !== undefined) return {page, snippet: cached};
            try {
              const full = await client.getPage(page.id);
              const snippet = toSnippet(snapshotText(full?.data));
              snippetCache.current.set(cacheKey, snippet);
              return {page, snippet};
            } catch {
              return {page, snippet: ''};
            }
          }),
        );
        if (myReq !== reqId.current) return; // superseded during snippet fetch
        // Bound the cache to the current backlink set (drops stale ids/revisions).
        const liveKeys = new Set(pages.map((p) => `${p.id}:${p.updatedAt}`));
        for (const key of snippetCache.current.keys()) {
          if (!liveKeys.has(key)) snippetCache.current.delete(key);
        }
        setRows(withSnippets);
      })
      .catch(() => {
        if (myReq === reqId.current) setRows([]);
      })
      .finally(() => {
        if (myReq === reqId.current) setLoading(false);
      });
  }, [client, pageId]);

  useEffect(() => {
    refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = client.subscribePages(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [client, refresh, revision]);

  return {rows, loading};
}

/**
 * Fetch "unlinked mentions": pages whose text contains this page's name but do
 * not `@`-link it. Uses the lexical (BM25) search index, which is always
 * available even with AI turned off and works on both transports. Excludes the
 * page itself, any page that already links here (a backlink), and — by keeping
 * only hits whose snippet/title actually contains the name — keeps out fuzzy
 * near-matches. Deleted pages never enter the search index.
 */
function useUnlinkedMentions(
  pageId: string | null,
  name: string,
  backlinkIds: Set<string>,
  revision: number,
): {rows: MentionRow[]; loading: boolean} {
  const client = useData();
  const [rows, setRows] = useState<MentionRow[]>([]);
  const [loading, setLoading] = useState(false);
  // Monotonic request id: drop a stale in-flight search that resolves late.
  const reqId = useRef(0);

  const query = name.trim();
  const backlinkKey = [...backlinkIds].sort().join(',');

  const refresh = useCallback(() => {
    const myReq = ++reqId.current;
    if (!pageId || query.length === 0) {
      setRows([]);
      return;
    }
    setLoading(true);
    const needle = query.toLowerCase();
    // Server clamps the search limit to 25; asking for more is wasted.
    void client
      .aiSearch(query, 25)
      .then((res) => {
        if (myReq !== reqId.current) return; // superseded
        setRows(filterUnlinkedMentions(res.results, {selfId: pageId, backlinkIds, needle}));
      })
      .catch(() => {
        if (myReq === reqId.current) setRows([]);
      })
      .finally(() => {
        if (myReq === reqId.current) setLoading(false);
      });
    // backlinkKey re-filters when the backlink set changes; query drives the search.
  }, [client, pageId, query, backlinkKey]);

  useEffect(() => {
    refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = client.subscribePages(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [client, refresh, revision]);

  return {rows, loading};
}

/**
 * The Linked-references side-pane body: a durable home for a page's inbound
 * links, promoted from the transient backlinks popover chip. Two sections —
 * **Backlinks** (pages that `@`-mention or relate to this one) and **Unlinked
 * mentions** (pages whose text names it without linking). Reads the target page
 * from the `linksPane` bridge (set by the header chip / command palette),
 * mirroring how the Review pane reads `reviewPane`. Mounted by SplitPane for the
 * {@link LINKS_PANE_ID} pseudo-pane.
 */
export function LinksPaneBody() {
  const {t} = useTranslation();
  const {selectPage, selectPageAtBlock, pageLabel, pages, closeSplit, openInSplit} = useNavigation();
  const client = useData();
  const [target, setTarget] = useState(getLinksTarget());
  useEffect(() => subscribeLinksPane(() => setTarget(getLinksTarget())), []);

  const pageId = target.pageId;

  // The target's authoritative name drives the unlinked-mention search. Prefer the
  // page list; fall back to a fetch so database rows (absent from the sidebar) work.
  const [name, setName] = useState('');
  useEffect(() => {
    if (!pageId) {
      setName('');
      return;
    }
    const meta = pages.find((p) => p.id === pageId);
    if (meta?.name && meta.name.trim()) {
      setName(meta.name.trim());
      return;
    }
    let live = true;
    void client
      .getPage(pageId)
      .then((full) => {
        if (live) setName((full?.name ?? '').trim());
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, pageId, pages]);

  // Rows show each page's icon (localStorage) — re-render when one changes.
  const [, bumpIcon] = useState(0);
  useEffect(() => subscribePageIcon(() => bumpIcon((x) => x + 1)), []);

  const {rows: backlinks, loading: backlinksLoading} = useBacklinks(pageId, target.revision);
  const backlinkIds = new Set(backlinks.map((b) => b.page.id));
  const {rows: mentions, loading: mentionsLoading} = useUnlinkedMentions(pageId, name, backlinkIds, target.revision);

  const openBacklink = (id: string): void => selectPage(id);
  const openMention = (row: MentionRow): void => {
    if (row.blockId) selectPageAtBlock(row.pageId, row.blockId);
    else selectPage(row.pageId);
  };

  const empty = !backlinksLoading && !mentionsLoading && backlinks.length === 0 && mentions.length === 0;

  // Escape dismisses the pane when focus is inside it — keyboard parity with the
  // header "Hide" button (side panes carry no dialog-role Escape of their own).
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeSplit();
    }
  };

  return (
    <div className="flex h-full flex-col" onKeyDown={onKeyDown}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{t('links.title')}</p>
          <p className="truncate text-xs text-muted-foreground">{pageId ? pageLabel(pageId) : t('links.noPage')}</p>
        </div>
        {pageId && (
          <IconButton
            size="sm"
            aria-label={t('command.pageGraph')}
            title={t('command.pageGraph')}
            onClick={() => {
              setGraphTarget(pageId);
              openInSplit(GRAPH_PANE_ID);
            }}
          >
            <Network className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!pageId && <p className="text-xs text-muted-foreground">{t('links.noPage')}</p>}

        {pageId && empty && (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <Link2 className="size-5 text-muted-foreground" aria-hidden />
            <p className="text-xs text-muted-foreground">{t('links.empty')}</p>
            <p className="max-w-[16rem] text-[11px] text-muted-foreground">{t('links.emptyHint')}</p>
          </div>
        )}

        {pageId && !empty && (
          <section className="mb-4 flex flex-col gap-1.5" aria-labelledby="links-backlinks-heading">
            <h3
              id="links-backlinks-heading"
              className="px-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              {t('links.backlinks')}
              {backlinks.length > 0 && ` · ${backlinks.length}`}
            </h3>
            {backlinksLoading && backlinks.length === 0 && (
              <p className="px-0.5 text-xs text-muted-foreground">{t('links.loading')}</p>
            )}
            {!backlinksLoading && backlinks.length === 0 && (
              <p className="px-0.5 text-xs text-muted-foreground">{t('links.noBacklinks')}</p>
            )}
            {backlinks.map(({page, snippet}) => (
              <ContextMenu key={page.id}>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    onClick={() => openBacklink(page.id)}
                    className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
                    title={page.name?.trim() || pageLabel(page.id)}
                  >
                    <span className="flex items-center gap-1.5 text-sm">
                      <PageIcon value={readPageIcon(page.id)} className="leading-none" />
                      <span className="truncate">{page.name?.trim() || pageLabel(page.id)}</span>
                    </span>
                    {snippet && <span className="truncate pl-5 text-xs text-muted-foreground">{snippet}</span>}
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent className={MENU_WIDTH_MD}>
                  <PageMenuItems pageId={page.id} surface="row" menu="context" />
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </section>
        )}

        {pageId && !empty && (
          <section className="flex flex-col gap-1.5" aria-labelledby="links-mentions-heading">
            <h3
              id="links-mentions-heading"
              className="px-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              {t('links.unlinkedMentions')}
              {mentions.length > 0 && ` · ${mentions.length}`}
            </h3>
            {mentionsLoading && mentions.length === 0 && (
              <p className="px-0.5 text-xs text-muted-foreground">{t('links.loading')}</p>
            )}
            {!mentionsLoading && mentions.length === 0 && (
              <p className="px-0.5 text-xs text-muted-foreground">
                {name ? t('links.noMentions') : t('links.mentionsNeedName')}
              </p>
            )}
            {mentions.map((row) => (
              <ContextMenu key={row.pageId}>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    onClick={() => openMention(row)}
                    className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
                    title={row.title || pageLabel(row.pageId)}
                  >
                    <span className="flex items-center gap-1.5 text-sm">
                      <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate">{row.title || pageLabel(row.pageId)}</span>
                    </span>
                    {row.snippet && <span className="truncate pl-5 text-xs text-muted-foreground">{row.snippet}</span>}
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent className={MENU_WIDTH_MD}>
                  <PageMenuItems pageId={row.pageId} surface="row" menu="context" />
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

export default LinksPaneBody;
