import React, {useCallback, useEffect, useRef, useState} from 'react';
import type {PageSnapshot} from '@open-book/sdk';
import {useData} from '@/data';
import {useNavigation} from '@/providers';
import PageDocument from './PageDocument';

export interface ConnectedPageDocumentProps {
  /** Stable page id (UUID) this editor reads from and writes to. */
  pageId: string;
}

const iconKey = (pageId: string) => `openbook.icon.${pageId}`;
const readIcon = (pageId: string): string =>
  (typeof localStorage !== 'undefined' && localStorage.getItem(iconKey(pageId))) || '📄';
const writeIcon = (pageId: string, emoji: string): void => {
  if (typeof localStorage !== 'undefined') localStorage.setItem(iconKey(pageId), emoji);
};

/**
 * A {@link PageDocument} wired to the data client + {@link NavigationProvider}.
 * Loads content + name, autosaves edits, renames from the title field, and —
 * for real-time collaboration — subscribes to the server's live page stream and
 * applies snapshots saved by other clients. Our own saves carry an `updatedAt`
 * we remember, so the echoed event is ignored.
 */
export const ConnectedPageDocument: React.FC<ConnectedPageDocumentProps> = ({pageId}) => {
  const client = useData();
  const {pages, deletePage} = useNavigation();

  const [title, setTitle] = useState('');
  const [icon, setIcon] = useState('📄');
  const [incoming, setIncoming] = useState<{data: PageSnapshot; version: number} | undefined>(undefined);

  const nameRef = useRef<string | null>(null);
  const renameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Highest updatedAt this client has saved or applied — used to ignore echoes.
  const lastUpdatedRef = useRef<string>('');
  const titleActiveRef = useRef(false);
  const versionRef = useRef(0);

  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  // Seed title/icon and reset live state on every page switch.
  useEffect(() => {
    const meta = pagesRef.current.find((p) => p.id === pageId);
    setTitle(meta?.name ?? '');
    nameRef.current = meta?.name ?? null;
    setIcon(readIcon(pageId));
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
    if (page) lastUpdatedRef.current = page.updatedAt;
    return page ? page.data : null;
  }, [client, pageId]);

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
      writeIcon(pageId, emoji);
    },
    [pageId],
  );

  const onDelete = useCallback(() => {
    if (typeof window !== 'undefined' && !window.confirm('Delete this page? This cannot be undone.')) {
      return;
    }
    void deletePage(pageId);
  }, [pageId, deletePage]);

  const onTitleActiveChange = useCallback((active: boolean) => {
    titleActiveRef.current = active;
  }, []);

  // Real-time: apply page snapshots saved by other clients.
  useEffect(() => {
    return client.subscribePage(pageId, {
      onPage: (page) => {
        // Ignore our own echo and any stale event.
        if (page.updatedAt <= lastUpdatedRef.current) return;
        lastUpdatedRef.current = page.updatedAt;
        if (!titleActiveRef.current) {
          setTitle(page.name ?? '');
          nameRef.current = page.name ?? null;
        }
        versionRef.current += 1;
        setIncoming({data: page.data, version: versionRef.current});
      },
      // Deletion is handled by the navigation list stream, which reselects.
    });
  }, [client, pageId]);

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
    />
  );
};

export default ConnectedPageDocument;
