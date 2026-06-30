import type {Awareness} from 'y-protocols/awareness';

/**
 * The live presence/awareness of each open block-editor page, keyed by page id
 * (Collab T4) — the bridge that lets the remote-cursor/avatar surface (Collab T5)
 * read a page's peers + selections without the editor and the cursor layer knowing
 * about each other. Same module-singleton pattern as {@link registerOpenDoc}.
 *
 * T5 grabs `openAwareness(pageId)`, reads `awareness.getStates()` (a
 * `Map<clientID, {user, selection}>`), and listens to the awareness `'change'`
 * event to re-render. This module is the DATA seam only — it paints nothing.
 */

const instances = new Map<string, Awareness>();
const subscribers = new Set<() => void>();

const notify = (): void => subscribers.forEach((cb) => cb());

export function registerOpenAwareness(pageId: string, awareness: Awareness): () => void {
  instances.set(pageId, awareness);
  notify();
  return () => {
    if (instances.get(pageId) === awareness) {
      instances.delete(pageId);
      notify();
    }
  };
}

export const openAwareness = (pageId: string | null | undefined): Awareness | undefined =>
  pageId ? instances.get(pageId) : undefined;

/** Fires when an awareness is registered/removed (not on presence changes — listen
 *  to the awareness `'change'` event for those). */
export const subscribeOpenAwareness = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
};
