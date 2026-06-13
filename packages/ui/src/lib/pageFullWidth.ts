/**
 * Per-page full-width preference. Like {@link lib/pageIcon} and
 * {@link lib/pageTheme}, this lives in localStorage keyed by page id rather than
 * a global app setting — full width is a property of *this page's* layout (a
 * wide table reads better full-bleed; a prose page reads better in a column),
 * so each page remembers its own choice instead of one switch flipping them all.
 */
import {useSyncExternalStore} from 'react';

const widthKey = (pageId: string): string => `openbook.fullwidth.${pageId}`;

const listeners = new Set<() => void>();

/** Subscribe to full-width changes (any page). Returns an unsubscribe fn. */
export const subscribePageFullWidth = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** Whether a page is set to full width (defaults to the centered column). */
export function readPageFullWidth(pageId: string): boolean {
  if (typeof localStorage === 'undefined' || !pageId) return false;
  return localStorage.getItem(widthKey(pageId)) === '1';
}

/** Persist (or clear, when false) a page's full-width preference, notifying views. */
export function writePageFullWidth(pageId: string, value: boolean): void {
  if (typeof localStorage === 'undefined' || !pageId) return;
  if (value) localStorage.setItem(widthKey(pageId), '1');
  else localStorage.removeItem(widthKey(pageId));
  listeners.forEach((cb) => cb());
}

/** Flip a page between full-width and the centered column. */
export function togglePageFullWidth(pageId: string): void {
  writePageFullWidth(pageId, !readPageFullWidth(pageId));
}

/** React-subscribe to one page's full-width flag; re-renders when it changes. */
export function usePageFullWidth(pageId: string): boolean {
  return useSyncExternalStore(
    subscribePageFullWidth,
    () => readPageFullWidth(pageId),
    () => false,
  );
}
