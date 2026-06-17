/**
 * Per-page appearance overrides. These persist on the page document
 * (`page.properties`, see {@link lib/pageAppearance}) so a page's theme travels
 * with it and syncs across devices.
 *
 * An override is a *partial* {@link AppearanceOptions}: only the knobs the user
 * changed for this page. {@link composePageAppearance} merges it over the global
 * appearance, and the result is written as scoped CSS variables on the page's
 * wrapper element (see BlockPageDocument), so the override recolors the page
 * content while the surrounding app chrome keeps the global theme.
 */
import {
  readAppearanceFacet,
  subscribePageAppearance,
  useAppearanceFacet,
  writeAppearanceFacet,
} from '@/lib/pageAppearance';
import {appearanceStyle, mergeAppearance, type AppearanceOptions, type AppearanceOverride} from '@/lib/themes';

/** Subscribe to per-page theme changes (any page). Returns an unsubscribe fn. */
export const subscribePageTheme = subscribePageAppearance;

/** The override stored for a page, or `null` when the page follows the app. */
export function readPageTheme(pageId: string): AppearanceOverride | null {
  return readAppearanceFacet<AppearanceOverride>(pageId, 'theme');
}

/** Persist (or, with `null`/empty, clear) a page's override. */
export function writePageTheme(pageId: string, override: AppearanceOverride | null): void {
  writeAppearanceFacet(pageId, 'theme', override);
}

/** Whether a page carries any override (i.e. doesn't simply follow the app). */
export const hasPageTheme = (pageId: string): boolean => {
  const o = readPageTheme(pageId);
  return !!o && Object.keys(o).length > 0;
};

/** React-subscribe to one page's override; re-renders when it changes. */
export function usePageTheme(pageId: string): AppearanceOverride | null {
  return useAppearanceFacet<AppearanceOverride>(pageId, 'theme');
}

/** Merge a page's override over the global appearance for the active scheme,
 *  returning a CSS-variable style map — or `undefined` when there's no override
 *  (so callers can skip the scoped wrapper entirely). */
export function composePageAppearance(
  global: AppearanceOptions,
  override: AppearanceOverride | null,
  scheme: 'light' | 'dark',
): Record<string, string> | undefined {
  if (!override || Object.keys(override).length === 0) return undefined;
  return appearanceStyle(mergeAppearance(global, override), scheme);
}
