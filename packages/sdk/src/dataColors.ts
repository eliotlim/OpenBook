/**
 * Canonical data-colour palette — the single source for every colour OpenBook
 * paints *data* with: select-option chips, tag dots/swatches, chart series
 * (kit + database), and status lights.
 *
 * The default **Pastel** scheme is the owner-selected soft-pastel set (rendered
 * candidates reviewed 2026-07-05): light fills/chips + a per-hue dark chip and a
 * dark dot/series fill. The **Vivid** and **Muted** schemes are the
 * contrast-solved sets from `docs/design/ob-375-palette-audit.mjs` and are not
 * rendered yet (they land with the "Data colours" control, OB-379).
 *
 * Plain data, no DOM. The UI consumes it as CSS variables at runtime
 * (`applyDataColors` in `@book.dev/ui`) and inlines the resolved values at
 * export time (exports are self-contained HTML/PDF and must not read live
 * CSS variables).
 *
 * The 9 {@link SELECT_COLORS} names (database.ts) are a strict subset of
 * {@link DATA_COLOR_TOKENS}; `teal`/`cyan`/`indigo` are extension tokens that
 * are NOT storable on select options and are not part of the rendered pastel
 * cycle (stored enum stays 9 — rendering-only).
 */

export type DataColorToken =
  | 'gray' | 'brown' | 'orange' | 'yellow' | 'green' | 'blue'
  | 'purple' | 'pink' | 'red' | 'teal' | 'cyan' | 'indigo';

export type DataColorScheme = 'pastel' | 'vivid' | 'muted';

export interface ChipColors {
  bg: string;
  fg: string;
}

export interface DataColor {
  /** Dot/swatch, chart-series and status-lamp fill in **light** mode. */
  fill: string;
  /** The same, in **dark** mode (dots/swatches flip; equals `fill` when the
   *  scheme is mode-invariant — i.e. every token bar the pastel select set). */
  fillDark: string;
  chip: {light: ChipColors; dark: ChipColors};
}

export const DATA_COLOR_TOKENS = [
  'gray', 'brown', 'orange', 'yellow', 'green', 'blue',
  'purple', 'pink', 'red', 'teal', 'cyan', 'indigo',
] as const satisfies readonly DataColorToken[];

export const DATA_COLOR_SCHEMES = ['pastel', 'vivid', 'muted'] as const satisfies readonly DataColorScheme[];

export const DEFAULT_DATA_COLOR_SCHEME: DataColorScheme = 'pastel';

export const isDataColorToken = (v: unknown): v is DataColorToken =>
  typeof v === 'string' && (DATA_COLOR_TOKENS as readonly string[]).includes(v);

/**
 * Canonical series cycling order for charts (kit + database) — the 9 select
 * tokens, blue-first, giving 9 distinguishable series before repeating. The
 * extension tokens (`teal`/`cyan`/`indigo`) sit outside the cycle.
 */
export const SERIES_ORDER = [
  'blue', 'orange', 'green', 'purple', 'pink', 'yellow', 'red', 'brown', 'gray',
] as const satisfies readonly DataColorToken[];

/**
 * Hairline stroke carried by chart shapes, swatch dots and status lamps in the
 * pastel/muted schemes, **light mode only** (soft-pastel fills sit low against a
 * white page; the hairline keeps them legible). Vivid and dark mode get none.
 */
export const DATA_STROKE = 'rgba(0,0,0,0.12)';

/** The scheme's hairline stroke for a light surface ('none' for vivid). */
export const dataStroke = (scheme: DataColorScheme): string =>
  scheme === 'vivid' ? 'none' : DATA_STROKE;

// ── Palette values ───────────────────────────────────────────────────────────

type Palette = Record<DataColorToken, DataColor>;

/** `fillDark` defaults to `fill` — the mode-invariant case (vivid/muted, and the
 *  pastel extension tokens). The pastel select tokens pass a distinct dark dot. */
const entry = (
  fill: string, lightBg: string, lightFg: string, darkBg: string, darkFg: string, fillDark: string = fill,
): DataColor => ({
  fill,
  fillDark,
  chip: {light: {bg: lightBg, fg: lightFg}, dark: {bg: darkBg, fg: darkFg}},
});

/**
 * Pastel (default) — the owner-selected soft-pastel set. Light fill / chip bg /
 * chip fg / dark dot-fill are owner values (rendered-candidate pick, 2026-07-05);
 * the per-hue dark chip (deep muted bg + light on-hue fg, all ≥ 4.5:1) is derived
 * — see the derivation guard in `dataColors.test.ts`. `teal`/`cyan`/`indigo` are
 * unrendered extension tokens (kept from the audit set, mode-invariant).
 */
const PASTEL: Palette = {
  gray: entry('#c3c6cb', '#e3e2e0', '#5c6475', '#31363f', '#cccfd7', '#b0b5bf'),
  brown: entry('#d7af9d', '#eee0da', '#9d4c2a', '#4f2f22', '#e8c8ba', '#ddac98'),
  orange: entry('#debea6', '#fadec9', '#935425', '#4f3522', '#e8ceba', '#e3bda1'),
  yellow: entry('#dac495', '#fdecc8', '#876622', '#4f4022', '#e8d9ba', '#e0c690'),
  green: entry('#9fdf9f', '#dbeddb', '#1e761e', '#224f22', '#bae8ba', '#9ae49a'),
  blue: entry('#a9ccdf', '#d3e5ef', '#24698f', '#223f4f', '#bad8e8', '#a5cde4'),
  purple: entry('#cdade1', '#e8deee', '#9032c8', '#3e224f', '#d7bae8', '#cfa8e6'),
  pink: entry('#dea6be', '#f5e0e9', '#b82e69', '#4f2235', '#e8bace', '#e3a1bd'),
  red: entry('#deaea6', '#ffe2dd', '#b4412d', '#4f2822', '#e8c1ba', '#e3aaa1'),
  teal: entry('#5eead4', '#99f6e4', '#115e59', '#203836', '#99f6e4'),
  cyan: entry('#67e8f9', '#a5f3fc', '#155e75', '#213840', '#a5f3fc'),
  indigo: entry('#a5b4fc', '#c7d2fe', '#3730a3', '#2c2b4c', '#c7d2fe'),
};

/** Vivid: today's saturated `SWATCH_HEX` look (orange `#f59e0b` → `#f97316`). */
const VIVID: Palette = {
  gray: entry('#9ca3af', '#d4d4d8', '#32373e', '#484b51', '#cdd0d6'),
  brown: entry('#b08968', '#bdac9e', '#45372b', '#534437', '#d8d1ca'),
  orange: entry('#f97316', '#fdba74', '#603110', '#693e21', '#e7cdbb'),
  yellow: entry('#eab308', '#fde047', '#5f4c11', '#685721', '#e7dcbc'),
  green: entry('#22c55e', '#86efac', '#1a5630', '#2a603e', '#c1e1cd'),
  blue: entry('#3b82f6', '#93c5fd', '#122f5e', '#223d67', '#bccce6'),
  purple: entry('#a855f7', '#d8b4fe', '#39125e', '#462267', '#d2bce6'),
  pink: entry('#ec4899', '#f9a8d4', '#5a1638', '#642644', '#e4bed1'),
  red: entry('#ef4444', '#fca5a5', '#5c1515', '#652525', '#e4bebe'),
  teal: entry('#14b8a6', '#5eead4', '#165a52', '#26635d', '#bfe4df'),
  cyan: entry('#06b6d4', '#67e8f9', '#105460', '#215e69', '#bbe0e7'),
  indigo: entry('#6366f1', '#a5b4fc', '#15165b', '#252764', '#bebfe4'),
};

/** Muted: hue preserved, saturation compressed — greyed washes. */
const MUTED: Palette = {
  gray: entry('#8d929a', '#e4e5e7', '#4d5056', '#3b3d40', '#c4c6ca'),
  brown: entry('#9f9389', '#e8e5e3', '#59514a', '#413d3a', '#cac7c3'),
  orange: entry('#b28e75', '#ebe5e0', '#694d3a', '#463c34', '#d2c5bc'),
  yellow: entry('#b2a376', '#ebe8e0', '#685d3b', '#464235', '#d1ccbc'),
  green: entry('#7dab8e', '#e2e9e4', '#40634d', '#37443b', '#bfcfc5'),
  blue: entry('#778db1', '#e0e4eb', '#3b4c68', '#353b46', '#bdc4d1'),
  purple: entry('#9577b1', '#e6e0eb', '#523b68', '#3d3546', '#c7bdd1'),
  pink: entry('#ae7a94', '#eae1e5', '#653e51', '#45363d', '#d0bec7'),
  red: entry('#af7979', '#eae1e1', '#663d3d', '#453535', '#d0bdbd'),
  teal: entry('#7aaea8', '#e1eae9', '#3e6561', '#364543', '#bed0ce'),
  cyan: entry('#76a9b2', '#e0e9eb', '#3a6269', '#354346', '#bcced2'),
  indigo: entry('#797aaf', '#e1e1ea', '#3d3e66', '#363645', '#bebed0'),
};

export const DATA_PALETTE: Record<DataColorScheme, Palette> = {
  pastel: PASTEL,
  vivid: VIVID,
  muted: MUTED,
};

// ── Derivations ──────────────────────────────────────────────────────────────

/** The light-mode fill for chart series `i` (cycles over {@link SERIES_ORDER}). */
export const seriesColor = (i: number, scheme: DataColorScheme = DEFAULT_DATA_COLOR_SCHEME): string =>
  DATA_PALETTE[scheme][SERIES_ORDER[i % SERIES_ORDER.length]].fill;

/**
 * Semantic token behind each status-light state. Warn is **yellow** (not orange):
 * at the soft-pastel saturations orange and red are near-identical, so the trio
 * uses green / yellow / red for a glanceable traffic light.
 */
export const STATUS_TOKENS = {ok: 'green', warn: 'yellow', bad: 'red'} as const;

/** The status-lamp light-mode fill for a state (`ok → green`, `warn → yellow`, `bad → red`). */
export const statusColor = (s: 'ok' | 'warn' | 'bad', scheme: DataColorScheme = DEFAULT_DATA_COLOR_SCHEME): string =>
  DATA_PALETTE[scheme][STATUS_TOKENS[s]].fill;

/** A `#rrggbb` hex as an `rgba()` string at the given alpha (for export inlining). */
export function hexAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},${alpha})`;
}
