import {useEffect, useMemo, useState} from 'react';
import type {PageMeta} from '@book.dev/sdk';
import {Tree, TreeDataItem} from '@/components/ui/tree';
import {Button} from '@/components/ui/button';
import {IconButton} from '@/components/ui/icon-button';
import {PageMenuItems} from '@/components/PageContextMenu';
import {useHud, useNavigation, useTranslation} from '@/providers';
import {readPageIcon, subscribePageIcon} from '@/lib/pageIcon';
import {planTreeMove, type DropWhere} from '@/lib/treeMove';
import {LayoutTemplate, MoreHorizontal, Plus, Table2} from 'lucide-react';
import {t} from '@/i18n';

const displayName = (name: string | null): string =>
  name && name.trim().length > 0 ? name : t('common.untitled');

/**
 * Build the sidebar tree from the flat page list: each page becomes a node, and
 * a page with a `parentId` is attached under that parent (recursively). Pages
 * whose parent isn't in the list (e.g. it was deleted) surface at the top level.
 * The page list arrives in manual sidebar order (server `position`), so each
 * parent's children come out in the order the user arranged them.
 *
 * A node's icon mirrors the page's own icon: its chosen emoji, or the default
 * page icon (📄) when none is set — so the sidebar matches the page header.
 */
export function buildTree(pages: PageMeta[]): TreeDataItem[] {
  const nodes = new Map<string, TreeDataItem>();
  for (const page of pages) {
    nodes.set(page.id, {
      id: page.id,
      name: displayName(page.name),
      icon: readPageIcon(page.id),
    });
  }
  const roots: TreeDataItem[] = [];
  for (const page of pages) {
    const node = nodes.get(page.id)!;
    const parent = page.parentId ? nodes.get(page.parentId) : undefined;
    if (parent) (parent.children ??= []).push(node);
    else roots.push(node);
  }
  return roots;
}

export default function LibraryNavigationTree() {
  const {pages, loading, currentPageId, selectPageInPane, createPage, createDatabasePage, createSubpage, movePage} = useNavigation();
  // Sidebar navigation always drives the primary (left) pane — the split pane
  // only follows its own links or an explicit "open in split".
  const openPrimary = (id: string): void => selectPageInPane(id, 'primary');
  const {setHud} = useHud();
  const {t} = useTranslation();

  // Icons live in localStorage; re-render the tree when one changes so a freshly
  // picked emoji shows in the sidebar without a reload.
  const [iconVersion, setIconVersion] = useState(0);
  useEffect(() => subscribePageIcon(() => setIconVersion((v) => v + 1)), []);

  const data = useMemo(() => buildTree(pages), [pages, iconVersion]);

  const onMove = (draggedId: string, targetId: string, where: DropWhere) => {
    const plan = planTreeMove(pages, draggedId, targetId, where);
    if (plan) void movePage(draggedId, plan.parentId, plan.orderedIds);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pb-1 pt-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('nav.pages')}</span>
        <div className="flex items-center gap-0.5">
          <IconButton
            size="sm"
            onClick={() => setHud((draft) => {draft.templates.open = true; return draft;})}
            aria-label={t('nav.templates')}
            title={t('nav.templates')}
          >
            <LayoutTemplate className="h-4 w-4" />
          </IconButton>
          <IconButton size="sm" onClick={() => void createDatabasePage()} aria-label={t('nav.newDatabase')} title={t('nav.newDatabase')}>
            <Table2 className="h-4 w-4" />
          </IconButton>
          <IconButton size="sm" onClick={() => void createPage()} aria-label={t('nav.newPage')} title={t('nav.newPage')}>
            <Plus className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
      {loading ? (
        // Still listing pages (initial load, or a no-reload library switch): render
        // nothing rather than flash the empty-state starters over a library that
        // does have pages — the tree fills in the moment `listPages()` resolves.
        <div className="flex-1" />
      ) : data.length === 0 ? (
        // A brand-new (or emptied-out) library: the empty tree would just be a
        // blank gap, so lead with the same starters Home offers — a plain new
        // page and the template gallery — right where pages will appear.
        <div className="flex flex-col gap-2 px-3 py-2" data-pages-empty>
          <p className="text-xs text-muted-foreground">{t('nav.emptyPagesHint')}</p>
          <div className="flex flex-col gap-1">
            <Button
              variant="ghost"
              className="h-7 justify-start px-2 text-sm text-muted-foreground hover:text-foreground"
              onClick={() => void createPage()}
            >
              <Plus className="h-4 w-4 shrink-0" />
              {t('nav.newPage')}
            </Button>
            <Button
              variant="ghost"
              className="h-7 justify-start px-2 text-sm text-muted-foreground hover:text-foreground"
              onClick={() => setHud((draft) => {draft.templates.open = true; return draft;})}
            >
              <LayoutTemplate className="h-4 w-4 shrink-0" />
              {t('nav.templates')}
            </Button>
          </div>
        </div>
      ) : (
        <Tree
          data={data}
          className="w-full flex-1 border-0"
          selectedItemId={currentPageId ?? undefined}
          onSelectChange={(item) => item && openPrimary(item.id)}
          renderItemContextMenu={(item) => <PageMenuItems pageId={item.id} />}
          renderRowActions={(item, {openMenu}) => (
            <>
              <IconButton
                size="inline"
                aria-label={t('menu.addSubpage')}
                title={t('menu.addSubpage')}
                onClick={() => void createSubpage(item.id, 'page').then(openPrimary)}
              >
                <Plus className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton
                size="inline"
                aria-label={t('nav.more')}
                title={t('nav.more')}
                onClick={openMenu}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </IconButton>
            </>
          )}
          onMove={onMove}
        />
      )}
    </div>
  );
}
