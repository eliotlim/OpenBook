/**
 * Per-page emoji icons live in localStorage (keyed by page id) rather than the
 * document payload, so the page header, sidebar, tabs, and database views all
 * resolve the same icon without a round-trip. Shared here so there is one key
 * format across the UI.
 */
const iconKey = (pageId: string): string => `openbook.icon.${pageId}`;

/** The default page icon when none has been chosen. */
export const DEFAULT_PAGE_ICON = '📄';

export const readPageIcon = (pageId: string): string =>
  (typeof localStorage !== 'undefined' && localStorage.getItem(iconKey(pageId))) || DEFAULT_PAGE_ICON;

export const writePageIcon = (pageId: string, emoji: string): void => {
  if (typeof localStorage !== 'undefined') localStorage.setItem(iconKey(pageId), emoji);
};
