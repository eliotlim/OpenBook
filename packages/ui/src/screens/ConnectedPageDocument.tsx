import React, {useCallback, useEffect, useRef, useState} from 'react';
import type {PageSnapshot} from '@open-book/sdk';
import {useData} from '@/data';
import {useNavigation} from '@/providers';
import PageDocument from './PageDocument';

export interface ConnectedPageDocumentProps {
  /** Stable page id (UUID) this editor reads from and writes to. */
  pageId: string;
}

/**
 * A {@link PageDocument} wired to the active data client + {@link NavigationProvider}.
 * Loads the page's content and name on mount, autosaves content changes, renames
 * the page from the title field (debounced), and deletes it. Works identically
 * whether the client is the local Tauri server or a remote one.
 */
export const ConnectedPageDocument: React.FC<ConnectedPageDocumentProps> = ({pageId}) => {
  const client = useData();
  const {pages, renamePage, deletePage} = useNavigation();

  const [title, setTitle] = useState('');
  const nameRef = useRef<string | null>(null);
  const renameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the latest page list available without re-running the seed effect.
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  // Seed the title from the known page metadata on every page switch.
  useEffect(() => {
    const meta = pagesRef.current.find((p) => p.id === pageId);
    setTitle(meta?.name ?? '');
    nameRef.current = meta?.name ?? null;
    return () => {
      if (renameTimer.current) clearTimeout(renameTimer.current);
    };
  }, [pageId]);

  // Authoritative load of content + name from the store.
  const onLoad = useCallback(async (): Promise<PageSnapshot | null> => {
    const page = await client.getPage(pageId);
    nameRef.current = page?.name ?? null;
    setTitle(page?.name ?? '');
    return page ? page.data : null;
  }, [client, pageId]);

  // Content autosave. Uses the current name from the ref so it never clobbers it.
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
      onTitleChange={onTitleChange}
      onDelete={onDelete}
      onLoad={onLoad}
      onSave={onSave}
    />
  );
};

export default ConnectedPageDocument;
