import {useSyncExternalStore} from 'react';
import {Link2, Presentation, Star} from 'lucide-react';
import {useHud, useNavigation, useTranslation} from '@/providers';
import {IconButton} from '@/components/ui/icon-button';
import NavContextMenu from '@/components/NavContextMenu';
import ShareDialog, {useSharingCapability} from '@/components/ShareDialog';
import {useCopyPageLink} from '@/lib/useCopyPageLink';
import {isFavorite, subscribeFavorites, toggleFavorite} from '@/lib/favorites';
import {pageSaveStatus, pageSaveStatusVersion, subscribePageSaveStatus} from '@/lib/pageSaveStatus';
import {FLOW_PANE_ID, HOME_PAGE_ID} from '@/lib/homePage';
import {cn} from '@/lib/utils';
import type {TKey} from '@/i18n';

const STATUS_LABEL: Record<string, TKey | ''> = {
  idle: '',
  saving: 'page.saving',
  saved: 'page.saved',
  'save failed': 'page.saveFailed',
};

/**
 * The page-actions cluster for one page: last-saved status, a copy-link button,
 * a favourite star, then the "…" actions menu. It acts on the given
 * {@link pageId}, so the nav bar mounts one for the primary page and the split
 * pane mounts its own for the right pane — each owns its page's actions.
 */
export default function PageActionsCluster({pageId}: {pageId: string | null}) {
  const {t} = useTranslation();
  const {pages} = useNavigation();
  const {setHud} = useHud();

  const targetPageId = pageId;
  const actionable = !!targetPageId && targetPageId !== HOME_PAGE_ID && targetPageId !== FLOW_PANE_ID;
  // Present applies to document pages, not database hosts (same gate as the
  // "…" menu's Present submenu). Derived from the nav list — it can briefly
  // lag a just-created DB page; self-heals on the next page-list refresh.
  const isDatabase = actionable && !!pages.find((p) => p.id === targetPageId)?.hostedDatabaseId;
  const canPresent = actionable && !isDatabase;

  useSyncExternalStore(subscribePageSaveStatus, pageSaveStatusVersion, pageSaveStatusVersion);
  const status = pageSaveStatus(targetPageId);
  const statusKey = STATUS_LABEL[status];

  const fav = useSyncExternalStore(
    subscribeFavorites,
    () => actionable && isFavorite(targetPageId!),
    () => false,
  );

  // The Share control shows whenever the server supports sharing — a
  // non-manager gets the read-only "who can access" view instead of nothing.
  const sharing = useSharingCapability();
  // Guards the desktop dead-link case (SHR-1): copy on an unpublished desktop
  // toasts + points at publishing rather than silently copying a dead link.
  const copyLink = useCopyPageLink();

  return (
    <div className="flex items-center gap-0.5">
      {statusKey && (
        <span
          className={cn('px-1.5 text-xs text-muted-foreground transition-opacity', status === 'save failed' && 'text-destructive')}
          aria-live="polite"
        >
          {t(statusKey)}
        </span>
      )}
      {/* Present (IA-8): a visible one-click way into the slide deck — it was
          buried in the "…" submenu + palette. Click = full-screen deck (the
          primary action); the presenter console stays in the "…" ▸ Present
          submenu. Hidden (not disabled) on database hosts, like the submenu. */}
      {canPresent && (
        <IconButton
          size="sm"
          onClick={() =>
            setHud((d) => {
              d.present = {open: true, mode: 'fullscreen', pageId: targetPageId!};
              return d;
            })
          }
          aria-label={t('page.present')}
          title={t('command.presentFull')}
        >
          <Presentation className="h-4 w-4" />
        </IconButton>
      )}
      {actionable && sharing.supported && <ShareDialog pageId={targetPageId!} canManage={sharing.canManage} />}
      <IconButton
        size="sm"
        disabled={!actionable}
        onClick={() => targetPageId && copyLink(targetPageId)}
        aria-label={t('menu.copyLink')}
        title={t('menu.copyLink')}
      >
        <Link2 className="h-4 w-4" />
      </IconButton>
      <IconButton
        size="sm"
        disabled={!actionable}
        onClick={() => targetPageId && toggleFavorite(targetPageId)}
        aria-label={fav ? t('menu.unfavorite') : t('menu.favorite')}
        title={fav ? t('menu.unfavorite') : t('menu.favorite')}
        className={cn(fav && 'text-primary hover:text-primary')}
      >
        <Star className={cn('h-4 w-4', fav && 'fill-current')} />
      </IconButton>
      <NavContextMenu pageId={targetPageId} />
    </div>
  );
}
