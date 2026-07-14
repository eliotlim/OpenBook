import React, {useCallback, useSyncExternalStore} from 'react';
import {
  AppWindow,
  Archive,
  ClipboardCheck,
  Columns2,
  CopyPlus,
  CornerUpRight,
  Download,
  ExternalLink,
  FileCode,
  FilePlus2,
  FileText,
  FileType,
  GitFork,
  History,
  Link2,
  Maximize2,
  Monitor,
  Palette,
  Pencil,
  Presentation,
  Puzzle,
  Settings as SettingsIcon,
  Star,
  StarOff,
  Table2,
  Trash2,
} from 'lucide-react';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import {useConfirm, useHud, useNavigation, usePreferences, useTranslation} from '@/providers';
import {requestMovePage, requestRenamePage} from '@/lib/pageActions';
import {useCopyPageLink} from '@/lib/useCopyPageLink';
import {isFavorite, toggleFavorite} from '@/lib/favorites';
import {togglePageFullWidth, usePageFullWidth} from '@/lib/pageFullWidth';
import {formatShortcut, SHORTCUTS} from '@/lib/shortcuts';
import {
  pageDocActions,
  pageDocActionsVersion,
  subscribePageDocActions,
  type ExportKind,
} from '@/lib/pageDocActions';
import {CUSTOMISE_PANE_ID, FLOW_PANE_ID, HISTORY_PANE_ID, HOME_PAGE_ID, REVIEW_PANE_ID} from '@/lib/homePage';
import {setPageCustomiseTarget} from '@/lib/pageCustomise';
import {setReviewTarget} from '@/lib/reviewPane';
import {setHistoryTarget} from '@/lib/historyPane';
import type {TKey} from '@/i18n';

/** Menu copy + icon per export format, in display order. */
const EXPORT_ITEMS: Array<{kind: ExportKind; labelKey: TKey; icon: typeof FileText}> = [
  {kind: 'md', labelKey: 'page.exportMarkdown', icon: FileText},
  {kind: 'html', labelKey: 'page.exportHtml', icon: FileCode},
  {kind: 'html-slides', labelKey: 'page.exportHtmlSlides', icon: Presentation},
  {kind: 'pdf-paged', labelKey: 'page.exportPdfPaged', icon: FileType},
  {kind: 'pdf-continuous', labelKey: 'page.exportPdfContinuous', icon: FileType},
  {kind: 'pdf-slides', labelKey: 'page.exportPdfSlides', icon: Presentation},
  {kind: 'plugin', labelKey: 'page.exportPlugin', icon: Puzzle},
];

/**
 * The two Radix menu families expose the same item/checkbox/sub/separator shape,
 * so the one canonical page-action list below renders through whichever bundle
 * its host provides — a right-click {@link ContextMenu} or the click-triggered
 * "…" dropdown. Typed as {@link React.ElementType} because we only lean on the
 * props both families share (onSelect/checked/disabled/children).
 */
interface MenuComponentSet {
  Item: React.ElementType;
  CheckboxItem: React.ElementType;
  Separator: React.ElementType;
  Shortcut: React.ElementType;
  Sub: React.ElementType;
  SubTrigger: React.ElementType;
  SubContent: React.ElementType;
}

const MENU_COMPONENTS: Record<'context' | 'dropdown', MenuComponentSet> = {
  context: {
    Item: ContextMenuItem,
    CheckboxItem: ContextMenuCheckboxItem,
    Separator: ContextMenuSeparator,
    Shortcut: ContextMenuShortcut,
    Sub: ContextMenuSub,
    SubTrigger: ContextMenuSubTrigger,
    SubContent: ContextMenuSubContent,
  },
  dropdown: {
    Item: DropdownMenuItem,
    CheckboxItem: DropdownMenuCheckboxItem,
    Separator: DropdownMenuSeparator,
    Shortcut: DropdownMenuShortcut,
    Sub: DropdownMenuSub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent,
  },
};

/**
 * Which actions a menu surface shows:
 * - `row`  — a sidebar / favorites / library-tree row: the compact per-page set
 *            (favorite, open, rename, copy link, duplicate, move, new sub-, trash).
 * - `page` — the page you're looking at: the full superset, adding view options
 *            (full width), side panes (flow / customise / review), present,
 *            export, and the app-level settings / trash shortcuts. Used by both
 *            the click "…" dropdown and the right-click page body, so those two
 *            offer an identical action set.
 */
export type PageMenuSurface = 'row' | 'page';

/**
 * The single source of truth for a page's actions, rendered from every entry
 * point. `surface` selects the compact row set vs. the full page set; `menu`
 * selects the Radix family (right-click context menu vs. click dropdown). All
 * hooks run unconditionally so hook order stays stable across surfaces.
 *
 * Rendered inside a {@link ContextMenuContent} (row/context) or a
 * `DropdownMenuContent` (page/dropdown) by the caller.
 */
export function PageMenuItems({
  pageId,
  surface = 'row',
  menu = 'context',
}: {
  pageId: string | null | undefined;
  surface?: PageMenuSurface;
  menu?: 'context' | 'dropdown';
}) {
  const {openInNew, openInSplit, createSubpage, duplicatePage, deletePage, selectPage, pages} =
    useNavigation();
  const {setHud} = useHud();
  const confirm = useConfirm();
  const {preferences} = usePreferences();
  const {t} = useTranslation();
  const copyLink = useCopyPageLink();

  const id = pageId ?? null;
  const isHome = id === HOME_PAGE_ID;
  // Present/full-width apply to editable document pages, not to database hosts.
  const isDatabase = !!id && !!pages.find((p) => p.id === id)?.hostedDatabaseId;
  const pageScoped = !!id && !isHome; // actions that need a real, non-home page

  // Full width is a per-page layout choice (see lib/pageFullWidth).
  const fullWidth = usePageFullWidth(pageScoped ? id! : '');

  // The open document registers what it can export; subscribe so the menu tracks
  // the current page (and its plugin-ness) live.
  useSyncExternalStore(subscribePageDocActions, pageDocActionsVersion, pageDocActionsVersion);
  const docActions = pageDocActions(id);
  const exportItems = EXPORT_ITEMS.filter((item) => docActions?.exportKinds.includes(item.kind));

  const onDelete = useCallback(async () => {
    if (!id) return;
    // Skip the confirm when the user has turned it off in General settings.
    if (preferences.general.confirmOnTrash) {
      const ok = await confirm({
        title: t('confirm.trashTitle'),
        description: t('confirm.trashBody'),
        confirmText: t('confirm.trashConfirm'),
        destructive: true,
      });
      if (!ok) return;
    }
    void deletePage(id);
  }, [confirm, deletePage, id, preferences.general.confirmOnTrash, t]);

  // "Rename" focuses the page's title field: switch to the page first, then ask
  // its (possibly freshly mounted) editor to focus the title for editing.
  const onRename = useCallback(() => {
    if (!id) return;
    selectPage(id);
    setTimeout(() => requestRenamePage(id), 50);
  }, [id, selectPage]);

  // Read at render — the menu re-mounts each time it opens, so this is current.
  const fav = pageScoped && isFavorite(id!);
  const isPage = surface === 'page';
  const C = MENU_COMPONENTS[menu];

  return (
    <>
      {isPage && (
        <>
          {/* A real menu item (role=menuitemcheckbox), not a Switch inside a
              Label: Radix only routes activation to its menu items. `onSelect`
              preventDefault keeps the menu open so the layout change is visible. */}
          <C.CheckboxItem
            checked={fullWidth}
            disabled={!pageScoped}
            onCheckedChange={() => id && togglePageFullWidth(id)}
            onSelect={(e: Event) => e.preventDefault()}
          >
            {t('menu.fullWidth')}
            <C.Shortcut>{formatShortcut(SHORTCUTS.toggleFullWidth)}</C.Shortcut>
          </C.CheckboxItem>
          <C.Separator />
        </>
      )}

      <C.Item disabled={!pageScoped} onSelect={() => id && toggleFavorite(id)}>
        {fav ? <StarOff className="mr-2 h-4 w-4" /> : <Star className="mr-2 h-4 w-4" />}
        {fav ? t('menu.unfavorite') : t('menu.favorite')}
      </C.Item>
      <C.Separator />

      <C.Item disabled={!id} onSelect={() => id && openInNew(id, 'tab')}>
        <ExternalLink className="mr-2 h-4 w-4" />
        {t('menu.openTab')}
      </C.Item>
      <C.Item disabled={!id} onSelect={() => id && openInNew(id, 'window')}>
        <AppWindow className="mr-2 h-4 w-4" />
        {t('menu.openWindow')}
      </C.Item>
      <C.Item disabled={!id} onSelect={() => id && openInSplit(id)}>
        <Columns2 className="mr-2 h-4 w-4" />
        {t('menu.openSplit')}
      </C.Item>

      {isPage && (
        <>
          <C.Separator />
          <C.Item disabled={!pageScoped} onSelect={() => openInSplit(FLOW_PANE_ID)}>
            <GitFork className="mr-2 h-4 w-4" />
            {t('flow.open')}
          </C.Item>
          <C.Item
            disabled={!pageScoped}
            onSelect={() => {
              if (!id) return;
              setPageCustomiseTarget(id);
              openInSplit(CUSTOMISE_PANE_ID);
            }}
          >
            <Palette className="mr-2 h-4 w-4" />
            {t('command.customisePage')}
          </C.Item>
          <C.Item
            disabled={!pageScoped}
            onSelect={() => {
              if (!id) return;
              setReviewTarget(id);
              openInSplit(REVIEW_PANE_ID);
            }}
          >
            <ClipboardCheck className="mr-2 h-4 w-4" />
            {t('command.reviewSuggestions')}
          </C.Item>
          <C.Item
            disabled={!pageScoped}
            onSelect={() => {
              if (!id) return;
              setHistoryTarget(id);
              openInSplit(HISTORY_PANE_ID);
            }}
          >
            <History className="mr-2 h-4 w-4" />
            {t('command.versionHistory')}
          </C.Item>
        </>
      )}

      <C.Separator />
      <C.Item disabled={!pageScoped} onSelect={onRename}>
        <Pencil className="mr-2 h-4 w-4" />
        {t('menu.rename')}
      </C.Item>
      <C.Item disabled={!pageScoped} onSelect={() => id && copyLink(id)}>
        <Link2 className="mr-2 h-4 w-4" />
        {t('menu.copyLink')}
      </C.Item>
      <C.Item disabled={!pageScoped} onSelect={() => id && void duplicatePage(id)}>
        <CopyPlus className="mr-2 h-4 w-4" />
        {t('menu.duplicate')}
      </C.Item>
      <C.Item disabled={!pageScoped} onSelect={() => id && requestMovePage(id)}>
        <CornerUpRight className="mr-2 h-4 w-4" />
        {t('menu.moveTo')}
      </C.Item>

      <C.Separator />
      <C.Item disabled={!id} onSelect={() => id && void createSubpage(id, 'page').then(selectPage)}>
        <FilePlus2 className="mr-2 h-4 w-4" />
        {t('menu.addSubpage')}
      </C.Item>
      <C.Item
        disabled={!id}
        onSelect={() => id && void createSubpage(id, 'database').then(selectPage)}
      >
        <Table2 className="mr-2 h-4 w-4" />
        {t('menu.addDatabase')}
      </C.Item>

      {isPage && (
        <>
          {pageScoped && !isDatabase && (
            <>
              <C.Separator />
              <C.Sub>
                <C.SubTrigger>
                  <Presentation className="mr-2 h-4 w-4" />
                  {t('page.present')}
                </C.SubTrigger>
                <C.SubContent>
                  <C.Item
                    onSelect={() =>
                      id &&
                      setHud((d) => {
                        d.present = {open: true, mode: 'fullscreen', pageId: id};
                        return d;
                      })
                    }
                  >
                    <Maximize2 className="mr-2 h-4 w-4" />
                    {t('page.presentFull')}
                  </C.Item>
                  <C.Item
                    onSelect={() =>
                      id &&
                      setHud((d) => {
                        d.present = {open: true, mode: 'presenter', pageId: id};
                        return d;
                      })
                    }
                  >
                    <Monitor className="mr-2 h-4 w-4" />
                    {t('page.presentPresenter')}
                  </C.Item>
                </C.SubContent>
              </C.Sub>
            </>
          )}
          {exportItems.length > 0 && (
            <>
              <C.Separator />
              <C.Sub>
                <C.SubTrigger>
                  <Download className="mr-2 h-4 w-4" />
                  {t('page.export')}
                </C.SubTrigger>
                <C.SubContent>
                  {exportItems.map(({kind, labelKey, icon: Icon}) => (
                    <C.Item key={kind} onSelect={() => void docActions?.runExport(kind)}>
                      <Icon className="mr-2 h-4 w-4" />
                      {t(labelKey)}
                    </C.Item>
                  ))}
                </C.SubContent>
              </C.Sub>
            </>
          )}
          <C.Separator />
          <C.Item
            onSelect={() =>
              setHud((draft) => {
                draft.settings.open = true;
                return draft;
              })
            }
          >
            <SettingsIcon className="mr-2 h-4 w-4" />
            {t('common.settings')}
            <C.Shortcut>{formatShortcut(SHORTCUTS.openSettings)}</C.Shortcut>
          </C.Item>
          <C.Item
            onSelect={() =>
              setHud((draft) => {
                draft.trash.open = true;
                return draft;
              })
            }
          >
            <Archive className="mr-2 h-4 w-4" />
            {t('nav.trash')}
            <C.Shortcut>{formatShortcut(SHORTCUTS.openTrash)}</C.Shortcut>
          </C.Item>
        </>
      )}

      <C.Separator />
      <C.Item
        disabled={!pageScoped}
        onSelect={() => void onDelete()}
        className="text-destructive focus:text-destructive"
      >
        <Trash2 className="mr-2 h-4 w-4" />
        {t('menu.moveToTrash')}
      </C.Item>
    </>
  );
}

/**
 * Wrap the page body so right-clicking it opens the page's context menu — the
 * full page action set (same as the "…" dropdown). (The block editor supplies
 * its own per-block actions through the gutter handle; the sidebar tree wires
 * {@link PageMenuItems} in directly with the compact `row` surface.)
 */
export function PageContextMenu({pageId, children}: {pageId: string; children: React.ReactNode}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="contents">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        <PageMenuItems pageId={pageId} surface="page" />
      </ContextMenuContent>
    </ContextMenu>
  );
}
