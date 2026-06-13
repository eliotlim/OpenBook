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
