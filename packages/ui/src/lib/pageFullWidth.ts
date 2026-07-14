/**
 * Per-page full-width preference — a property of *this page's* layout (a wide
 * table reads better full-bleed; a prose page reads better in a column). Like
 * the per-page theme/cover/fonts it now persists on the page document
 * (`page.properties`, see {@link lib/pageAppearance}) so the choice travels with
 * the page and syncs across devices.
 *
 * The stored value is tri-state: `true` (on), `false` (an explicit opt-out), or
 * absent (unset → follow the page default). Database-hosting pages default to
 * full-width (wide tables/boards read better full-bleed); every other page
 * defaults to the centered column. An explicit override always wins over the
 * default, so a user can still turn full-width *off* on a database page and have
 * that choice persist.
 */
import {readAppearanceFacet, subscribePageAppearance, useAppearanceFacet, writeAppearanceFacet} from '@/lib/pageAppearance';

/** Subscribe to full-width changes (any page). Returns an unsubscribe fn. */
export const subscribePageFullWidth = subscribePageAppearance;

/** The raw per-page override: `true`/`false` when set, `null` when unset. */
function readOverride(pageId: string): boolean | null {
  const v = readAppearanceFacet<boolean>(pageId, 'fullWidth');
  return typeof v === 'boolean' ? v : null;
}

/** Apply the page default (DB pages → full-width) when there's no override. */
function resolve(override: boolean | null, isDatabase: boolean): boolean {
  return override ?? isDatabase;
}

/**
 * Whether a page renders full width. Database-hosting pages default to `true`;
 * pass `isDatabase` so the default is applied when the page has no explicit
 * override. An explicit override (either direction) always wins.
 */
export function readPageFullWidth(pageId: string, isDatabase = false): boolean {
  return resolve(readOverride(pageId), isDatabase);
}

/**
 * Persist a page's full-width choice. Writes an explicit `true`/`false` only
 * when it differs from the page's default (DB pages default on, others off);
 * choosing the default clears the override so storage stays tidy while an
 * opt-out that bucks the default (e.g. full-width *off* on a DB page) persists.
 */
export function writePageFullWidth(pageId: string, value: boolean, isDatabase = false): void {
  writeAppearanceFacet(pageId, 'fullWidth', value === isDatabase ? null : value);
}

/** Flip a page between full-width and the centered column, default-aware. */
export function togglePageFullWidth(pageId: string, isDatabase = false): void {
  writePageFullWidth(pageId, !readPageFullWidth(pageId, isDatabase), isDatabase);
}

/** React-subscribe to one page's effective full-width flag (default-aware). */
export function usePageFullWidth(pageId: string, isDatabase = false): boolean {
  const v = useAppearanceFacet<boolean>(pageId, 'fullWidth');
  return resolve(typeof v === 'boolean' ? v : null, isDatabase);
}
