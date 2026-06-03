import React, {useCallback, useEffect, useRef, useState} from 'react';
import type {PageSnapshot, StoredPage} from '@open-book/sdk';
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
  // Number of our own writes (saves/renames) currently awaiting their server
  // response, plus a buffer of live events that arrived while one was in flight.
  // The server echoes our own writes back over the live stream; that echo can
  // arrive *before* the write's response updates lastUpdatedRef, so a naive
  // `updatedAt <= lastUpdatedRef` check races and re-applies our own save. That
  // re-render re-runs the reactive store, which mutates the DOM, which triggers
  // another autosave — a feedback loop that re-renders the page every second.
  // Buffering events until our in-flight writes settle closes the race: by the
  // time we process them, lastUpdatedRef reflects our write and the echo is
  // correctly suppressed.
  const writesInFlightRef = useRef(0);
  const bufferedPagesRef = useRef<StoredPage[]>([]);

  const applyPage = useCallback((page: StoredPage) => {
    // Our own echo or a stale event — ignore.
    if (page.updatedAt <= lastUpdatedRef.current) return;
    lastUpdatedRef.current = page.updatedAt;
    if (!titleActiveRef.current) {
      setTitle(page.name ?? '');
      nameRef.current = page.name ?? null;
    }
    versionRef.current += 1;
    setIncoming({data: page.data, version: versionRef.current});
  }, []);

  // Called when a write settles: drain any events that arrived mid-flight, now
  // that lastUpdatedRef reflects the write.
  const onWriteSettled = useCallback(() => {
    writesInFlightRef.current = Math.max(0, writesInFlightRef.current - 1);
    if (writesInFlightRef.current > 0) return;
    const buffered = bufferedPagesRef.current;
    bufferedPagesRef.current = [];
    for (const page of buffered) applyPage(page);
  }, [applyPage]);

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
    writesInFlightRef.current = 0;
    bufferedPagesRef.current = [];
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
      writesInFlightRef.current += 1;
      try {
        const saved = await client.savePage({id: pageId, name: nameRef.current, data: snapshot});
        lastUpdatedRef.current = saved.updatedAt;
      } finally {
        onWriteSettled();
      }
    },
    [client, pageId, onWriteSettled],
  );

  const onTitleChange = useCallback(
    (next: string) => {
      setTitle(next);
      nameRef.current = next.trim().length > 0 ? next : null;
      if (renameTimer.current) clearTimeout(renameTimer.current);
      renameTimer.current = setTimeout(() => {
        writesInFlightRef.current += 1;
        void client
          .renamePage(pageId, nameRef.current)
          .then((saved) => {
            lastUpdatedRef.current = saved.updatedAt;
          })
          .catch(() => undefined)
          .finally(() => onWriteSettled());
      }, 600);
    },
    [client, pageId, onWriteSettled],
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
        // If one of our own writes is in flight, its echo may reach us before
        // the write's response updates lastUpdatedRef. Buffer until it settles
        // (see writesInFlightRef) so we don't re-apply our own save.
        if (writesInFlightRef.current > 0) {
          bufferedPagesRef.current.push(page);
          return;
        }
        applyPage(page);
      },
      // Deletion is handled by the navigation list stream, which reselects.
    });
  }, [client, pageId, applyPage]);

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
