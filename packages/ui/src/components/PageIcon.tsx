import {cn} from '@/lib/utils';
import {isLucideIcon, lucideIconFor} from '@/lib/lucideIcons';

/**
 * Renders a page-icon *value* — either a native emoji glyph (e.g. `"📄"`) or a
 * curated Lucide icon serialized as `"lucide:<Name>"` (see {@link lib/lucideIcons}).
 *
 * Lucide icons render at `1em`, so they inherit the surrounding font-size exactly
 * like an emoji glyph does, and use `currentColor` so they take the text color.
 * This is the one place icon values turn into pixels, so every surface that shows
 * a page icon (tree rows, headers, tabs, the picker's recents) stays consistent.
 */
export function PageIcon({
  value,
  fallback = '📄',
  className,
}: {
  value?: string | null;
  /** Shown when `value` is empty. Pass `null` to render nothing. */
  fallback?: string | null;
  /** Extra classes — for Lucide icons these compose over the `1em` sizing. */
  className?: string;
}) {
  if (value && isLucideIcon(value)) {
    const Icon = lucideIconFor(value);
    if (Icon) {
      // Size to `1em` via inline style (highest precedence) so the icon matches
      // the surrounding font-size exactly like an emoji glyph — and isn't thrown
      // off by leftover `h-4 w-4`/`text-*` utility classes on the call site span.
      return (
        <Icon
          aria-hidden
          className={cn('inline-block shrink-0 align-[-0.125em]', className)}
          style={{width: '1em', height: '1em'}}
        />
      );
    }
    // Unknown lucide name (curated set changed): show the fallback, never the
    // raw `lucide:` ref as text.
    if (!fallback) return null;
    return <span className={className}>{fallback}</span>;
  }
  const glyph = value || fallback;
  if (!glyph) return null;
  return <span className={className}>{glyph}</span>;
}
