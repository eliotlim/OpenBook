import {useSyncExternalStore} from 'react';
import {Link2, Star} from 'lucide-react';
import {useTranslation} from '@/providers';
import {IconButton} from '@/components/ui/icon-button';
import NavContextMenu from '@/components/NavContextMenu';
import {copyPageLink} from '@/lib/pageActions';
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

  const targetPageId = pageId;
  const actionable = !!targetPageId && targetPageId !== HOME_PAGE_ID && targetPageId !== FLOW_PANE_ID;

  useSyncExternalStore(subscribePageSaveStatus, pageSaveStatusVersion, pageSaveStatusVersion);
  const status = pageSaveStatus(targetPageId);
  const statusKey = STATUS_LABEL[status];

  const fav = useSyncExternalStore(
    subscribeFavorites,
    () => actionable && isFavorite(targetPageId!),
    () => false,
  );

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
      <IconButton
        size="sm"
        disabled={!actionable}
        onClick={() => targetPageId && void copyPageLink(targetPageId)}
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
