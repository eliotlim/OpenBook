/**
 * A tiny in-memory bridge for the page-customisation side pane. The palette
 * button in a page's header opens the {@link CUSTOMISE_PANE_ID} pseudo-pane
 * (reusing the split mechanism, like the block-settings pane) and records which
 * page it's customising here; the side pane body reads the target to render that
 * page's appearance + typeface controls. Ephemeral — never persisted to the URL.
 */
let targetPageId: string | null = null;

const listeners = new Set<() => void>();

/** Subscribe to target changes. Returns an unsubscribe fn. */
export const subscribePageCustomise = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** The page currently being customised in the side pane, or `null`. */
export const getPageCustomiseTarget = (): string | null => targetPageId;

/** Point the customisation side pane at a page (does not open the pane itself). */
export function setPageCustomiseTarget(pageId: string | null): void {
  if (targetPageId === pageId) return;
  targetPageId = pageId;
  listeners.forEach((cb) => cb());
}
