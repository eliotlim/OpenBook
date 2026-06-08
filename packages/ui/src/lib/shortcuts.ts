/**
 * The keyboard-shortcut vocabulary, shared by the global key handler
 * ({@link useGlobalShortcuts}), the command palette, and the menus — so a
 * shortcut is defined once and every surface that displays or fires it stays in
 * sync.
 *
 * A {@link ShortcutCombo} is platform-neutral: `mod` means ⌘ on macOS and Ctrl
 * elsewhere. {@link formatShortcut} renders it for display (`⌘K` vs `Ctrl+K`)
 * and {@link matchShortcut} tests a `KeyboardEvent` against it.
 */

export interface ShortcutCombo {
  /** The `KeyboardEvent.key` to match (compared case-insensitively). */
  key: string;
  /** ⌘ on macOS, Ctrl elsewhere. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

const detectMac = (): boolean =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');

/**
 * Client-side platform flag. Surfaces rendered during SSR (e.g. the sidebar
 * search button) should prefer {@link useIsMac} so the first client render
 * matches the server HTML; menus and the palette open only after mount, so the
 * module-level value is correct for them.
 */
export const isMacPlatform = detectMac();

/** Human-readable glyphs for non-letter keys. */
const KEY_GLYPHS: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: '↵',
  escape: 'Esc',
  backspace: '⌫',
  ' ': 'Space',
};

const keyLabel = (key: string): string => {
  if (key.length === 1) return key.toUpperCase();
  return KEY_GLYPHS[key.toLowerCase()] ?? key.charAt(0).toUpperCase() + key.slice(1);
};

/**
 * Render a combo for display: macOS stacks symbols with no separator (`⌘⇧L`),
 * other platforms join with `+` (`Ctrl+Shift+L`). The modifier order follows
 * each platform's convention.
 */
export function formatShortcut(combo: ShortcutCombo, mac: boolean = isMacPlatform): string {
  if (mac) {
    const parts: string[] = [];
    if (combo.alt) parts.push('⌥');
    if (combo.shift) parts.push('⇧');
    if (combo.mod) parts.push('⌘');
    parts.push(keyLabel(combo.key));
    return parts.join('');
  }
  const parts: string[] = [];
  if (combo.mod) parts.push('Ctrl');
  if (combo.shift) parts.push('Shift');
  if (combo.alt) parts.push('Alt');
  parts.push(keyLabel(combo.key));
  return parts.join('+');
}

/** True when `e` is exactly this combo (modifiers must match, not just be present). */
export function matchShortcut(e: KeyboardEvent, combo: ShortcutCombo): boolean {
  // `mod` accepts either accelerator (⌘ on mac, Ctrl elsewhere) so matching never
  // hinges on platform detection — the platform only affects how we *display* it.
  const hasMod = e.metaKey || e.ctrlKey;
  if (!!combo.mod !== hasMod) return false;
  if (!!combo.shift !== e.shiftKey) return false;
  if (!!combo.alt !== e.altKey) return false;
  return e.key.toLowerCase() === combo.key.toLowerCase();
}

/**
 * The canonical shortcut for each app command, keyed by command id. Every combo
 * here uses a modifier, so the global handler can fire it even while a text
 * field or the editor has focus without stealing ordinary typing.
 */
export const SHORTCUTS = {
  commandPalette: {key: 'k', mod: true},
  newPage: {key: 'n', mod: true},
  toggleSidebar: {key: '\\', mod: true},
  openSettings: {key: ',', mod: true},
  goBack: {key: '[', mod: true},
  goForward: {key: ']', mod: true},
  toggleFullWidth: {key: '.', mod: true},
  toggleTheme: {key: 'l', mod: true, shift: true},
  openTrash: {key: 'delete', mod: true, shift: true},
} as const satisfies Record<string, ShortcutCombo>;

export type ShortcutId = keyof typeof SHORTCUTS;
