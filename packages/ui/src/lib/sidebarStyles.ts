/**
 * Shared sidebar item styling. Highlights route through the app's `bg-hover` /
 * `bg-hover-strong` tokens and the sidebar foreground, so ONE set of classes
 * reads correctly in both sidebar modes:
 *
 * - Tinted (default): `--color-hover`/`--color-hover-strong` are the usual
 *   primary-tint washes (`primary/10..25`) — i.e. exactly the pre-OB-377 look —
 *   and `--sheet-1-foreground` is the app foreground.
 * - Accent (opt-in): the `.ob-accent-chrome` remap (index.css) repoints
 *   `--color-hover`/`--color-hover-strong` to translucent `--sheet-veil` washes
 *   (the black/white pole composeAppearance picks per theme so the wash always
 *   *increases* contrast — audited 10/16 % light, 8/13 % dark, manifest §2.3),
 *   and `--sheet-1-foreground` is the flipped light foreground.
 *
 * Applied via `cn`, so they override a Button variant's own `hover:bg-*` through
 * tailwind-merge.
 */
export const SIDEBAR_HOVER = 'hover:bg-hover hover:text-[hsl(var(--sheet-1-foreground))]';

/** The selected / active sidebar item — the stronger wash. */
export const SIDEBAR_ACTIVE = 'bg-hover-strong text-[hsl(var(--sheet-1-foreground))]';

/**
 * Press feedback for sidebar control buttons (settings, menu toggle). Cancels
 * the shared Button's shrink-on-press (`active:scale-[0.97]`) and deepens the
 * wash instead. Applied via `cn` so it overrides the Button base through
 * tailwind-merge.
 */
export const SIDEBAR_PRESS = 'active:scale-100 active:bg-hover-strong';
