import {useSyncExternalStore} from 'react';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {Button} from '@/components/ui/button';
import {DotsVerticalIcon} from '@radix-ui/react-icons';
import {
  AppWindow,
  Columns2,
  Download,
  GitFork,
  ExternalLink,
  FileCode,
  FileText,
  FileType,
  Link2,
  Maximize2,
  Monitor,
  Presentation,
  Puzzle,
  Settings as SettingsIcon,
  Star,
  StarOff,
  Trash2,
} from 'lucide-react';
import {useHud, useNavigation, useTranslation} from '@/providers';
import {copyPageLink} from '@/lib/pageActions';
import {togglePageFullWidth, usePageFullWidth} from '@/lib/pageFullWidth';
import {isFavorite, toggleFavorite} from '@/lib/favorites';
import {formatShortcut, SHORTCUTS} from '@/lib/shortcuts';
import {
  pageDocActions,
  pageDocActionsVersion,
  subscribePageDocActions,
  type ExportKind,
} from '@/lib/pageDocActions';
import {FLOW_PANE_ID, HOME_PAGE_ID} from '@/lib/homePage';

/** Menu copy + icon per export format, in display order. */
const EXPORT_ITEMS: Array<{kind: ExportKind; labelKey: string; icon: typeof FileText}> = [
  {kind: 'md', labelKey: 'page.exportMarkdown', icon: FileText},
  {kind: 'html', labelKey: 'page.exportHtml', icon: FileCode},
  {kind: 'html-slides', labelKey: 'page.exportHtmlSlides', icon: Presentation},
  {kind: 'pdf-paged', labelKey: 'page.exportPdfPaged', icon: FileType},
  {kind: 'pdf-continuous', labelKey: 'page.exportPdfContinuous', icon: FileType},
  {kind: 'pdf-slides', labelKey: 'page.exportPdfSlides', icon: Presentation},
  {kind: 'plugin', labelKey: 'page.exportPlugin', icon: Puzzle},
];

/**
 * The page "…" actions menu. Targets {@link pageId} (defaults to the focused
 * page) so the split view's cluster can act on the right pane's page.
 */
export default function NavContextMenu({pageId}: {pageId?: string | null} = {}) {
  const {setHud} = useHud();
  const {openInNew, openInSplit, currentPageId: focusedPageId} = useNavigation();
  const {t} = useTranslation();
  const currentPageId = pageId !== undefined ? pageId : focusedPageId;
  const isHome = currentPageId === HOME_PAGE_ID;
  const fav = !!currentPageId && !isHome && isFavorite(currentPageId);
  // Full width is a per-page layout choice (see lib/pageFullWidth).
  const fullWidth = usePageFullWidth(currentPageId && !isHome ? currentPageId : '');

  // The open document registers what it can do (export formats, delete);
  // subscribe so the menu tracks the page — and its plugin-ness — live.
  useSyncExternalStore(subscribePageDocActions, pageDocActionsVersion, pageDocActionsVersion);
  const docActions = pageDocActions(currentPageId);
  const exportItems = EXPORT_ITEMS.filter((item) => docActions?.exportKinds.includes(item.kind));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* The accessible name flips to "Page actions" once the open document
            has registered its capabilities — it doubles as the signal (for
            assistive tech and tests alike) that the page is ready to act on.
            Registration happens in post-mount effects, so the first client
            render still matches the server HTML. */}
        <Button
          variant="ghost"
          className="px-3 py-1"
          aria-label={docActions ? t('page.actions') : t('menu.options')}
        >
          <DotsVerticalIcon className="h-4 w-4"/>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        <DropdownMenuLabel>{t('menu.viewOptions')}</DropdownMenuLabel>
        {/* A real menu item (role=menuitemcheckbox), not a Switch inside a Label:
            Radix only routes pointer/keyboard activation to its menu items, so a
            bare control nested in a label never toggled (dead on click in the
            desktop WKWebView especially). `onSelect` preventDefault keeps the
            menu open so you can see the layout change. */}
        <DropdownMenuCheckboxItem
          checked={fullWidth}
          disabled={!currentPageId || isHome}
          onCheckedChange={() => currentPageId && togglePageFullWidth(currentPageId)}
          onSelect={(e) => e.preventDefault()}
        >
          {t('menu.fullWidth')}
          <DropdownMenuShortcut>{formatShortcut(SHORTCUTS.toggleFullWidth)}</DropdownMenuShortcut>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator/>
        <DropdownMenuItem
          disabled={!currentPageId || isHome}
          onClick={() => currentPageId && toggleFavorite(currentPageId)}
        >
          {fav ? <StarOff className="mr-2 h-4 w-4" /> : <Star className="mr-2 h-4 w-4" />}
          {fav ? t('menu.unfavorite') : t('menu.favorite')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!currentPageId}
          onClick={() => currentPageId && openInNew(currentPageId, 'tab')}
        >
          <ExternalLink className="mr-2 h-4 w-4" />
          {t('menu.openTab')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!currentPageId}
          onClick={() => currentPageId && openInNew(currentPageId, 'window')}
        >
          <AppWindow className="mr-2 h-4 w-4" />
          {t('menu.openWindow')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!currentPageId}
          onClick={() => currentPageId && openInSplit(currentPageId)}
        >
          <Columns2 className="mr-2 h-4 w-4" />
          {t('menu.openSplit')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!currentPageId || isHome}
          onClick={() => openInSplit(FLOW_PANE_ID)}
        >
          <GitFork className="mr-2 h-4 w-4" />
          {t('flow.open')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!currentPageId}
          onClick={() => currentPageId && void copyPageLink(currentPageId)}
        >
          <Link2 className="mr-2 h-4 w-4" />
          {t('menu.copyLink')}
        </DropdownMenuItem>
        <DropdownMenuSeparator/>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={!currentPageId || isHome}>
            <Presentation className="mr-2 h-4 w-4" />
            {t('page.present')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem
              onClick={() =>
                currentPageId &&
                setHud((d) => {d.present = {open: true, mode: 'fullscreen', pageId: currentPageId}; return d;})
              }
            >
              <Maximize2 className="mr-2 h-4 w-4" />
              {t('page.presentFull')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                currentPageId &&
                setHud((d) => {d.present = {open: true, mode: 'presenter', pageId: currentPageId}; return d;})
              }
            >
              <Monitor className="mr-2 h-4 w-4" />
              {t('page.presentPresenter')}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {exportItems.length > 0 && (
          <>
            <DropdownMenuSeparator/>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Download className="mr-2 h-4 w-4" />
                {t('page.export')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {exportItems.map(({kind, labelKey, icon: Icon}) => (
                  <DropdownMenuItem key={kind} onClick={() => void docActions?.runExport(kind)}>
                    <Icon className="mr-2 h-4 w-4" />
                    {t(labelKey as Parameters<typeof t>[0])}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
        <DropdownMenuSeparator/>
        <DropdownMenuItem onClick={() => setHud((draft) => {draft.settings.open = true; return draft;})}>
          <SettingsIcon className="mr-2 h-4 w-4" />
          {t('common.settings')}
          <DropdownMenuShortcut>{formatShortcut(SHORTCUTS.openSettings)}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setHud((draft) => {draft.trash.open = true; return draft;})}>
          <Trash2 className="mr-2 h-4 w-4" />
          {t('nav.trash')}
          <DropdownMenuShortcut>{formatShortcut(SHORTCUTS.openTrash)}</DropdownMenuShortcut>
        </DropdownMenuItem>
        {docActions?.deletePage && (
          <DropdownMenuItem
            onClick={() => void docActions.deletePage?.()}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t('page.delete')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
