import {useSyncExternalStore} from 'react';
import {Link2, Star} from 'lucide-react';
import {useNavigation, useTranslation} from '@/providers';
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
 * The page-actions cluster at the top-right of the window: last-saved status,
 * a copy-link button, a favourite star, then the "…" actions menu. It targets
 * the **right pane's page when the split view is open** (else the focused page),
 * so the cluster always acts on the page the user is looking at on the right.
 *
 * Placement is the shell's call: the titlebar on desktop, the nav bar on web.
 */
export default function PageActionsCluster() {
  const {currentPageId, panes, splitOpen} = useNavigation();
  const {t} = useTranslation();

  // The split view's secondary page wins; fall back to the focused page. The
  // flow pane isn't a page, so it never becomes the target.
  const right = splitOpen ? panes[1]?.pageId : undefined;
  const targetPageId = right && right !== FLOW_PANE_ID ? right : currentPageId;
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
