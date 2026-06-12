import {useCallback, useEffect, useState} from 'react';
import type {PageMeta} from '@open-book/sdk';
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
import {Kbd} from '@/components/ui/kbd';
import {ScrollArea} from '@/components/ui/scroll-area';
import {useData} from '@/data';
import {useConfirm, useHud, useNavigation, useTranslation} from '@/providers';
import {SHORTCUTS} from '@/lib/shortcuts';

const displayName = (name: string | null): string =>
  name && name.trim().length > 0 ? name : 'Untitled';

/** "just now" / "5 mins ago" / "3 days ago" from an ISO timestamp. */
function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return 'just now';
  const units: [number, string][] = [
    [60, 'min'],
    [60, 'hour'],
    [24, 'day'],
  ];
  let value = secs;
  let label = 'sec';
  for (const [factor, name] of units) {
    if (value < factor) break;
    value = Math.round(value / factor);
    label = name;
  }
  return `${value} ${label}${value === 1 ? '' : 's'} ago`;
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
        title: `Permanently delete "${displayName(item.name)}"?`,
        description: 'This cannot be undone.',
        confirmText: 'Delete forever',
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
      title: 'Empty the trash?',
      description: 'Permanently delete everything in the trash. This cannot be undone.',
      confirmText: 'Empty trash',
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
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          className="flex h-7 grow justify-start gap-2 px-2 text-muted-foreground hover:text-foreground"
          aria-label="Trash"
        >
          <Trash2 className="h-4 w-4 shrink-0" />
          <span className="grow text-left">{t('nav.trash')}</span>
          <Kbd combo={SHORTCUTS.openTrash} />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Trash</DialogTitle>
          <DialogDescription>
            Deleted pages stay here until you restore them or they are cleaned up automatically.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[50vh]">
          {loading && items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">The trash is empty.</p>
          ) : (
            <ul className="flex flex-col gap-1 pr-2">
              {items.map((item) => {
                const Icon = item.hostedDatabaseId ? Database : FileText;
                const disabled = busy !== null;
                return (
                  <li
                    key={item.id}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50"
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {displayName(item.name)}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(item.deletedAt)}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      disabled={disabled}
                      onClick={() => void restore(item.id)}
                      aria-label={`Restore ${displayName(item.name)}`}
                      title="Restore"
                    >
                      <RotateCcw className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-destructive hover:text-destructive"
                      disabled={disabled}
                      onClick={() => void purge(item)}
                      aria-label={`Delete ${displayName(item.name)} forever`}
                      title="Delete forever"
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
              Empty trash
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
