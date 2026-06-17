/**
 * Built-in **page properties** — structured metadata every page carries,
 * modelled with the same {@link DatabaseProperty} vocabulary as databases so
 * the two presentations are duals:
 *
 *  - A standalone page shows them in a wiki-style *properties panel* under its
 *    title (Owner, Verification, Backlinks).
 *  - A collection of pages gathered into a database shows the very same values
 *    as *columns*, because the property ids below are stable and reserved — a
 *    column whose id is {@link OWNER_PROPERTY_ID} reads the identical
 *    `page.properties[OWNER_PROPERTY_ID]` the panel edits.
 *
 * Owner and Verification are stored on the page (`page.properties`). Backlinks
 * are *computed* from the link graph (which pages mention this one), so they
 * are never stored — see {@link extractMentionIds}.
 */
import type {PageSnapshot} from './types';
import type {DatabaseProperty} from './database';

/** Reserved, stable id for the Owner (person) property. */
export const OWNER_PROPERTY_ID = 'sys_owner';
/** Reserved, stable id for the Verification property. */
export const VERIFICATION_PROPERTY_ID = 'sys_verification';
/** Reserved, stable id for the Backlinks (computed) property. */
export const BACKLINKS_PROPERTY_ID = 'sys_backlinks';

/**
 * Reserved ids for a page's **appearance**, stored on `page.properties` so a
 * page's theme / cover / typefaces travel with the document (sync across
 * devices) rather than living only in the local browser. They are appearance
 * metadata — not panel/column properties — so they are intentionally NOT part
 * of {@link SYSTEM_PAGE_PROPERTIES}.
 */
export const THEME_PROPERTY_ID = 'sys_theme';
export const COVER_PROPERTY_ID = 'sys_cover';
export const FONTS_PROPERTY_ID = 'sys_fonts';
/** The page's emoji icon (a string). Projected into {@link PageMeta} so the
 *  sidebar/tabs/mentions resolve it from the page list, not a per-page fetch. */
export const ICON_PROPERTY_ID = 'sys_icon';
/** The page's full-width layout flag (a boolean; absent = centered column). */
export const FULLWIDTH_PROPERTY_ID = 'sys_fullwidth';

/** The stored shape of a Verification property value. */
export interface VerificationValue {
  verified: boolean;
  /** Display name of who verified it; `null` when unknown. */
  by?: string | null;
  /** ISO timestamp the page was verified. */
  at?: string | null;
  /** ISO timestamp the verification lapses; absent/`null` = never expires. */
  expiresAt?: string | null;
}

/** The built-in properties every page carries, in panel order. */
export const SYSTEM_PAGE_PROPERTIES: DatabaseProperty[] = [
  {id: OWNER_PROPERTY_ID, name: 'Owner', type: 'person'},
  {id: VERIFICATION_PROPERTY_ID, name: 'Verification', type: 'verification'},
  {id: BACKLINKS_PROPERTY_ID, name: 'Backlinks', type: 'backlinks'},
];

/** True when a stored value represents a verified page (ignoring expiry). */
export function isVerified(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as VerificationValue).verified === true;
}

/** True when a verified page's verification has lapsed (expiry is in the past). */
export function verificationExpired(value: unknown, nowMs: number = Date.now()): boolean {
  if (!isVerified(value)) return false;
  const exp = (value as VerificationValue).expiresAt;
  return !!exp && new Date(exp).getTime() <= nowMs;
}

/** True when a page is verified AND its verification has not lapsed. */
export function isVerificationActive(value: unknown, nowMs: number = Date.now()): boolean {
  return isVerified(value) && !verificationExpired(value, nowMs);
}

/**
 * A verification value stamped as verified now (the caller supplies the time).
 * `expiresAtIso` sets an expiry; omit/`null` for a verification that never
 * lapses.
 */
export function makeVerification(by: string | null, atIso: string, expiresAtIso?: string | null): VerificationValue {
  return {
    verified: true,
    by: by && by.trim() ? by.trim() : null,
    at: atIso,
    ...(expiresAtIso ? {expiresAt: expiresAtIso} : {}),
  };
}

/**
 * Pure: the set of page ids this snapshot links to, by scanning the EditorJS
 * blocks for inline mention anchors (`<a … data-page-id="…">`). Order-preserving
 * and de-duplicated — the out-edges of one page in the backlink graph.
 *
 * Works on both the raw HTML form (`data-page-id="id"`) and the JSON-escaped
 * form (`data-page-id=\"id\"`) that appears once the document is serialised, so
 * it can run over a parsed snapshot or a stringified one alike.
 */
/**
 * Pure: does a page's stored `properties` reference `id`? True when any property
 * value equals `id`, or `id` is an element of an array-valued property (a
 * `relation`). This lets the backlink graph count relation links — set on a
 * row's properties — alongside inline `@`-mentions in the document.
 */
export function propertiesReferencePage(properties: Record<string, unknown> | null | undefined, id: string): boolean {
  if (!properties) return false;
  for (const value of Object.values(properties)) {
    if (value === id) return true;
    if (Array.isArray(value) && value.includes(id)) return true;
  }
  return false;
}

export function extractMentionIds(snapshot: Pick<PageSnapshot, 'editorjs'>): string[] {
  const json = JSON.stringify(snapshot.editorjs ?? {});
  const ids: string[] = [];
  const seen = new Set<string>();
  const re = /data-page-id=\\?["']([^"'\\]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(json)) !== null) {
    const id = match[1];
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}
