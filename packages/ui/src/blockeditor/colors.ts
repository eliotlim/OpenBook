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
