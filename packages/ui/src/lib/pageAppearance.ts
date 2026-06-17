/**
 * Per-page appearance (theme / cover / typefaces) backed by the page document.
 *
 * These used to live in localStorage; they now persist on `page.properties`
 * (reserved ids {@link THEME_PROPERTY_ID} / {@link COVER_PROPERTY_ID} /
 * {@link FONTS_PROPERTY_ID}) so a page's look travels with the document and
 * syncs across devices. This module keeps a small in-memory cache of the parsed
 * facets per page (so the existing synchronous `read*`/`use*` API is preserved),
 * hydrated from the page record and written through a registered backend that
 * persists to the server. A one-time migration lifts any legacy localStorage
 * value into the document on first load.
 */
import {useEffect, useSyncExternalStore} from 'react';
import {THEME_PROPERTY_ID, COVER_PROPERTY_ID, FONTS_PROPERTY_ID, FULLWIDTH_PROPERTY_ID} from '@open-book/sdk';
import {normalizeAppearance, type AppearanceOverride} from '@/lib/themes';
import type {PageCover} from '@/lib/pageCover';
import type {PageFonts} from '@/lib/pageFont';

export type AppearanceFacet = 'theme' | 'cover' | 'fonts' | 'fullWidth';

const FACET_KEY: Record<AppearanceFacet, string> = {
  theme: THEME_PROPERTY_ID,
  cover: COVER_PROPERTY_ID,
  fonts: FONTS_PROPERTY_ID,
  fullWidth: FULLWIDTH_PROPERTY_ID,
};
const LEGACY_KEY: Record<AppearanceFacet, (id: string) => string> = {
  theme: (id) => `openbook.pagetheme.${id}`,
  cover: (id) => `openbook.cover.${id}`,
  fonts: (id) => `openbook.pagefont.${id}`,
  fullWidth: (id) => `openbook.fullwidth.${id}`,
};
const FACETS: AppearanceFacet[] = ['theme', 'cover', 'fonts', 'fullWidth'];

/** Parsed, validated facets for one page (stable references → stable snapshots). */
type Facets = {theme: AppearanceOverride | null; cover: PageCover | null; fonts: PageFonts | null; fullWidth: boolean | null};
const empty = (): Facets => ({theme: null, cover: null, fonts: null, fullWidth: null});

const cache = new Map<string, Facets>();
const requested = new Set<string>();
const listeners = new Set<() => void>();
const notify = (): void => listeners.forEach((cb) => cb());

export const subscribePageAppearance = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

// ── Backend (registered by a host with the data client) ──────────────────────

export interface AppearanceBackend {
  /** Persist one facet to the page document (`null` clears it). */
  persist: (pageId: string, propertyKey: string, value: unknown) => void;
  /** Fetch a page's stored properties and hydrate the cache. */
  load: (pageId: string) => void;
}
let backend: AppearanceBackend | null = null;
export function setAppearanceBackend(b: AppearanceBackend | null): void {
  backend = b;
}

/** Kick a one-off load for a page we haven't seen yet (idempotent). Skips while
 *  the backend isn't wired yet so a later read retries rather than dead-ending. */
function ensureLoaded(pageId: string): void {
  if (!pageId || cache.has(pageId) || requested.has(pageId) || !backend) return;
  requested.add(pageId);
  backend.load(pageId);
}

// ── Parsing (run once at hydrate/migrate time; cache holds parsed values) ─────

function parseCover(raw: unknown): PageCover | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as PageCover;
  if (v.kind === 'gradient' && typeof v.css === 'string') return {kind: 'gradient', css: v.css};
  if (v.kind === 'image' && typeof v.url === 'string') {
    return {kind: 'image', url: v.url, ...(typeof v.position === 'number' ? {position: v.position} : {})};
  }
  return null;
}
function parseFonts(raw: unknown): PageFonts | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as PageFonts;
  const out: PageFonts = {};
  if (typeof v.body === 'string' && v.body) out.body = v.body;
  if (typeof v.heading === 'string' && v.heading) out.heading = v.heading;
  return out.body || out.heading ? out : null;
}
function parseTheme(raw: unknown): AppearanceOverride | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = normalizeAppearance(raw as Record<string, unknown>);
  return o && Object.keys(o).length > 0 ? o : null;
}
function parseFacet(facet: AppearanceFacet, raw: unknown): Facets[AppearanceFacet] {
  if (facet === 'theme') return parseTheme(raw);
  if (facet === 'cover') return parseCover(raw);
  if (facet === 'fonts') return parseFonts(raw);
  return raw ? true : null; // fullWidth: a flag, stored only when true
}

const facetJson = (v: unknown): string => (v == null ? 'null' : JSON.stringify(v));

// ── Hydration + migration ────────────────────────────────────────────────────

/**
 * Replace a page's cached appearance from its stored `properties`. Idempotent
 * and reference-stable: a facet whose JSON is unchanged keeps its old object so
 * `useSyncExternalStore` doesn't loop. Lifts any legacy localStorage value into
 * the document the first time a page is seen without stored appearance.
 */
export function hydratePageAppearance(pageId: string, properties: Record<string, unknown> | null | undefined): void {
  if (!pageId) return;
  requested.add(pageId);
  const props = properties ?? {};
  const prev = cache.get(pageId) ?? empty();
  const next: Facets = {...prev};
  let changed = !cache.has(pageId);
  for (const facet of FACETS) {
    const parsed = parseFacet(facet, props[FACET_KEY[facet]]);
    if (facetJson(parsed) !== facetJson(prev[facet])) {
      (next[facet] as unknown) = parsed;
      changed = true;
    }
  }
  cache.set(pageId, next);
  if (changed) notify();
  migrateLegacy(pageId, props);
}

/** One-time: move a legacy localStorage facet into the document, then drop it. */
function migrateLegacy(pageId: string, props: Record<string, unknown>): void {
  if (typeof localStorage === 'undefined') return;
  for (const facet of FACETS) {
    if (props[FACET_KEY[facet]] != null) continue; // already in the document
    const key = LEGACY_KEY[facet](pageId);
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    let parsed: unknown = null;
    try {
      parsed = parseFacet(facet, JSON.parse(raw));
    } catch {
      parsed = null;
    }
    localStorage.removeItem(key);
    if (parsed) writeAppearanceFacet(pageId, facet, parsed); // persists + caches
  }
}

// ── Read / write / subscribe ─────────────────────────────────────────────────

export function readAppearanceFacet<T>(pageId: string, facet: AppearanceFacet): T | null {
  ensureLoaded(pageId);
  return (cache.get(pageId)?.[facet] ?? null) as T | null;
}

export function writeAppearanceFacet(pageId: string, facet: AppearanceFacet, value: unknown): void {
  if (!pageId) return;
  const clean = value == null || (typeof value === 'object' && Object.keys(value as object).length === 0) ? null : value;
  const cur = {...(cache.get(pageId) ?? empty())};
  if (facetJson(clean) === facetJson(cur[facet])) return; // no-op
  (cur[facet] as unknown) = clean;
  cache.set(pageId, cur);
  backend?.persist(pageId, FACET_KEY[facet], clean);
  notify();
}

/** React-subscribe to one page's facet; re-renders when it changes. */
export function useAppearanceFacet<T>(pageId: string, facet: AppearanceFacet): T | null {
  useEffect(() => {
    ensureLoaded(pageId);
  }, [pageId]);
  return useSyncExternalStore(
    subscribePageAppearance,
    () => (cache.get(pageId)?.[facet] ?? null) as T | null,
    () => null,
  );
}
