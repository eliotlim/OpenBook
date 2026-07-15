import {useCallback, useState} from 'react';
import type {PageMeta} from '@book.dev/sdk';
import {useData} from '@/data';
import {useConfirm, useTranslation} from '@/providers';
import {t as bareT} from '@/i18n';

const displayName = (name: string | null): string =>
  name && name.trim().length > 0 ? name : bareT('common.untitled');

export interface TrashController {
  items: PageMeta[];
  loading: boolean;
  /** The id of the item currently being restored/purged, `'__all__'` while
   *  emptying, or `null` when idle — so a row (or the whole view) can disable. */
  busy: string | null;
  /** Re-list the trashed pages from the store. */
  refresh: () => Promise<void>;
  /** Restore a page; `onRestored` runs with the restored page (e.g. to navigate). */
  restore: (id: string) => Promise<void>;
  /** Permanently delete a page (guarded by a confirm). */
  purge: (item: PageMeta) => Promise<void>;
  /** Permanently delete everything in the trash (guarded by a confirm). */
  emptyTrash: () => Promise<void>;
}

/**
 * The trash's data + actions, shared by the quick {@link TrashDialog} overlay and
 * the full-page `?page=trash` view ({@link TrashScreen}) so both stay in lockstep.
 * Pass `onRestored` to react to a restore with the recovered page's id (the dialog
 * closes itself and navigates; the screen just navigates to it).
 */
export function useTrash(onRestored?: (pageId: string) => void): TrashController {
  const client = useData();
  const confirm = useConfirm();
  const {t} = useTranslation();
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

  const restore = useCallback(
    async (id: string) => {
      setBusy(id);
      try {
        const page = await client.restorePage(id);
        await refresh();
        if (page) onRestored?.(page.id);
      } finally {
        setBusy(null);
      }
    },
    [client, refresh, onRestored],
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
    [client, refresh, confirm, t],
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
  }, [client, refresh, confirm, t]);

  return {items, loading, busy, refresh, restore, purge, emptyTrash};
}
