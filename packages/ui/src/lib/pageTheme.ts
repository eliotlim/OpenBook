/**
 * Per-page appearance overrides. Like {@link lib/pageIcon}, these live in
 * localStorage (keyed by page id) rather than the document payload, so a page
 * recolors instantly and offline without a save round-trip — a page's theme is
 * a local viewing preference, not shared content.
 *
 * An override is a *partial* {@link AppearanceOptions}: only the knobs the user
 * changed for this page. {@link composePageAppearance} merges it over the global
 * appearance, and the result is written as scoped CSS variables on the page's
 * wrapper element (see PageDocument), so the override recolors the page content
 * while the surrounding app chrome keeps the global theme.
 */
import {useSyncExternalStore} from 'react';
import {
  appearanceStyle,
  mergeAppearance,
  normalizeAppearance,
  type AppearanceOptions,
  type AppearanceOverride,
} from '@/lib/themes';

const themeKey = (pageId: string): string => `openbook.pagetheme.${pageId}`;

const listeners = new Set<() => void>();

/** Subscribe to per-page theme changes (any page). Returns an unsubscribe fn. */
export const subscribePageTheme = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** The override stored for a page, or `null` when the page follows the app. */
export function readPageTheme(pageId: string): AppearanceOverride | null {
  if (typeof localStorage === 'undefined' || !pageId) return null;
  try {
    const raw = localStorage.getItem(themeKey(pageId));
    return raw ? normalizeAppearance(JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Persist (or, with `null`/empty, clear) a page's override and notify views. */
export function writePageTheme(pageId: string, override: AppearanceOverride | null): void {
  if (typeof localStorage === 'undefined' || !pageId) return;
  if (!override || Object.keys(override).length === 0) localStorage.removeItem(themeKey(pageId));
  else localStorage.setItem(themeKey(pageId), JSON.stringify(override));
  listeners.forEach((cb) => cb());
}

/** Whether a page carries any override (i.e. doesn't simply follow the app). */
export const hasPageTheme = (pageId: string): boolean => {
  const o = readPageTheme(pageId);
  return !!o && Object.keys(o).length > 0;
};

/** React-subscribe to one page's override; re-renders when it changes. */
export function usePageTheme(pageId: string): AppearanceOverride | null {
  return useSyncExternalStore(
    subscribePageTheme,
    () => pageThemeSnapshot(pageId),
    () => null,
  );
}

// useSyncExternalStore needs a *stable* snapshot reference between renders, so
// we cache the parsed override per page and only re-parse when the raw string
// changes — returning a new object every read would loop the store. The cache
// is keyed by page id (not a single slot) so split-pane views of two different
// pages don't thrash each other's snapshot.
const snapCache = new Map<string, {raw: string | null; value: AppearanceOverride | null}>();
function pageThemeSnapshot(pageId: string): AppearanceOverride | null {
  if (typeof localStorage === 'undefined' || !pageId) return null;
  const raw = localStorage.getItem(themeKey(pageId));
  const cached = snapCache.get(pageId);
  if (cached && cached.raw === raw) return cached.value;
  let value: AppearanceOverride | null = null;
  try {
    value = raw ? normalizeAppearance(JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    value = null;
  }
  snapCache.set(pageId, {raw, value});
  return value;
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
