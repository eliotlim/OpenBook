/**
 * Per-page save status, published by the open document(s) and read by the shell
 * chrome (the page-actions cluster shows the *targeted* page's status). A module
 * singleton with a small listener registry — same bridge pattern as
 * {@link lib/pageDocActions} — so the documents and the chrome never reference
 * each other, and a split view can show each pane's page status independently.
 */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'save failed';

const statuses = new Map<string, SaveStatus>();
const listeners = new Set<() => void>();
let version = 0;

/** Publish a page's save status (call from the document; clears on unmount). */
export function setPageSaveStatus(pageId: string | null | undefined, status: SaveStatus | null): void {
  if (!pageId) return;
  if (status === null) statuses.delete(pageId);
  else statuses.set(pageId, status);
  version += 1;
  listeners.forEach((cb) => cb());
}

export const pageSaveStatus = (pageId: string | null | undefined): SaveStatus =>
  (pageId && statuses.get(pageId)) || 'idle';

export const subscribePageSaveStatus = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** Monotonic change counter — pair with useSyncExternalStore. */
export const pageSaveStatusVersion = (): number => version;
