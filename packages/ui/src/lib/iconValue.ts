/**
 * Pure helpers for page-icon *values* — no React, no `lucide-react` import — so
 * text-only consumers (HTML/Markdown export, mention labels) can reason about an
 * icon string without pulling the icon component registry into their bundle.
 *
 * A page icon is either a native emoji glyph (e.g. `"📄"`) or a curated Lucide
 * icon serialized as `"lucide:<Name>"`. Rendering to pixels lives in
 * {@link components/PageIcon}; resolving to a component lives in
 * {@link lib/lucideIcons}.
 */
export const LUCIDE_PREFIX = 'lucide:';

/** Whether an icon value refers to a Lucide icon (vs. an emoji glyph). */
export const isLucideIcon = (value: string | null | undefined): boolean =>
  !!value && value.startsWith(LUCIDE_PREFIX);

/**
 * A plain-text rendering of an icon value. Emoji glyphs pass through; Lucide
 * icons have no text form, so they collapse to an empty string (callers should
 * treat that as "no icon" rather than printing the `lucide:` ref literally).
 */
export const pageIconToText = (value: string | null | undefined): string =>
  !value || isLucideIcon(value) ? '' : value;
