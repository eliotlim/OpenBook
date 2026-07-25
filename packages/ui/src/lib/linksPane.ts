/**
 * A tiny in-memory bridge for the Linked-references side pane. The "Linked
 * references" affordances — the backlinks header chip and the command palette —
 * open the {@link LINKS_PANE_ID} pseudo-pane (reusing the split mechanism, like
 * the review / history panes) and record which page's links it's showing here;
 * the side-pane body reads the target and lists that page's backlinks and
 * unlinked mentions. The target round-trips through the URL
 * (`?split=links&paneTarget=<pageId>`) via `lib/paneTarget.ts`, so a reload
 * reopens the pane pointed at the same page.
 */
let targetPageId: string | null = null;
/** Bumped on every open request so the pane refetches even on the same target. */
let revision = 0;

const listeners = new Set<() => void>();

/** Subscribe to links-target changes. Returns an unsubscribe fn. */
export const subscribeLinksPane = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export interface LinksTarget {
  pageId: string | null;
  revision: number;
}

/** The page whose links the side pane is showing (plus a re-open tick), or null. */
export const getLinksTarget = (): LinksTarget => ({pageId: targetPageId, revision});

/**
 * Point the Linked-references side pane at a page (does NOT open the pane itself
 * — the caller also calls `openInSplit(LINKS_PANE_ID)`). The revision bump lets
 * re-opening the same page refetch its (possibly changed) links.
 */
export function setLinksTarget(pageId: string | null): void {
  targetPageId = pageId;
  revision += 1;
  listeners.forEach((cb) => cb());
}
