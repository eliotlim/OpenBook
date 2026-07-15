import {useCallback, useEffect} from 'react';
import {Trash2} from 'lucide-react';
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
import {useHud, useNavigation, useTranslation} from '@/providers';
import {useTrash} from '@/lib/useTrash';
import TrashList from '@/components/TrashList';
import {SHORTCUTS} from '@/lib/shortcuts';
import {SIDEBAR_HOVER} from '@/lib/sidebarStyles';
import {cn} from '@/lib/utils';

/**
 * The trash overlay: a quick peek at deleted pages that can be restored or
 * permanently removed, without leaving the current page. The full-page
 * `?page=trash` view ({@link TrashScreen}) shares the same list body + actions
 * (via {@link useTrash}); the server's cleanup job purges items automatically
 * after its retention window — this just exposes the manual controls.
 */
export default function TrashDialog() {
  const {t} = useTranslation();
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
  const trash = useTrash((pageId) => {
    selectPage(pageId);
    setOpen(false);
  });
  const {items, busy, refresh, emptyTrash} = trash;

  // Refresh whenever the trash opens — by trigger, menu, palette, or shortcut.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

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
          <TrashList trash={trash} />
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
