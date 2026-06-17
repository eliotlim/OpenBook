/**
 * Per-page emoji icons. Icons now persist on the page document
 * (`page.properties[sys_icon]`, see {@link ICON_PROPERTY_ID}) so they travel with
 * the page and sync across devices — but they're read in *many* places (sidebar,
 * tabs, mentions, database rows, search) for pages other than the open one, so a
 * synchronous read must stay cheap. This module keeps an in-memory cache of every
 * known page's icon, hydrated in bulk from the list projections that already
 * carry it ({@link PageMeta.icon} via the sidebar, {@link DatabaseRow.properties}
 * via the database views, and the open page), and writes through a registered
 * backend that persists to the server. The synchronous `readPageIcon`/
 * `writePageIcon`/`subscribePageIcon` API is unchanged, so every call site keeps
 * working. A one-time migration lifts legacy localStorage icons into the document.
 */
import {useSyncExternalStore} from 'react';
import {ICON_PROPERTY_ID} from '@open-book/sdk';

/** The default page icon when none has been chosen. */
export const DEFAULT_PAGE_ICON = '📄';
/** The Home pseudo-page has a fixed identity everywhere it's named. */
const HOME_ICON = '\u{1F3E0}';

// pageId → emoji ('' = known to have no icon; missing = not yet hydrated).
const cache = new Map<string, string>();
const listeners = new Set<() => void>();
const notify = (): void => listeners.forEach((cb) => cb());

/** Subscribe to icon changes (any page). Returns an unsubscribe fn. */
export const subscribePageIcon = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

// Persist a page's icon to the document (`null` clears it). Registered by a host
// component that holds the data client (see PageAppearanceHost).
let persist: ((pageId: string, emoji: string | null) => void) | null = null;
export function setIconPersister(fn: ((pageId: string, emoji: string | null) => void) | null): void {
  persist = fn;
}

/** The emoji a page has been given, or `null` when none is set. Lets callers
 *  (e.g. the sidebar tree) fall back to their own glyph instead of the default. */
export const readStoredPageIcon = (pageId: string): string | null => cache.get(pageId) || null;

export const readPageIcon = (pageId: string): string => {
  if (pageId === 'home') return HOME_ICON;
  return cache.get(pageId) || DEFAULT_PAGE_ICON;
};

export const writePageIcon = (pageId: string, emoji: string): void => {
  const next = emoji || '';
  if (cache.get(pageId) === next) return;
  cache.set(pageId, next);
  persist?.(pageId, next || null);
  notify();
};

const legacyKey = (id: string): string => `openbook.icon.${id}`;

/**
 * Bulk-hydrate icons from a list projection — {@link PageMeta} entries
 * (`{id, icon}`) or database rows (`{id, icon: properties[sys_icon]}`). Lifts any
 * legacy localStorage icon into the document the first time a page is seen
 * without a stored one. The list is authoritative for the pages it names.
 */
export function hydratePageIcons(entries: Array<{id: string; icon?: string | null}>): void {
  let changed = false;
  for (const {id, icon} of entries) {
    if (!id) continue;
    const value = icon ?? '';
    if (!value && typeof localStorage !== 'undefined') {
      const legacy = localStorage.getItem(legacyKey(id));
      if (legacy) {
        localStorage.removeItem(legacyKey(id));
        if (cache.get(id) !== legacy) {
          cache.set(id, legacy);
          changed = true;
        }
        persist?.(id, legacy); // migrate into the document
        continue;
      }
    }
    if (cache.get(id) !== value) {
      cache.set(id, value);
      changed = true;
    }
  }
  if (changed) notify();
}

/** React-subscribe to one page's icon; re-renders when it changes. */
export function usePageIcon(pageId: string): string {
  return useSyncExternalStore(
    subscribePageIcon,
    () => readPageIcon(pageId),
    () => (pageId === 'home' ? HOME_ICON : DEFAULT_PAGE_ICON),
  );
}

/** The reserved property id icons persist under (re-exported for hydration). */
export {ICON_PROPERTY_ID};
