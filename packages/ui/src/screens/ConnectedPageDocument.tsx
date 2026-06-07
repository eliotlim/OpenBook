import React, {useCallback, useEffect, useRef, useState} from 'react';
import type {PageSnapshot, StoredPage} from '@open-book/sdk';
import {useData} from '@/data';
import {useConfirm, useNavigation, useTranslation} from '@/providers';
import {DEFAULT_PAGE_ICON, readPageIcon, writePageIcon} from '@/lib/pageIcon';
import {DatabaseView} from '@/components/database/DatabaseView';
import PageDocument from './PageDocument';

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
  const {t} = useTranslation();
  const {pages, deletePage, setPageHint, closePage} = useNavigation();

  const [title, setTitle] = useState('');
  const [icon, setIcon] = useState(DEFAULT_PAGE_ICON);
  const [incoming, setIncoming] = useState<{data: PageSnapshot; version: number} | undefined>(undefined);

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
    setIcon(readPageIcon(pageId));
    setIncoming(undefined);
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
    if (page) lastUpdatedRef.current = page.updatedAt;
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
      setIcon(emoji);
      writePageIcon(pageId, emoji);
    },
    [pageId],
  );

  const onDelete = useCallback(async () => {
    const ok = await confirm({
      title: t('confirm.trashTitle'),
      description: t('confirm.trashBody'),
      confirmText: t('confirm.trashConfirm'),
      destructive: true,
    });
    if (!ok) return;
    void deletePage(pageId);
  }, [pageId, deletePage, confirm, t]);

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

  // Whether this page hosts a database. Known definitively for top-level pages
  // (in the nav list); `undefined` for subpages so the view probes by page id.
  const meta = pages.find((p) => p.id === pageId);
  const databaseIdHint = meta ? meta.hostedDatabaseId : undefined;

  return (
    <PageDocument
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
      footer={<DatabaseView pageId={pageId} databaseIdHint={databaseIdHint} />}
    />
  );
};

export default ConnectedPageDocument;
