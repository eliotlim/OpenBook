/**
 * A small bridge between the EditorJS subpage/database blocks and the app's
 * navigation. EditorJS instantiates block tools outside React's context (each
 * block mounts its own React root), so the blocks can't use `useNavigation`.
 * Instead {@link NavigationProvider} registers its actions here — the same
 * singleton pattern the reactive store uses — and the blocks call them.
 */

export type SubpageKind = 'page' | 'database';

/** A page candidate for the `@` link menu. */
export interface PageLinkResult {
  id: string;
  label: string;
  icon: string;
}

export interface PageLinkBridge {
  /** Create a child page nested under `parentId`; resolves to the new page id. */
  createSubpage: (parentId: string, kind: SubpageKind) => Promise<string>;
  /** Navigate to a page. */
  openPage: (id: string) => void;
  /** A display title for a page id. */
  label: (id: string) => string;
  /** The emoji icon for a page id. */
  icon: (id: string) => string;
  /** Existing top-level pages whose title matches `query` (best matches first). */
  searchPages: (query: string) => PageLinkResult[];
  /** Create a new page titled `name` (no navigation); resolves its id. */
  createPage: (name: string) => Promise<string>;
}

let bridge: PageLinkBridge | null = null;
const subscribers = new Set<() => void>();

/**
 * Install (or clear) the live bridge. Re-installing also notifies subscribers,
 * so the provider re-calling this when page titles change refreshes the blocks.
 */
export const setPageLinkBridge = (next: PageLinkBridge | null): void => {
  bridge = next;
  subscribers.forEach((cb) => cb());
};

/** Subscribe to bridge changes (title/icon updates). Returns an unsubscribe. */
export const subscribePageLinks = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
};

/** The bridge actions, safe to call before the provider mounts (they no-op). */
export const pageLinks: PageLinkBridge = {
  createSubpage: (parentId, kind) =>
    bridge ? bridge.createSubpage(parentId, kind) : Promise.reject(new Error('page links not ready')),
  openPage: (id) => bridge?.openPage(id),
  label: (id) => bridge?.label(id) ?? 'Untitled',
  icon: (id) => bridge?.icon(id) ?? '📄',
  searchPages: (query) => bridge?.searchPages(query) ?? [],
  createPage: (name) =>
    bridge ? bridge.createPage(name) : Promise.reject(new Error('page links not ready')),
};
