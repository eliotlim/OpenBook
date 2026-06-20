/**
 * Whole-page theme presets: one click sets a page's accent (control colour),
 * background tint, typefaces, and cover together — a coordinated look you can
 * then fine-tune with the individual pickers. Applied per page through the same
 * localStorage stores as the manual controls ({@link writePageTheme} /
 * {@link writePageFonts} / {@link writePageCover}), so a preset is just a bundle
 * of those writes.
 */
import type {AppearanceOverride} from '@/lib/themes';
import type {PageFonts} from '@/lib/pageFont';
import {COVER_GRADIENTS, type PageCover} from '@/lib/pageCover';

export interface PageThemePreset {
  id: string;
  /** i18n key for the display name (see messages `appearance.preset.*`). */
  labelKey: string;
  /** Accent + background (an empty override means "follow the app" — a reset). */
  override: AppearanceOverride;
  /** Body / heading typefaces, or null to clear them. */
  fonts: PageFonts | null;
  /** A curated gradient cover, or null to clear it. */
  cover: PageCover | null;
}

const gradient = (id: string): PageCover | null => {
  const g = COVER_GRADIENTS.find((c) => c.id === id);
  return g ? {kind: 'gradient', css: g.css} : null;
};

export const PAGE_THEME_PRESETS: PageThemePreset[] = [
  // Clean = reset: empty override clears the page theme so it follows the app.
  {id: 'clean', labelKey: 'appearance.preset.clean', override: {}, fonts: null, cover: null},
  {id: 'editorial', labelKey: 'appearance.preset.editorial', override: {themeId: 'sandstone', background: 'orange'}, fonts: {body: 'serif', heading: 'serif'}, cover: gradient('sand')},
  {id: 'notebook', labelKey: 'appearance.preset.notebook', override: {themeId: 'amber', background: 'yellow'}, fonts: {heading: 'serif'}, cover: gradient('dawn')},
  {id: 'technical', labelKey: 'appearance.preset.technical', override: {themeId: 'graphite'}, fonts: {body: 'mono', heading: 'mono'}, cover: gradient('slate')},
  {id: 'vibrant', labelKey: 'appearance.preset.vibrant', override: {themeId: 'violet', background: 'purple'}, fonts: null, cover: gradient('grape')},
  {id: 'calm', labelKey: 'appearance.preset.calm', override: {themeId: 'pastel-sky', background: 'blue'}, fonts: null, cover: gradient('ocean')},
];
