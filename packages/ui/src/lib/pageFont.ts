/**
 * Per-page typefaces. A page can override the **body** (primary) and **heading**
 * (secondary) typeface independently of the app default. Like the per-page theme
 * and cover, the choice lives in localStorage (keyed by page id) — it's a local
 * reading preference, applied via scoped CSS variables on the page wrapper.
 *
 * Each choice is either a preset id (`sans` / `serif` / `mono`) or a raw custom
 * `font-family` string. {@link fontCss} resolves it to a CSS value; the presets
 * map to the app's `--font-*` stacks so a page stays consistent with the brand.
 */
import {useSyncExternalStore} from 'react';

export interface PageFonts {
  /** Primary typeface — body / prose text. */
  body?: string;
  /** Secondary typeface — the title and headings. */
  heading?: string;
}

/** The built-in typeface presets offered in the customisation pane. */
export const FONT_PRESETS: ReadonlyArray<{id: 'sans' | 'serif' | 'mono'; labelKey: string; css: string}> = [
  {id: 'sans', labelKey: 'appearance.fontSans', css: 'var(--font-sans)'},
  {id: 'serif', labelKey: 'appearance.fontSerif', css: 'var(--font-serif)'},
  {id: 'mono', labelKey: 'appearance.fontMono', css: 'var(--font-mono)'},
];

const PRESET_CSS: Record<string, string> = {
  sans: 'var(--font-sans)',
  serif: 'var(--font-serif)',
  mono: 'var(--font-mono)',
};

/** Resolve a stored choice (preset id or custom family) to a CSS font-family. */
export function fontCss(choice: string | undefined | null): string | undefined {
  if (!choice) return undefined;
  return PRESET_CSS[choice] ?? choice;
}

const fontKey = (pageId: string): string => `openbook.pagefont.${pageId}`;

const listeners = new Set<() => void>();

/** Subscribe to per-page font changes (any page). Returns an unsubscribe fn. */
export const subscribePageFonts = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

function parseFonts(raw: string | null): PageFonts | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as PageFonts;
    const out: PageFonts = {};
    if (typeof v.body === 'string' && v.body) out.body = v.body;
    if (typeof v.heading === 'string' && v.heading) out.heading = v.heading;
    return out.body || out.heading ? out : null;
  } catch {
    return null;
  }
}

/** The fonts stored for a page, or `null` when it follows the app default. */
export function readPageFonts(pageId: string): PageFonts | null {
  if (typeof localStorage === 'undefined' || !pageId) return null;
  return parseFonts(localStorage.getItem(fontKey(pageId)));
}

/** Persist (or clear, when empty) a page's font override and notify views. */
export function writePageFonts(pageId: string, fonts: PageFonts | null): void {
  if (typeof localStorage === 'undefined' || !pageId) return;
  const clean = fonts && (fonts.body || fonts.heading) ? fonts : null;
  if (!clean) localStorage.removeItem(fontKey(pageId));
  else localStorage.setItem(fontKey(pageId), JSON.stringify(clean));
  listeners.forEach((cb) => cb());
}

/** A page's fonts as scoped CSS variables, or `undefined` when none are set
 *  (so callers can skip the wrapper class entirely). */
export function pageFontStyle(fonts: PageFonts | null): Record<string, string> | undefined {
  if (!fonts) return undefined;
  const body = fontCss(fonts.body);
  const heading = fontCss(fonts.heading);
  if (!body && !heading) return undefined;
  const out: Record<string, string> = {};
  if (body) out['--ob-font-body'] = body;
  if (heading) out['--ob-font-heading'] = heading;
  return out;
}

const snapCache = new Map<string, {raw: string | null; value: PageFonts | null}>();
function fontsSnapshot(pageId: string): PageFonts | null {
  if (typeof localStorage === 'undefined' || !pageId) return null;
  const raw = localStorage.getItem(fontKey(pageId));
  const cached = snapCache.get(pageId);
  if (cached && cached.raw === raw) return cached.value;
  const value = parseFonts(raw);
  snapCache.set(pageId, {raw, value});
  return value;
}

/** React-subscribe to one page's fonts; re-renders when they change. */
export function usePageFonts(pageId: string): PageFonts | null {
  return useSyncExternalStore(
    subscribePageFonts,
    () => fontsSnapshot(pageId),
    () => null,
  );
}
