import {useCallback, useEffect, useState} from 'react';
import type {PageMeta} from '@book.dev/sdk';
import {Database, FileText, RotateCcw, Trash2} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {Kbd, ShortcutTooltip} from '@/components/ui/kbd';
import {ScrollArea} from '@/components/ui/scroll-area';
import {useData} from '@/data';
import {useConfirm, useHud, useNavigation, useTranslation} from '@/providers';
import {t as bareT} from '@/i18n';
import {SHORTCUTS} from '@/lib/shortcuts';
import {SIDEBAR_HOVER} from '@/lib/sidebarStyles';
import {cn} from '@/lib/utils';

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
 * The trash: pages deleted from elsewhere in the app are soft-deleted and land
 * here, where they can be restored or permanently removed. The server's cleanup
 * job purges them automatically after its retention window; this just exposes
 * the manual controls.
 */
export default function TrashDialog() {
  const client = useData();
  const confirm = useConfirm();
  const {t, locale} = useTranslation();
  const {selectPage} = useNavigation();
  // Open state lives in the HUD so the command palette, the ⋮ menu, and the
  // keyboard shortcut can all open the trash, not just the sidebar trigger.
  const {hud, setHud} = useHud();
  const open = hud.trash.open;
  const setOpen = useCallback(
    (next: boolean) =>
      setHud((draft) => {
        draft.trash.open = next;
        return draft;
      }),
    [setHud],
  );
  const [items, setItems] = useState<PageMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await client.listTrash());
    } finally {
      setLoading(false);
    }
  }, [client]);

  // Refresh whenever the trash opens — by trigger, menu, palette, or shortcut.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const restore = useCallback(
    async (id: string) => {
      setBusy(id);
      try {
        const page = await client.restorePage(id);
        await refresh();
        if (page) {
          selectPage(page.id);
          setOpen(false);
        }
      } finally {
        setBusy(null);
      }
    },
    [client, refresh, selectPage],
  );

  const purge = useCallback(
    async (item: PageMeta) => {
      const ok = await confirm({
        title: t('trash.purgeTitle', {page: displayName(item.name)}),
        description: t('trash.cannotUndo'),
        confirmText: t('trash.deleteForever'),
        destructive: true,
      });
      if (!ok) return;
      setBusy(item.id);
      try {
        await client.purgePage(item.id);
        await refresh();
      } finally {
        setBusy(null);
      }
    },
    [client, refresh, confirm],
  );

  const emptyTrash = useCallback(async () => {
    const ok = await confirm({
      title: t('trash.emptyTitle'),
      description: t('trash.emptyBody'),
      confirmText: t('trash.emptyTrash'),
      destructive: true,
    });
    if (!ok) return;
    setBusy('__all__');
    try {
      await client.emptyTrash();
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [client, refresh, confirm]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* A nav row under Settings — same anatomy as the launcher above it. */}
      <ShortcutTooltip combo={SHORTCUTS.openTrash} label={t('nav.trash')}>
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            className={cn('flex h-7 grow justify-start gap-2 px-2 text-muted-foreground', SIDEBAR_HOVER)}
            aria-label={t('nav.trash')}
          >
            <Trash2 className="h-4 w-4 shrink-0" />
            <span className="grow text-left">{t('nav.trash')}</span>
            <Kbd combo={SHORTCUTS.openTrash} />
          </Button>
        </DialogTrigger>
      </ShortcutTooltip>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t('nav.trash')}</DialogTitle>
          <DialogDescription>{t('trash.description')}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[50vh]">
          {loading && items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('trash.loading')}</p>
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('trash.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-1 pr-2">
              {items.map((item) => {
                const Icon = item.hostedDatabaseId ? Database : FileText;
                const disabled = busy !== null;
                return (
                  <li
                    key={item.id}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover"
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {displayName(item.name)}
                    </span>
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
                );
              })}
            </ul>
          )}
        </ScrollArea>

        {/* Nothing to purge → no footer: a disabled destructive button under
            "The trash is empty." reads as broken, not as a guard. */}
        {items.length > 0 && (
          <DialogFooter>
            <Button variant="destructive" disabled={busy !== null} onClick={() => void emptyTrash()}>
              {t('trash.emptyTrash')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
