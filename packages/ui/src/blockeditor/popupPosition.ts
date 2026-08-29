/** A fixed-position popup's measured viewport coordinates. */
export interface PopupPosition {
  left: number;
  top: number;
  maxHeight?: number;
  placement: 'above' | 'below';
}

interface PopupSize {
  width: number;
  height: number;
}

export interface PopupPositionOptions {
  /** Which side to use while the measured box fits there. */
  preferredPlacement?: PopupPosition['placement'];
  /** Align the popup's leading edge or centre to the anchor. */
  align?: 'start' | 'center';
  /** Space reserved when deciding whether a side has enough room. */
  availableSpaceInset?: number;
  /** Visible space between the anchor and popup. */
  anchorGap?: number;
  /** Horizontal edge clamp (and the above-placement top clamp). */
  viewportMargin?: number;
  /** Smallest useful scrollable menu height. Ignored when maxHeight is null. */
  minHeight?: number;
  /** Largest scrollable menu height; null leaves the measured height intact. */
  maxHeight?: number | null;
  /** Preserve a popup whose content is shorter than the configured maximum. */
  capHeightToContent?: boolean;
  /** Used only before the rendered element exposes measurable dimensions. */
  fallbackSize?: PopupSize;
  /** Frames allowed for a not-yet-painted anchor to acquire a real rect. */
  retryFrames?: number;
}

const RENDERED_MENU_MAX_HEIGHT = 304;

/** Canonical menu geometry: the old 14 / 6 / 8 values, named once. */
export const POPUP_POSITION_DEFAULTS = {
  availableSpaceInset: 14,
  anchorGap: 6,
  viewportMargin: 8,
  minHeight: 120,
  maxHeight: 300,
  fallbackSize: {width: 272, height: RENDERED_MENU_MAX_HEIGHT},
  retryFrames: 20,
} as const;

/** SlashMenu historically allowed the full CSS 19rem rather than 300px. */
export const SLASH_MENU_POSITION_OPTIONS = {
  maxHeight: RENDERED_MENU_MAX_HEIGHT,
} satisfies PopupPositionOptions;

const INLINE_TOOLBAR_GAP = 8; // was baked into .obe-toolbar's CSS transform

/**
 * The toolbar is centred and above-first. Its flip threshold is now its
 * measured height plus the existing gap and edge allowance, rather than 56px.
 * Its edge clamp now uses the shared menu viewport margin.
 */
export const INLINE_TOOLBAR_POSITION_OPTIONS = {
  preferredPlacement: 'above',
  align: 'center',
  availableSpaceInset: INLINE_TOOLBAR_GAP + POPUP_POSITION_DEFAULTS.viewportMargin,
  anchorGap: INLINE_TOOLBAR_GAP,
  viewportMargin: POPUP_POSITION_DEFAULTS.viewportMargin, // 8 — old centre clamp kept the toolbar ~12px off each edge; 8px matches the menus
  maxHeight: null,
} satisfies PopupPositionOptions;

const isZeroRect = (rect: DOMRect | undefined | null): boolean =>
  !rect || (rect.width === 0 && rect.height === 0 && rect.x === 0 && rect.y === 0);

/** Read the live selection rect, optionally falling back to its editor block. */
export function selectionAnchorRect(anchorEl: HTMLElement | null, fallbackToElement = false): DOMRect | null {
  const selection = document.getSelection();
  const selectionRect =
    selection && selection.rangeCount > 0 && anchorEl?.contains(selection.anchorNode)
      ? selection.getRangeAt(0).getBoundingClientRect()
      : null;
  if (!isZeroRect(selectionRect)) return selectionRect;
  return fallbackToElement ? anchorEl?.getBoundingClientRect() ?? null : selectionRect;
}

interface ObservePopupPositionArgs {
  popup: () => HTMLElement | null;
  anchor: () => DOMRect | null | undefined;
  /** Optional clipping boundary; viewport remains the fallback. */
  boundary?: () => HTMLElement | null;
  onPosition: (position: PopupPosition) => void;
  options?: PopupPositionOptions;
}

/**
 * Measure and track a fixed popup. The returned cleanup cancels anchor retries
 * and removes the viewport-resize re-clamp listener.
 */
export function observePopupPosition({
  popup,
  anchor,
  boundary,
  onPosition,
  options = {},
}: ObservePopupPositionArgs): () => void {
  const preferredPlacement = options.preferredPlacement ?? 'below';
  const align = options.align ?? 'start';
  const availableSpaceInset = options.availableSpaceInset ?? POPUP_POSITION_DEFAULTS.availableSpaceInset;
  const anchorGap = options.anchorGap ?? POPUP_POSITION_DEFAULTS.anchorGap;
  const viewportMargin = options.viewportMargin ?? POPUP_POSITION_DEFAULTS.viewportMargin;
  const minHeight = options.minHeight ?? POPUP_POSITION_DEFAULTS.minHeight;
  const maxHeightOption = options.maxHeight === undefined ? POPUP_POSITION_DEFAULTS.maxHeight : options.maxHeight;
  const fallbackSize = options.fallbackSize ?? POPUP_POSITION_DEFAULTS.fallbackSize;
  const retryFrames = options.retryFrames ?? POPUP_POSITION_DEFAULTS.retryFrames;
  let raf = 0;
  let attempts = 0;

  const measure = (): void => {
    const rect = anchor();
    if (isZeroRect(rect)) {
      if (attempts++ < retryFrames) raf = requestAnimationFrame(measure);
      return;
    }

    const element = popup();
    // Remove the previous viewport constraint while measuring. Otherwise a
    // filtered short list can permanently cap a later expanded result set.
    const previousMaxHeight = element?.style.maxHeight;
    if (element) element.style.maxHeight = '';
    const width = element?.offsetWidth || fallbackSize.width;
    const height = element?.offsetHeight || fallbackSize.height;
    if (element) element.style.maxHeight = previousMaxHeight ?? '';
    const boundaryRect = boundary?.()?.getBoundingClientRect();
    const boundaryTop = Math.max(0, boundaryRect?.top ?? 0);
    const boundaryBottom = Math.min(window.innerHeight, boundaryRect?.bottom ?? window.innerHeight);
    const boundaryLeft = Math.max(0, boundaryRect?.left ?? 0);
    const boundaryRight = Math.min(window.innerWidth, boundaryRect?.right ?? window.innerWidth);
    const available = {
      above: rect!.top - boundaryTop - availableSpaceInset,
      below: boundaryBottom - rect!.bottom - availableSpaceInset,
    };
    const otherPlacement = preferredPlacement === 'above' ? 'below' : 'above';
    const placement =
      height > available[preferredPlacement] && available[otherPlacement] > available[preferredPlacement]
        ? otherPlacement
        : preferredPlacement;
    const maxHeightLimit = options.capHeightToContent
      ? Math.min(options.maxHeight ?? Infinity, height)
      : maxHeightOption;
    const maxHeight =
      maxHeightOption === null
        ? undefined
        : Math.max(minHeight, Math.min(maxHeightLimit!, available[placement]));
    const shownHeight = maxHeight === undefined ? height : Math.min(height, maxHeight);
    const top =
      placement === 'above'
        ? Math.max(boundaryTop + viewportMargin, rect!.top - anchorGap - shownHeight)
        : boundaryRect
          ? Math.min(rect!.bottom + anchorGap, boundaryBottom - viewportMargin - shownHeight)
          : rect!.bottom + anchorGap;
    const anchorLeft = align === 'center' ? rect!.left + rect!.width / 2 - width / 2 : rect!.left;
    const left = Math.max(
      boundaryLeft + viewportMargin,
      Math.min(anchorLeft, boundaryRight - width - viewportMargin),
    );

    onPosition({left, top, maxHeight, placement});
  };

  const onResize = (): void => {
    cancelAnimationFrame(raf);
    attempts = 0;
    measure();
  };

  measure();
  window.addEventListener('resize', onResize);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
  };
}
