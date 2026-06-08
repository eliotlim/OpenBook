/**
 * Favourite (pinned) pages — an ordered list of page ids, kept in localStorage
 * (device-local, like {@link readPageIcon page icons}) so the sidebar, menus,
 * and command palette resolve the same set without a server round-trip.
 *
 * The list-transform core is pure and unit-tested; the localStorage wrapper and
 * a small in-process listener registry (localStorage doesn't notify the same
 * tab) drive live re-renders when a page is (un)favourited.
 */
const KEY = 'openbook.favorites';

/** Pure: toggle `id`'s membership, newest pinned first. */
export function toggleFavoriteId(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [id, ...list];
}

const read = (): string[] => {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

const listeners = new Set<() => void>();

const write = (list: string[]): void => {
  if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(list));
  listeners.forEach((cb) => cb());
};

/** The current favourites, in pinned order. */
export const readFavorites = (): string[] => read();

export const isFavorite = (id: string): boolean => read().includes(id);

/** Pin/unpin a page. */
export const toggleFavorite = (id: string): void => write(toggleFavoriteId(read(), id));

/** Drop a page from favourites (e.g. when it's deleted). No-op if absent. */
export const removeFavorite = (id: string): void => {
  const list = read();
  if (list.includes(id)) write(list.filter((x) => x !== id));
};

/** Subscribe to favourite changes. Returns an unsubscribe fn. */
export const subscribeFavorites = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
