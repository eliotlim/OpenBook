import {useSyncExternalStore} from 'react';

/**
 * The image lightbox: a single, app-wide full-viewport overlay that shows one
 * image at a time (LBX-1). A module-level store — not a React context — so the
 * block editor's image view can open it with a plain function call, without
 * depending on any provider being above it in the tree (block views are
 * deliberately provider-free). The overlay component ({@link
 * components/ImageLightbox}) subscribes via {@link useImageLightbox}.
 *
 * Intentionally minimal: just the picture `src`, its `alt`, and the element that
 * opened it (so focus can return there on close). A later zoom/pan layer (LBX-2)
 * can extend this state without changing the open/close contract.
 */
export interface LightboxState {
  /** The resolved `<img src>` — an object URL (assetId), a legacy data URL, or a
   *  direct URL. Whatever the block itself is displaying. */
  src: string;
  /** Alt text: the dialog's accessible label and, when set, a caption line. */
  alt: string;
  /** The element that opened the overlay; focus returns here on close. */
  trigger: HTMLElement | null;
}

let state: LightboxState | null = null;
const subscribers = new Set<() => void>();

const notify = (): void => subscribers.forEach((cb) => cb());

/** Open the lightbox on a picture. Replaces any currently-open image. */
export function openLightbox(next: LightboxState): void {
  state = next;
  notify();
}

/** Close the lightbox (idempotent). Returns focus to the trigger element. */
export function closeLightbox(): void {
  const prev = state;
  if (!prev) return;
  state = null;
  notify();
  // Restore focus to whatever opened the overlay, once the overlay has torn
  // down. `preventScroll` so returning focus never yanks the page around.
  const el = prev.trigger;
  if (el && typeof el.focus === 'function') {
    requestAnimationFrame(() => el.focus({preventScroll: true}));
  }
}

/** The current lightbox state, read outside React (`null` when closed). */
export const getLightbox = (): LightboxState | null => state;

const getSnapshot = (): LightboxState | null => state;
// The server never has an open lightbox; a stable null keeps SSR hydration calm.
const getServerSnapshot = (): LightboxState | null => null;

const subscribe = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
};

/** Reactive read of the current lightbox state (`null` when closed). */
export const useImageLightbox = (): LightboxState | null =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
