/**
 * A tiny in-memory bridge for the suggestions/comments Review side pane. A
 * "Review" affordance (the agent panel, a page header control, an inline
 * accept/reject) opens the {@link REVIEW_PANE_ID} pseudo-pane (reusing the
 * split mechanism, like the page-customise pane) and records which page it's
 * reviewing here; the side-pane body reads the target and lists that page's
 * open suggestions + threads. Optionally focuses one suggestion or block thread.
 * Ephemeral — never persisted to the URL.
 */
let targetPageId: string | null = null;
/** A suggestion id to scroll to / expand when the pane opens, if any. */
let focusSuggestionId: string | null = null;
/** A block id whose comment thread to focus when the pane opens, if any. */
let focusBlockId: string | null = null;
/** Bumped on every open request so the pane re-focuses even on the same target. */
let revision = 0;

const listeners = new Set<() => void>();

/** Subscribe to review-target changes. Returns an unsubscribe fn. */
export const subscribeReviewPane = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export interface ReviewTarget {
  pageId: string | null;
  focusSuggestionId: string | null;
  focusBlockId: string | null;
  revision: number;
}

/** The page currently under review (plus any focused suggestion/block), or null. */
export const getReviewTarget = (): ReviewTarget => ({
  pageId: targetPageId,
  focusSuggestionId,
  focusBlockId,
  revision,
});

/**
 * Point the Review side pane at a page (does NOT open the pane itself — the
 * caller also calls `openInSplit(REVIEW_PANE_ID)`). Optionally focuses a
 * suggestion or a block's comment thread.
 */
export function setReviewTarget(
  pageId: string | null,
  opts?: {suggestionId?: string | null; blockId?: string | null},
): void {
  targetPageId = pageId;
  focusSuggestionId = opts?.suggestionId ?? null;
  focusBlockId = opts?.blockId ?? null;
  revision += 1;
  listeners.forEach((cb) => cb());
}

// ── Review data change signal ───────────────────────────────────────────────
// Suggestions/comments have no SSE channel; surfaces that show counts (inline
// indicators, the pane) subscribe here and refetch when one mutates anywhere.

const dataListeners = new Set<() => void>();

/** Subscribe to "a suggestion/comment changed" pings. Returns an unsubscribe fn. */
export const subscribeReviewData = (cb: () => void): (() => void) => {
  dataListeners.add(cb);
  return () => dataListeners.delete(cb);
};

/** Notify every review surface that suggestions/comments changed (refetch). */
export const pingReviewData = (): void => {
  dataListeners.forEach((cb) => cb());
};
