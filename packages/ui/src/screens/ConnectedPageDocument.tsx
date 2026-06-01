import React from 'react';
import {usePagePersistence} from '@/data';
import PageDocument from './PageDocument';

export interface ConnectedPageDocumentProps {
  /** Stable page id (UUID) this editor reads from and writes to. */
  pageId: string;
  /** Optional human-friendly name to persist alongside the page. */
  name?: string | null;
}

/**
 * A {@link PageDocument} wired to the active {@link DataProvider}. Loads the
 * page's snapshot on mount and autosaves changes back through the data client,
 * so it works identically whether the client is the local Tauri store or a
 * remote HTTP server.
 *
 * Keyed on `pageId` so switching pages remounts the editor with fresh content.
 */
export const ConnectedPageDocument: React.FC<ConnectedPageDocumentProps> = ({pageId, name}) => {
  const {onLoad, onSave} = usePagePersistence(pageId, name);
  return <PageDocument key={pageId} onLoad={onLoad} onSave={onSave} />;
};

export default ConnectedPageDocument;
