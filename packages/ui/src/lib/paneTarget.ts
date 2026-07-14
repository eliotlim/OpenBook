/**
 * Registry mapping a side-pane pseudo-page id to the module singleton that
 * holds *which page* that pane is acting on. Side panes open via the split
 * mechanism (`openInSplit(PANE_ID)`), so the pane id reaches `?split=`, but the
 * target page it acts on lives in an in-memory bridge — lost on reload. This
 * registry lets {@link NavigationProvider} mirror the target into the URL
 * (`?paneTarget=<pageId>`) and seed the bridge back from it on load.
 *
 * Only panes that act on a page are listed: the customise pane
 * ({@link CUSTOMISE_PANE_ID} → `pageCustomise`) and the review pane
 * ({@link REVIEW_PANE_ID} → `reviewPane`). The config pane hosts an in-memory
 * kit-block config (no page) and the agent pane has no page target, so both
 * stay ephemeral and are not persisted.
 */
import {CUSTOMISE_PANE_ID, REVIEW_PANE_ID} from './homePage';
import {getPageCustomiseTarget, setPageCustomiseTarget, subscribePageCustomise} from './pageCustomise';
import {getReviewTarget, setReviewTarget, subscribeReviewPane} from './reviewPane';

export interface PaneTargetStore {
  /** The page the pane currently targets, or `null`. */
  get: () => string | null;
  /** Point the pane at a page (does not open the pane itself). */
  set: (pageId: string | null) => void;
  /** Subscribe to target changes; returns an unsubscribe fn. */
  subscribe: (cb: () => void) => () => void;
}

/** Pane pseudo-page id → the store holding its target page. */
export const PANE_TARGET_STORES: Record<string, PaneTargetStore> = {
  [CUSTOMISE_PANE_ID]: {
    get: getPageCustomiseTarget,
    set: setPageCustomiseTarget,
    subscribe: subscribePageCustomise,
  },
  [REVIEW_PANE_ID]: {
    get: () => getReviewTarget().pageId,
    set: (pageId) => setReviewTarget(pageId),
    subscribe: subscribeReviewPane,
  },
};

/** Whether this split pane carries a page target that persists in the URL. */
export const paneHasTarget = (split: string | null | undefined): split is string =>
  split != null && Object.prototype.hasOwnProperty.call(PANE_TARGET_STORES, split);
