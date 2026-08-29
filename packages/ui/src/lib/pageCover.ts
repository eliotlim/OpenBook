/**
 * Per-page cover images — the wide banner above a page's title (a gradient or an
 * image URL with a vertical focal point). Covers persist on the page document
 * (`page.properties`, see {@link lib/pageAppearance}) so they travel with the
 * page and sync across devices.
 */
import {readAppearanceFacet, subscribePageAppearance, useAppearanceFacet, writeAppearanceFacet} from '@/lib/pageAppearance';
export {COVER_GRADIENTS} from '@book.dev/sdk';

export type PageCover =
  | {kind: 'gradient'; css: string}
  | {kind: 'image'; url: string; position?: number};

/** Subscribe to cover changes (any page). Returns an unsubscribe fn. */
export const subscribePageCover = subscribePageAppearance;

/** The cover stored for a page, or `null` when none is set. */
export function readPageCover(pageId: string): PageCover | null {
  return readAppearanceFacet<PageCover>(pageId, 'cover');
}

/** Persist (or, with `null`, clear) a page's cover. */
export function writePageCover(pageId: string, cover: PageCover | null): void {
  writeAppearanceFacet(pageId, 'cover', cover);
}

/** React-subscribe to one page's cover; re-renders when it changes. */
export function usePageCover(pageId: string): PageCover | null {
  return useAppearanceFacet<PageCover>(pageId, 'cover');
}
