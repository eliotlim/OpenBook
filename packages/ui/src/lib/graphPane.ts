/**
 * A tiny in-memory bridge for the Page-graph side pane (OB-33), mirroring
 * `lib/linksPane.ts`. The "Page graph" affordances — the command palette and the
 * links-pane header shortcut — open the {@link GRAPH_PANE_ID} pseudo-pane
 * (reusing the split mechanism, like the links / review panes) and record which
 * page the graph should CENTRE on here; the pane body reads the target, fetches
 * the whole-library graph, and renders the target page's N-hop neighbourhood with
 * that page highlighted. The target round-trips through the URL
 * (`?split=graph&paneTarget=<pageId>`) via `lib/paneTarget.ts`, so a reload
 * reopens the graph centred on the same page.
 */
let targetPageId: string | null = null;
/** Bumped on every open request so the pane refetches even on the same target. */
let revision = 0;

const listeners = new Set<() => void>();

/** Subscribe to graph-target changes. Returns an unsubscribe fn. */
export const subscribeGraphPane = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export interface GraphTarget {
  pageId: string | null;
  revision: number;
}

/** The page the graph is centred on (plus a re-open tick), or null. */
export const getGraphTarget = (): GraphTarget => ({pageId: targetPageId, revision});

/**
 * Centre the Page-graph side pane on a page (does NOT open the pane itself — the
 * caller also calls `openInSplit(GRAPH_PANE_ID)`). The revision bump lets
 * re-opening the same page refetch the (possibly changed) graph.
 */
export function setGraphTarget(pageId: string | null): void {
  targetPageId = pageId;
  revision += 1;
  listeners.forEach((cb) => cb());
}
