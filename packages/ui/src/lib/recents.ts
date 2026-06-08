/**
 * Recently-visited pages — a most-recent-first list of page ids capped at
 * {@link MAX_RECENTS}, kept in localStorage (device-local). Powers the "Recent"
 * group in the command palette so jumping back to a page you were just on is a
 * couple of keystrokes.
 *
 * The list-transform core is pure and unit-tested; the localStorage wrapper and
 * an in-process listener registry drive live updates within the tab.
 */
const KEY = 'openbook.recents';
export const MAX_RECENTS = 12;

/** Pure: move `id` to the front (deduped), capped to `max`. */
export function recordRecentId(list: string[], id: string, max: number = MAX_RECENTS): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, max);
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

/** The current recents, most-recent first. */
export const readRecents = (): string[] => read();

/** Record a visit to `id` (moves it to the front). */
export const recordRecent = (id: string): void => {
  const next = recordRecentId(read(), id);
  // Avoid a redundant write+notify when the front is already this id.
  const cur = read();
  if (cur[0] === id && cur.length === next.length) return;
  write(next);
};

/** Subscribe to recents changes. Returns an unsubscribe fn. */
export const subscribeRecents = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
