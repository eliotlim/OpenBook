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
 * Same rule for the selection tokens below: every colour a sidebar item paints
 * must be sheet-relative, so hover ink is `--sheet-1-foreground` (identical to
 * `--foreground` in tinted mode) rather than the literal app foreground.
 *
 * Applied via `cn`, so they override a Button variant's own `hover:bg-*` through
 * tailwind-merge.
 */
export const SIDEBAR_HOVER =
  'hover:bg-[hsl(var(--sheet-1-foreground)/0.06)] hover:text-sheet-1-foreground';

/**
 * The selected / active sidebar item — the brand-tinted wash (APPFIT-3.9).
 *
 * Routed through the `--color-sidebar-selection*` tokens (index.css), NOT
 * `*-primary` literals: on the tinted sidebar they resolve to the primary
 * wash/ink/rail exactly as designed, but on the opt-in accent sheet the primary
 * IS the surface, so `text-primary` there collapses to 1.00–1.17:1 against it
 * (the OB-377 audit). The `.ob-accent-chrome` remap repoints the tokens to the
 * sheet's own poles — the strong veil wash and the flipped sheet foreground.
 */
export const SIDEBAR_ACTIVE = 'bg-sidebar-selection-wash text-sidebar-selection';

/** A selected page row: keep its stronger wash on hover and add a metric-free rail. */
export const SIDEBAR_SELECTED_ROW = `${SIDEBAR_ACTIVE} hover:bg-sidebar-selection-wash-strong before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-sidebar-selection`;

/**
 * Press feedback for sidebar control buttons (settings, menu toggle). Deepens the
 * highlight on press by routing through the shared `bg-hover-strong` token, so ONE
 * treatment reads correctly in both sidebar modes — a darker primary-tint wash when
 * tinted, and the `.ob-accent-chrome` veil wash when accent (OB-377). The press is
 * colour-only: the Button base no longer scales on press (#103), so there's no
 * shrink to cancel. Applied via `cn` so it overrides the Button base through
 * tailwind-merge.
 */
export const SIDEBAR_PRESS = 'active:bg-hover-strong';
