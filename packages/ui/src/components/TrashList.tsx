import type {PageMeta} from '@book.dev/sdk';
import {Database, FileText, RotateCcw, Trash2} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {EmptyState} from '@/components/ui/empty-state';
import {useTranslation} from '@/providers';
import {t as bareT} from '@/i18n';
import type {TrashController} from '@/lib/useTrash';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {MENU_DESTRUCTIVE_CLASS, MENU_WIDTH_SM} from '@/components/ui/menu-components';

const displayName = (name: string | null): string =>
  name && name.trim().length > 0 ? name : bareT('common.untitled');

/** "just now" / "5 min ago" / "3 d ago" from an ISO timestamp, localized via
 *  Intl (no hand-pluralized English). */
function timeAgo(iso: string | null, locale: string): string {
  if (!iso) return '';
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return bareT('home.justNow');
  const rtf = new Intl.RelativeTimeFormat(locale, {numeric: 'always', style: 'narrow'});
  if (secs < 3600) return rtf.format(-Math.round(secs / 60), 'minute');
  if (secs < 86400) return rtf.format(-Math.round(secs / 3600), 'hour');
  return rtf.format(-Math.round(secs / 86400), 'day');
}

/**
 * The trashed-pages list body (loading / empty / rows with restore + delete-
 * forever), shared by the quick {@link TrashDialog} overlay and the full-page
 * `?page=trash` view so both render identical rows. `emptyLabel` lets the screen
 * use a roomier empty message than the dialog's terse one.
 */
export default function TrashList({trash, emptyLabel}: {trash: TrashController; emptyLabel?: string}) {
  const {t, locale} = useTranslation();
  const {items, loading, busy, restore, purge} = trash;

  if (loading && items.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{t('trash.loading')}</p>;
  }
  if (items.length === 0) {
    return <EmptyState title={emptyLabel ?? t('trash.empty')} />;
  }
  return (
    <ul className="flex flex-col gap-1 pr-2">
      {items.map((item: PageMeta) => {
        const Icon = item.hostedDatabaseId ? Database : FileText;
        const disabled = busy !== null;
        return (
          <ContextMenu key={item.id}>
            <ContextMenuTrigger asChild>
              <li className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{displayName(item.name)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(item.deletedAt, locale)}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  disabled={disabled}
                  onClick={() => void restore(item.id)}
                  aria-label={t('trash.restoreItem', {page: displayName(item.name)})}
                  title={t('trash.restore')}
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-destructive hover:text-destructive"
                  disabled={disabled}
                  onClick={() => void purge(item)}
                  aria-label={t('trash.purgeItem', {page: displayName(item.name)})}
                  title={t('trash.deleteForever')}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            </ContextMenuTrigger>
            <ContextMenuContent className={MENU_WIDTH_SM}>
              <ContextMenuItem disabled={disabled} onSelect={() => void restore(item.id)}>
                <RotateCcw className="mr-2 h-4 w-4" />
                {t('trash.restore')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                disabled={disabled}
                onSelect={() => void purge(item)}
                className={MENU_DESTRUCTIVE_CLASS}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t('trash.deleteForever')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </ul>
  );
}
