/**
 * The Home view — a pseudo-page. It lives in the window model, the URL
 * (`?page=home`) and history like any page id, so back/forward, tabs and
 * deep links all work; the document area just renders the Home screen for
 * it instead of fetching a document.
 */

export const HOME_PAGE_ID = 'home';

/**
 * The dataflow split-pane mode — another pseudo-page: `?split=flow` shows
 * the PRIMARY page's reactive graph instead of a second document.
 */
export const FLOW_PANE_ID = 'flow';

/**
 * The block-settings split-pane mode — a pseudo-page that hosts the "Expand"
 * view of an interactive block's configuration. Reuses the side pane rather
 * than a separate drawer; the live config fields portal into it (see
 * `blockeditor/kit/kitPanel.ts`). Ephemeral — never persisted to the URL.
 */
export const CONFIG_PANE_ID = 'config';

/**
 * The page-customisation split-pane mode — a pseudo-page hosting a page's
 * appearance + typeface controls (accent, neutrals, intensities, primary /
 * secondary fonts). Like {@link CONFIG_PANE_ID} it reuses the side pane rather
 * than a popover, and is ephemeral — never persisted to the URL. The page it
 * targets is tracked in `lib/pageCustomise.ts`.
 */
export const CUSTOMISE_PANE_ID = 'customise';

/**
 * The Review split-pane mode — a pseudo-page hosting the suggestions + comments
 * review surface for a page (open suggestions with before→after diffs, accept /
 * reject, and threaded rich-text comments). Like {@link CONFIG_PANE_ID} it
 * reuses the side pane and is ephemeral — never persisted to the URL. The page
 * it targets is tracked in `lib/reviewPane.ts`.
 */
export const REVIEW_PANE_ID = 'review';

/**
 * The Assistant split-pane mode — a pseudo-page hosting the workspace agent chat.
 * Like {@link REVIEW_PANE_ID} it reuses the side pane (rather than a separate
 * docked panel) and is ephemeral — never persisted to the URL.
 */
export const AGENT_PANE_ID = 'agent';

/** Which Home widgets are shown. All on by default; configurable per device. */
export interface HomeWidgets {
  actions: boolean;
  recents: boolean;
  favorites: boolean;
  edited: boolean;
}

export const DEFAULT_HOME_WIDGETS: HomeWidgets = {actions: true, recents: true, favorites: true, edited: true};

const KEY = 'openbook.home.widgets';

export function readHomeWidgets(): HomeWidgets {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    const parsed = raw ? (JSON.parse(raw) as Partial<HomeWidgets>) : {};
    return {...DEFAULT_HOME_WIDGETS, ...parsed};
  } catch {
    return DEFAULT_HOME_WIDGETS;
  }
}

export function writeHomeWidgets(widgets: HomeWidgets): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(widgets));
  } catch {
    // private mode / quota — the layout just won't persist
  }
}

/** The greeting key for an hour of the day (5–12 morning, 12–18 afternoon). */
export function greetingKey(hour: number): 'morning' | 'afternoon' | 'evening' {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'evening';
}
