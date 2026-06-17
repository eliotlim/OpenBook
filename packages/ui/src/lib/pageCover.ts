/**
 * Per-page cover images — the wide banner above a page's title (a gradient or an
 * image URL with a vertical focal point). Covers persist on the page document
 * (`page.properties`, see {@link lib/pageAppearance}) so they travel with the
 * page and sync across devices.
 */
import {readAppearanceFacet, subscribePageAppearance, useAppearanceFacet, writeAppearanceFacet} from '@/lib/pageAppearance';

export type PageCover =
  | {kind: 'gradient'; css: string}
  | {kind: 'image'; url: string; position?: number};

/** Curated gradient covers — tasteful in both light and dark, no image needed. */
export const COVER_GRADIENTS: ReadonlyArray<{id: string; css: string}> = [
  {id: 'dawn', css: 'linear-gradient(120deg, #f6d365 0%, #fda085 100%)'},
  {id: 'ocean', css: 'linear-gradient(120deg, #4facfe 0%, #00f2fe 100%)'},
  {id: 'dusk', css: 'linear-gradient(120deg, #a18cd1 0%, #fbc2eb 100%)'},
  {id: 'forest', css: 'linear-gradient(120deg, #0ba360 0%, #3cba92 100%)'},
  {id: 'ember', css: 'linear-gradient(120deg, #ff6a88 0%, #ff99ac 60%, #ffc3a0 100%)'},
  {id: 'slate', css: 'linear-gradient(120deg, #2b5876 0%, #4e4376 100%)'},
  {id: 'citrus', css: 'linear-gradient(120deg, #f7971e 0%, #ffd200 100%)'},
  {id: 'mint', css: 'linear-gradient(120deg, #43e97b 0%, #38f9d7 100%)'},
  {id: 'grape', css: 'linear-gradient(120deg, #667eea 0%, #764ba2 100%)'},
  {id: 'sand', css: 'linear-gradient(120deg, #e6dada 0%, #d3a17b 100%)'},
  {id: 'rose', css: 'linear-gradient(120deg, #ee9ca7 0%, #ffdde1 100%)'},
  {id: 'night', css: 'linear-gradient(120deg, #232526 0%, #414345 100%)'},
];

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
