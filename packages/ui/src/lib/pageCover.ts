/**
 * Per-page cover images — the wide banner above a page's title. Like the page
 * icon and per-page theme, a cover is a local presentation choice stored in
 * localStorage (keyed by page id), so it shows instantly and offline without a
 * document save round-trip.
 *
 * A cover is either one of the curated {@link COVER_GRADIENTS} (a CSS background
 * string) or an image URL with a vertical focal point (`position`, 0–100%) so
 * the banner can be repositioned to frame the right part of a tall photo.
 */
import {useSyncExternalStore} from 'react';

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

const coverKey = (pageId: string): string => `openbook.cover.${pageId}`;

const listeners = new Set<() => void>();

/** Subscribe to cover changes (any page). Returns an unsubscribe fn. */
export const subscribePageCover = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

function parseCover(raw: string | null): PageCover | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as PageCover;
    if (v && v.kind === 'gradient' && typeof v.css === 'string') return v;
    if (v && v.kind === 'image' && typeof v.url === 'string') return v;
  } catch {
    // fall through
  }
  return null;
}

/** The cover stored for a page, or `null` when none is set. */
export function readPageCover(pageId: string): PageCover | null {
  if (typeof localStorage === 'undefined' || !pageId) return null;
  return parseCover(localStorage.getItem(coverKey(pageId)));
}

/** Persist (or, with `null`, clear) a page's cover and notify views. */
export function writePageCover(pageId: string, cover: PageCover | null): void {
  if (typeof localStorage === 'undefined' || !pageId) return;
  if (!cover) localStorage.removeItem(coverKey(pageId));
  else localStorage.setItem(coverKey(pageId), JSON.stringify(cover));
  listeners.forEach((cb) => cb());
}

// useSyncExternalStore needs a *stable* snapshot reference between renders, so
// we cache the parsed cover per page and only re-parse when the raw string
// changes — returning a fresh object every read would loop the store.
const snapCache = new Map<string, {raw: string | null; value: PageCover | null}>();
function coverSnapshot(pageId: string): PageCover | null {
  if (typeof localStorage === 'undefined' || !pageId) return null;
  const raw = localStorage.getItem(coverKey(pageId));
  const cached = snapCache.get(pageId);
  if (cached && cached.raw === raw) return cached.value;
  const value = parseCover(raw);
  snapCache.set(pageId, {raw, value});
  return value;
}

/** React-subscribe to one page's cover; re-renders when it changes. */
export function usePageCover(pageId: string): PageCover | null {
  return useSyncExternalStore(
    subscribePageCover,
    () => coverSnapshot(pageId),
    () => null,
  );
}
