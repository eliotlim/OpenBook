/**
 * Per-page emoji icons live in localStorage (keyed by page id) rather than the
 * document payload, so the page header, sidebar, tabs, and database views all
 * resolve the same icon without a round-trip. Shared here so there is one key
 * format across the UI.
 */
const iconKey = (pageId: string): string => `openbook.icon.${pageId}`;

/** The default page icon when none has been chosen. */
export const DEFAULT_PAGE_ICON = '📄';

/** The emoji a page has been given, or `null` when none is set. Lets callers
 *  (e.g. the sidebar tree) fall back to their own glyph instead of the default. */
export const readStoredPageIcon = (pageId: string): string | null =>
  (typeof localStorage !== 'undefined' && localStorage.getItem(iconKey(pageId))) || null;

export const readPageIcon = (pageId: string): string => {
  // The Home pseudo-page has a fixed identity everywhere it's named.
  if (pageId === 'home') return '\u{1F3E0}';
  return readStoredPageIcon(pageId) ?? DEFAULT_PAGE_ICON;
};

// Icons live in localStorage, which doesn't notify React on change within the
// same tab. A small in-process listener registry lets views that render an icon
// (the sidebar tree) refresh the moment the user picks a new one.
const listeners = new Set<() => void>();

/** Subscribe to icon changes (any page). Returns an unsubscribe fn. */
export const subscribePageIcon = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export const writePageIcon = (pageId: string, emoji: string): void => {
  if (typeof localStorage !== 'undefined') localStorage.setItem(iconKey(pageId), emoji);
  listeners.forEach((cb) => cb());
};
