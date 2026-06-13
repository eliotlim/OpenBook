import {blockProp, type BlockMap} from '../model';

/**
 * Choice options for the radio / checklist / dropdown inputs.
 *
 * An option has a **display label** (what the reader sees) and a **value** (what
 * the reactive scope and exports serialise). They're decoupled so a friendly
 * "Option 1" can publish a clean `option-1`. The value defaults to a slug of
 * the label, so the simple case (label only) still works and old documents —
 * which stored a plain comma-separated `options` string where value == label —
 * keep resolving unchanged.
 */
export interface KitOption {
  label: string;
  value: string;
  /** Choice-card media (optional): a cover image (URL or data URL), an
   *  icon/emoji, or a palette colour token shown when no image is set. */
  image?: string;
  icon?: string;
  color?: string;
}

/** Stored option (value may be blank → falls back to a slug of the label). */
interface RawOption {
  label: string;
  value?: string;
  image?: string;
  icon?: string;
  color?: string;
}

/** A URL/identifier-friendly slug of a label ("Option 1" → "option-1"). */
export const slugify = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// Reserved words can't be used as a binding name in `new Function(name, …)`
// (the reactive engine), so a label that camelCases to one gets a trailing `_`.
const RESERVED_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof',
  'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void',
  'while', 'with', 'let', 'static', 'yield', 'await', 'async', 'implements', 'interface', 'package',
  'private', 'protected', 'public', 'arguments', 'eval',
]);

/**
 * Turn ANY free-text display label into a valid TypeScript identifier, so a
 * reader-facing name like "Tax rate (2024) 💰" still publishes a usable symbol
 * (`taxRate2024`) with the author never touching the config. The rules, in
 * order: fold accents to ASCII ("Café" → "Cafe"); split on every run of
 * non-identifier characters and camelCase the words; prefix a leading digit
 * with `_`; suffix a reserved word with `_`. Returns '' only when nothing
 * usable remains (the caller falls back to the block's default symbol). The
 * reactive engine references these via `new Function(name, …)`, so the result
 * is always legal.
 */
export const varNameFromLabel = (label: string): string => {
  const folded = label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const words = folded.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return '';
  const camel = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
  let name = /^[0-9]/.test(camel) ? `_${camel}` : camel;
  if (RESERVED_WORDS.has(name)) name = `${name}_`;
  return name;
};

/** The value an option actually publishes (explicit value, else slug of label). */
export const optionValue = (opt: RawOption): string => (opt.value?.trim() ? opt.value.trim() : slugify(opt.label));

/** Parse the legacy comma-separated string. `Label = value` sets an explicit
 *  value; a bare `Label` keeps value == label (the historical behaviour). */
export function parseOptionsString(raw: string): RawOption[] {
  return raw
    .split(',')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const eq = chunk.indexOf('=');
      if (eq === -1) return {label: chunk, value: chunk};
      return {label: chunk.slice(0, eq).trim(), value: chunk.slice(eq + 1).trim()};
    });
}

/** The stored raw options for a block: the structured `opts` array if present,
 *  else the parsed legacy `options` string. */
export function rawOptions(props: {opts?: unknown; options?: unknown}): RawOption[] {
  if (Array.isArray(props.opts)) {
    return props.opts
      .filter((o): o is RawOption => !!o && typeof (o as RawOption).label === 'string')
      .map((o) => ({label: o.label, value: o.value, image: o.image, icon: o.icon, color: o.color}));
  }
  if (typeof props.options === 'string') return parseOptionsString(props.options);
  return [];
}

/** Carry the optional media fields onto the resolved option (drops empties). */
const withMedia = (o: RawOption, value: string): KitOption => ({
  label: o.label,
  value,
  ...(o.image ? {image: o.image} : {}),
  ...(o.icon ? {icon: o.icon} : {}),
  ...(o.color ? {color: o.color} : {}),
});

/** Fully-resolved options (every value non-empty) for rendering + publishing. */
export function resolveOptions(block: BlockMap): KitOption[] {
  const raw = rawOptions({opts: blockProp<unknown>(block, 'opts'), options: blockProp<unknown>(block, 'options')});
  return raw.map((o) => withMedia(o, optionValue(o)));
}

/** Same resolution from a plain props bag (export path). */
export function resolveOptionsFromProps(props: Record<string, unknown>): KitOption[] {
  return rawOptions(props).map((o) => withMedia(o, optionValue(o)));
}

/** Map a stored value back to its display label (falls back to the value). */
export const labelOf = (options: KitOption[], value: string): string =>
  options.find((o) => o.value === value)?.label ?? value;
