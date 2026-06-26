/**
 * Shared sidebar item styling. The old hover was `bg-accent` — a neutral gray
 * on the (also-neutral) sheet, so the highlight barely read. These tint the
 * highlight with the theme colour instead: still subtle, but with real contrast
 * against the surface. Applied via `cn`, so they override a Button variant's
 * own `hover:bg-accent` through tailwind-merge.
 */
export const SIDEBAR_HOVER = 'hover:bg-primary/10 hover:text-foreground dark:hover:bg-primary/20';

/** The selected / active sidebar item — a stronger tint of the same colour. */
export const SIDEBAR_ACTIVE = 'bg-primary/15 text-foreground dark:bg-primary/25';

/**
 * Press feedback for sidebar control buttons (settings, menu toggle). Cancels
 * the shared Button's shrink-on-press (`active:scale-[0.97]`) and deepens the
 * highlight instead — a darker tint in light mode, a lighter one in dark mode.
 * Applied via `cn` so it overrides the Button base through tailwind-merge.
 */
export const SIDEBAR_PRESS = 'active:scale-100 active:bg-primary/20 dark:active:bg-primary/30';
