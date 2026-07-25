/**
 * A small bridge between the subpage/database blocks and the app's navigation.
 * Block tools can run outside React's context (a block may mount its own React
 * root), so they can't use `useNavigation` directly.
 * Instead {@link NavigationProvider} registers its actions here — the same
 * singleton pattern the reactive store uses — and the blocks call them.
 */

export type SubpageKind = 'page' | 'database';

/** A page candidate for the `@` link menu. */
export interface PageLinkResult {
  id: string;
  label: string;
  icon: string;
  /** Ancestor chain ("Parent / Child") — disambiguates same-named pages. */
  path?: string;
}

export interface PageLinkBridge {
  /** Create a child page nested under `parentId`; resolves to the new page id. */
  createSubpage: (parentId: string, kind: SubpageKind) => Promise<string>;
  /** Navigate to a page. Pass `pane` to drive a specific pane (the one the link
   *  was clicked in) rather than whichever pane is focused. Pass `blockId` to
   *  land on (scroll/flash) a specific block within the destination page. */
  openPage: (id: string, pane?: 'primary' | 'secondary', blockId?: string) => void;
  /** A display title for a page id. */
  label: (id: string) => string;
  /** The emoji icon for a page id. */
  icon: (id: string) => string;
  /** Pages whose title matches `query` (best matches first). Pass
   *  `{databasesOnly: true}` to restrict to pages that host a database. */
  searchPages: (query: string, opts?: {databasesOnly?: boolean}) => PageLinkResult[];
  /** Database ROWS whose title matches `query` (rows are pages too, so `@` can
   *  link one). Async — rows live under each database, not the page list. */
  searchRows?: (query: string, limit?: number) => Promise<PageLinkResult[]>;
  /** Create a new page titled `name` (no navigation); resolves its id. Pass
   *  `parentId` to nest it under a page (the "[[" wikilink auto-create nests the
   *  new page under the page it was typed in). */
  createPage: (name: string, parentId?: string | null) => Promise<string>;
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
  openPage: (id, pane, blockId) => bridge?.openPage(id, pane, blockId),
  label: (id) => bridge?.label(id) ?? 'Untitled',
  icon: (id) => bridge?.icon(id) ?? '📄',
  searchPages: (query, opts) => bridge?.searchPages(query, opts) ?? [],
  searchRows: (query, limit) => bridge?.searchRows?.(query, limit) ?? Promise.resolve([]),
  createPage: (name, parentId) =>
    bridge ? bridge.createPage(name, parentId) : Promise.reject(new Error('page links not ready')),
};
