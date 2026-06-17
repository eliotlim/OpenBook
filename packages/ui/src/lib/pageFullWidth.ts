/**
 * Per-page full-width preference — a property of *this page's* layout (a wide
 * table reads better full-bleed; a prose page reads better in a column). Like
 * the per-page theme/cover/fonts it now persists on the page document
 * (`page.properties`, see {@link lib/pageAppearance}) so the choice travels with
 * the page and syncs across devices.
 */
import {readAppearanceFacet, subscribePageAppearance, useAppearanceFacet, writeAppearanceFacet} from '@/lib/pageAppearance';

/** Subscribe to full-width changes (any page). Returns an unsubscribe fn. */
export const subscribePageFullWidth = subscribePageAppearance;

/** Whether a page is set to full width (defaults to the centered column). */
export function readPageFullWidth(pageId: string): boolean {
  return readAppearanceFacet<boolean>(pageId, 'fullWidth') === true;
}

/** Persist (or clear, when false) a page's full-width preference. */
export function writePageFullWidth(pageId: string, value: boolean): void {
  writeAppearanceFacet(pageId, 'fullWidth', value ? true : null);
}

/** Flip a page between full-width and the centered column. */
export function togglePageFullWidth(pageId: string): void {
  writePageFullWidth(pageId, !readPageFullWidth(pageId));
}

/** React-subscribe to one page's full-width flag; re-renders when it changes. */
export function usePageFullWidth(pageId: string): boolean {
  return useAppearanceFacet<boolean>(pageId, 'fullWidth') === true;
}
