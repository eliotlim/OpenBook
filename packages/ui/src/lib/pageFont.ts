/**
 * Per-page typefaces. A page can override the **body** (primary) and **heading**
 * (secondary) typeface independently of the app default. Like the per-page theme
 * and cover, the choice persists on the page document (`page.properties`, see
 * {@link lib/pageAppearance}) and is applied via scoped CSS variables on the
 * page wrapper.
 *
 * Each choice is either a preset id (`sans` / `serif` / `mono`) or a raw custom
 * `font-family` string. {@link fontCss} resolves it to a CSS value; the presets
 * map to the app's `--font-*` stacks so a page stays consistent with the brand.
 */
import {readAppearanceFacet, subscribePageAppearance, useAppearanceFacet, writeAppearanceFacet} from '@/lib/pageAppearance';

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

/** Subscribe to per-page font changes (any page). Returns an unsubscribe fn. */
export const subscribePageFonts = subscribePageAppearance;

/** The fonts stored for a page, or `null` when it follows the app default. */
export function readPageFonts(pageId: string): PageFonts | null {
  return readAppearanceFacet<PageFonts>(pageId, 'fonts');
}

/** Persist (or clear, when empty) a page's font override. */
export function writePageFonts(pageId: string, fonts: PageFonts | null): void {
  const clean = fonts && (fonts.body || fonts.heading) ? fonts : null;
  writeAppearanceFacet(pageId, 'fonts', clean);
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

/** React-subscribe to one page's fonts; re-renders when they change. */
export function usePageFonts(pageId: string): PageFonts | null {
  return useAppearanceFacet<PageFonts>(pageId, 'fonts');
}
