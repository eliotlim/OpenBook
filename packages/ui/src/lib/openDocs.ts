import type * as Y from 'yjs';

/**
 * The live Y.Doc of each open block-editor page, keyed by page id — the
 * bridge that lets sibling surfaces (the dataflow split view) read and
 * subscribe to a document another pane owns, without the two components
 * knowing each other. Same module-singleton pattern as pageDocActions.
 */

const docs = new Map<string, Y.Doc>();
const subscribers = new Set<() => void>();

const notify = (): void => subscribers.forEach((cb) => cb());

export function registerOpenDoc(pageId: string, doc: Y.Doc): () => void {
  docs.set(pageId, doc);
  notify();
  return () => {
    if (docs.get(pageId) === doc) {
      docs.delete(pageId);
      notify();
    }
  };
}

export const openDoc = (pageId: string | null | undefined): Y.Doc | undefined =>
  pageId ? docs.get(pageId) : undefined;

/** Fires when a doc is registered/removed (not on edits — subscribe to the doc). */
export const subscribeOpenDocs = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
};
