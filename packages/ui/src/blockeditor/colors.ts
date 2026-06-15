/**
 * The shared editor colour palette — a small set of named tints used for both
 * block colours (background `bg` / text `fg` props) and inline text runs
 * (highlight `hl` / text-colour `tc` attributes). Tokens (not raw hex) are
 * stored in the document and rendered as CSS classes (`obe-fg-*`, `obe-bg-*`,
 * `obe-hl-*`), so every colour adapts to light and dark themes via index.css.
 */
export interface ColorToken {
  id: string;
  label: string;
}

export const COLOR_TOKENS: readonly ColorToken[] = [
  {id: 'gray', label: 'Gray'},
  {id: 'brown', label: 'Brown'},
  {id: 'orange', label: 'Orange'},
  {id: 'yellow', label: 'Yellow'},
  {id: 'green', label: 'Green'},
  {id: 'blue', label: 'Blue'},
  {id: 'purple', label: 'Purple'},
  {id: 'pink', label: 'Pink'},
  {id: 'red', label: 'Red'},
];

const IDS = new Set(COLOR_TOKENS.map((c) => c.id));

/** Whether `v` is one of the known palette tokens (guards class names). */
export const isColorToken = (v: string | undefined | null): v is string => !!v && IDS.has(v);

/**
 * Concrete light-theme hex for each token — used by the **exports** (HTML/PDF),
 * which are self-contained and can't reference the editor's theme-adaptive CSS
 * classes. `fg` colours text (`tc`); `hl` tints a highlight (`hl`).
 */
export const COLOR_EXPORT_HEX: Record<string, {fg: string; hl: string}> = {
  gray: {fg: '#6b7280', hl: '#e5e7eb'},
  brown: {fg: '#92400e', hl: '#ece0d8'},
  orange: {fg: '#c2410c', hl: '#ffedd5'},
  yellow: {fg: '#a16207', hl: '#fef3c7'},
  green: {fg: '#15803d', hl: '#dcfce7'},
  blue: {fg: '#1d4ed8', hl: '#dbeafe'},
  purple: {fg: '#7e22ce', hl: '#f3e8ff'},
  pink: {fg: '#be185d', hl: '#fce7f3'},
  red: {fg: '#b91c1c', hl: '#fee2e2'},
};
