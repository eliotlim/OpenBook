/**
 * Shared sidebar item styling (OB-377). The sidebar sheets are a full-intensity
 * accent surface by default, so the old `bg-primary/10..25` washes (which *are*
 * the surface colour now) can't read. Highlights are instead a translucent wash
 * of `--sheet-veil` — the black/white pole composeAppearance picks per theme so
 * the wash always *increases* the `--sheet-1-foreground` contrast (black under
 * a light foreground, white under an ink one; white in the dark scheme for
 * visibility on the deep sheets). Alphas are the audited 10/16/24 % (light) and
 * 8/13/15 % (dark): every washed state keeps the foreground ≥ 4.5:1 on all 17
 * themes — see docs/design/colour-consistency-manifest-2026-07.md §2.3.
 * Applied via `cn`, so they override a Button variant's own `hover:bg-*`
 * through tailwind-merge.
 */
export const SIDEBAR_HOVER =
  'hover:bg-[hsl(var(--sheet-veil)/0.10)] hover:text-[hsl(var(--sheet-1-foreground))] dark:hover:bg-[hsl(var(--sheet-veil)/0.08)]';

/** The selected / active sidebar item — a stronger wash of the veil. */
export const SIDEBAR_ACTIVE =
  'bg-[hsl(var(--sheet-veil)/0.16)] text-[hsl(var(--sheet-1-foreground))] dark:bg-[hsl(var(--sheet-veil)/0.13)]';

/**
 * Press feedback for sidebar control buttons (settings, menu toggle). Cancels
 * the shared Button's shrink-on-press (`active:scale-[0.97]`) and deepens the
 * veil wash instead. Applied via `cn` so it overrides the Button base through
 * tailwind-merge.
 */
export const SIDEBAR_PRESS =
  'active:scale-100 active:bg-[hsl(var(--sheet-veil)/0.24)] dark:active:bg-[hsl(var(--sheet-veil)/0.15)]';
