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
 * A {@link PageDocument} wired to the active data client + {@link NavigationProvider}.
 * Loads the page's content and name on mount, autosaves content changes, renames
 * the page from the title field (debounced), and deletes it.
 */
export const ConnectedPageDocument: React.FC<ConnectedPageDocumentProps> = ({pageId}) => {
  const client = useData();
  const {pages, renamePage, deletePage} = useNavigation();

  const [title, setTitle] = useState('');
  const [icon, setIcon] = useState('📄');
  const nameRef = useRef<string | null>(null);
  const renameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  // Seed title + icon on every page switch.
  useEffect(() => {
    const meta = pagesRef.current.find((p) => p.id === pageId);
    setTitle(meta?.name ?? '');
    nameRef.current = meta?.name ?? null;
    setIcon(readIcon(pageId));
    return () => {
      if (renameTimer.current) clearTimeout(renameTimer.current);
    };
  }, [pageId]);

  const onLoad = useCallback(async (): Promise<PageSnapshot | null> => {
    const page = await client.getPage(pageId);
    nameRef.current = page?.name ?? null;
    setTitle(page?.name ?? '');
    return page ? page.data : null;
  }, [client, pageId]);

  const onSave = useCallback(
    async (snapshot: PageSnapshot): Promise<void> => {
      await client.savePage({id: pageId, name: nameRef.current, data: snapshot});
    },
    [client, pageId],
  );

  const onTitleChange = useCallback(
    (next: string) => {
      setTitle(next);
      nameRef.current = next.trim().length > 0 ? next : null;
      if (renameTimer.current) clearTimeout(renameTimer.current);
      renameTimer.current = setTimeout(() => {
        void renamePage(pageId, nameRef.current).catch(() => undefined);
      }, 600);
    },
    [pageId, renamePage],
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

  return (
    <PageDocument
      key={pageId}
      title={title}
      icon={icon}
      onTitleChange={onTitleChange}
      onIconChange={onIconChange}
      onDelete={onDelete}
      onLoad={onLoad}
      onSave={onSave}
    />
  );
};

export default ConnectedPageDocument;
