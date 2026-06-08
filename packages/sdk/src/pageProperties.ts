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

/** The stored shape of a Verification property value. */
export interface VerificationValue {
  verified: boolean;
  /** Display name of who verified it; `null` when unknown. */
  by?: string | null;
  /** ISO timestamp the page was verified. */
  at?: string | null;
}

/** The built-in properties every page carries, in panel order. */
export const SYSTEM_PAGE_PROPERTIES: DatabaseProperty[] = [
  {id: OWNER_PROPERTY_ID, name: 'Owner', type: 'person'},
  {id: VERIFICATION_PROPERTY_ID, name: 'Verification', type: 'verification'},
  {id: BACKLINKS_PROPERTY_ID, name: 'Backlinks', type: 'backlinks'},
];

/** True when a stored value represents a verified page. */
export function isVerified(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as VerificationValue).verified === true;
}

/** A verification value stamped as verified now (the caller supplies the time). */
export function makeVerification(by: string | null, atIso: string): VerificationValue {
  return {verified: true, by: by && by.trim() ? by.trim() : null, at: atIso};
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
