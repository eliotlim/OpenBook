/**
 * A tiny in-memory bridge for the Version-history side pane. The "Version
 * history" affordance (the page "…" menu) opens the {@link HISTORY_PANE_ID}
 * pseudo-pane (reusing the split mechanism, like the customise / review panes)
 * and records which page's history it's showing here; the side-pane body reads
 * the target and lists that page's captured versions. The target round-trips
 * through the URL (`?split=history&paneTarget=<pageId>`) via `lib/paneTarget.ts`,
 * so a reload reopens the pane pointed at the same page.
 */
let targetPageId: string | null = null;
/** Bumped on every open request so the pane refetches even on the same target. */
let revision = 0;

const listeners = new Set<() => void>();

/** Subscribe to history-target changes. Returns an unsubscribe fn. */
export const subscribeHistoryPane = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export interface HistoryTarget {
  pageId: string | null;
  revision: number;
}

/** The page whose history the side pane is showing (plus a re-open tick), or null. */
export const getHistoryTarget = (): HistoryTarget => ({pageId: targetPageId, revision});

/**
 * Point the Version-history side pane at a page (does NOT open the pane itself —
 * the caller also calls `openInSplit(HISTORY_PANE_ID)`). The revision bump lets
 * re-opening the same page refetch its (possibly newly captured) versions.
 */
export function setHistoryTarget(pageId: string | null): void {
  targetPageId = pageId;
  revision += 1;
  listeners.forEach((cb) => cb());
}
