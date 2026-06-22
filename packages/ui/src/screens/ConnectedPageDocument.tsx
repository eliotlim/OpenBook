import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ICON_PROPERTY_ID, type PageSnapshot, type StoredPage} from '@book.dev/sdk';
import {useData} from '@/data';
import {useConfirm, useNavigation, usePreferences, useTranslation} from '@/providers';
import {hydratePageIcons, usePageIcon, writePageIcon} from '@/lib/pageIcon';
import {DatabaseView} from '@/components/database/DatabaseView';
import BlockPageDocument from './BlockPageDocument';

export interface ConnectedPageDocumentProps {
  /** Stable page id (UUID) this editor reads from and writes to. */
  pageId: string;
}


/**
 * A {@link PageDocument} wired to the data client + {@link NavigationProvider}.
 * Loads content + name, autosaves edits, renames from the title field, and —
 * for real-time collaboration — subscribes to the server's live page stream and
 * applies snapshots saved by other clients. Our own saves carry an `updatedAt`
 * we remember, so the echoed event is ignored.
 */
export const ConnectedPageDocument: React.FC<ConnectedPageDocumentProps> = ({pageId}) => {
  const client = useData();
  const confirm = useConfirm();
  const {preferences} = usePreferences();
  const {t} = useTranslation();
  const {pages, deletePage, setPageHint, closePage} = useNavigation();

  const [title, setTitle] = useState('');
  // The icon lives on page.properties (lib/pageIcon's cache); read it reactively
  // so it updates when the page loads or the user picks a new one.
  const icon = usePageIcon(pageId);
  const [incoming, setIncoming] = useState<{data: PageSnapshot; version: number} | undefined>(undefined);
  // The hosted-database id resolved from the page record itself (getPage /
  // subscribePage both join it). This is independent of the nav `pages` list, so
  // it's available right after a database page is created — before the list has
  // re-streamed to include it — which keeps the editor in `compact` layout from
  // the first paint instead of briefly reserving a document's worth of trailing
  // whitespace above the view. `undefined` = not yet known (probe by page id).
  const [resolvedHostedDbId, setResolvedHostedDbId] = useState<string | null | undefined>(undefined);

  const nameRef = useRef<string | null>(null);
  const renameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Highest updatedAt this client has saved or applied — used to drop stale
  // events. Echo handling (not re-saving content a peer sent us) lives in
  // PageDocument's content-digest check, so this is just an ordering guard.
  const lastUpdatedRef = useRef<string>('');
  const titleActiveRef = useRef(false);
  const versionRef = useRef(0);

  const applyPage = useCallback(
    (page: StoredPage) => {
      // Stale event (older than what we've already applied/saved) — ignore.
      if (page.updatedAt <= lastUpdatedRef.current) return;
      lastUpdatedRef.current = page.updatedAt;
      if (!titleActiveRef.current) {
        setTitle(page.name ?? '');
        nameRef.current = page.name ?? null;
        setPageHint(pageId, page.name);
      }
      setResolvedHostedDbId(page.hostedDatabaseId);
      hydratePageIcons([{id: page.id, icon: page.properties[ICON_PROPERTY_ID] as string | null | undefined}]);
      versionRef.current += 1;
      setIncoming({data: page.data, version: versionRef.current});
    },
    [pageId, setPageHint],
  );

  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  // Seed title/icon and reset live state on every page switch.
  useEffect(() => {
    const meta = pagesRef.current.find((p) => p.id === pageId);
    setTitle(meta?.name ?? '');
    nameRef.current = meta?.name ?? null;
    setIncoming(undefined);
    // Seed from the nav-list meta when we have it; otherwise leave `undefined`
    // until getPage/subscribePage resolves it (don't carry the prior page's id).
    setResolvedHostedDbId(meta ? meta.hostedDatabaseId : undefined);
    lastUpdatedRef.current = meta?.updatedAt ?? '';
    return () => {
      if (renameTimer.current) clearTimeout(renameTimer.current);
    };
  }, [pageId]);

  const onLoad = useCallback(async (): Promise<PageSnapshot | null> => {
    const page = await client.getPage(pageId);
    nameRef.current = page?.name ?? null;
    setTitle(page?.name ?? '');
    setPageHint(pageId, page?.name ?? null);
    if (page) {
      lastUpdatedRef.current = page.updatedAt;
      setResolvedHostedDbId(page.hostedDatabaseId);
      hydratePageIcons([{id: page.id, icon: page.properties[ICON_PROPERTY_ID] as string | null | undefined}]);
    }
    return page ? page.data : null;
  }, [client, pageId, setPageHint]);

  const onSave = useCallback(
    async (snapshot: PageSnapshot): Promise<void> => {
      const saved = await client.savePage({id: pageId, name: nameRef.current, data: snapshot});
      lastUpdatedRef.current = saved.updatedAt;
    },
    [client, pageId],
  );

  const onTitleChange = useCallback(
    (next: string) => {
      setTitle(next);
      nameRef.current = next.trim().length > 0 ? next : null;
      setPageHint(pageId, nameRef.current);
      if (renameTimer.current) clearTimeout(renameTimer.current);
      renameTimer.current = setTimeout(() => {
        void client
          .renamePage(pageId, nameRef.current)
          .then((saved) => {
            lastUpdatedRef.current = saved.updatedAt;
          })
          .catch(() => undefined);
      }, 600);
    },
    [client, pageId],
  );

  const onIconChange = useCallback(
    (emoji: string) => {
      writePageIcon(pageId, emoji);
    },
    [pageId],
  );

  const onDelete = useCallback(async () => {
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
    void deletePage(pageId);
  }, [pageId, deletePage, confirm, preferences.general.confirmOnTrash, t]);

  const onTitleActiveChange = useCallback((active: boolean) => {
    titleActiveRef.current = active;
  }, []);

  // Real-time: apply page snapshots saved by other clients. Our own echoes are
  // harmless now — applying identical content is a no-op patch and the
  // content-digest check in PageDocument stops it being re-saved — so we no
  // longer need to race-guard the echo here.
  useEffect(() => {
    return client.subscribePage(pageId, {
      onPage: (page) => applyPage(page),
      // Close any tab showing this page when it is deleted elsewhere. Top-level
      // pages are also covered by the list stream; this additionally handles
      // subpages (database rows), which never appear in the page list.
      onDeleted: () => closePage(pageId),
    });
  }, [client, pageId, applyPage, closePage]);

  // Whether this page hosts a database. The nav `pages` list knows this for
  // top-level pages, but not for freshly-created pages (not yet re-streamed) or
  // subpages (database rows, never listed). So prefer the list value when present
  // and fall back to the id resolved from the page record itself — keeping both
  // the `compact` editor layout and the hosted view correct from the first paint.
  const meta = pages.find((p) => p.id === pageId);
  const databaseIdHint = meta ? meta.hostedDatabaseId : resolvedHostedDbId;

  return (
    <BlockPageDocument
      key={pageId}
      title={title}
      icon={icon}
      incoming={incoming}
      onTitleChange={onTitleChange}
      onTitleActiveChange={onTitleActiveChange}
      onIconChange={onIconChange}
      onDelete={onDelete}
      onLoad={onLoad}
      onSave={onSave}
      pageId={pageId}
      hasDatabase={!!databaseIdHint}
      footer={<DatabaseView pageId={pageId} databaseIdHint={databaseIdHint} />}
    />
  );
};

export default ConnectedPageDocument;
