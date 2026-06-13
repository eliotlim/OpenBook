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
}

/** Stored option (value may be blank → falls back to a slug of the label). */
interface RawOption {
  label: string;
  value?: string;
}

/** A URL/identifier-friendly slug of a label ("Option 1" → "option-1"). */
export const slugify = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * A valid JS-identifier variable name derived from a display label, so an
 * input the reader knows as "Dark mode" publishes as `darkMode` without the
 * author ever opening the config. camelCase; a leading digit is prefixed with
 * `_`; an empty/symbol-only label yields ''. The reactive engine references
 * these (`new Function(name, …)`), so the result is always a legal identifier.
 */
export const varNameFromLabel = (label: string): string => {
  const words = label.trim().split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return '';
  const camel = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
  return /^[0-9]/.test(camel) ? `_${camel}` : camel;
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
      .map((o) => ({label: o.label, value: o.value}));
  }
  if (typeof props.options === 'string') return parseOptionsString(props.options);
  return [];
}

/** Fully-resolved options (every value non-empty) for rendering + publishing. */
export function resolveOptions(block: BlockMap): KitOption[] {
  const raw = rawOptions({opts: blockProp<unknown>(block, 'opts'), options: blockProp<unknown>(block, 'options')});
  return raw.map((o) => ({label: o.label, value: optionValue(o)}));
}

/** Same resolution from a plain props bag (export path). */
export function resolveOptionsFromProps(props: Record<string, unknown>): KitOption[] {
  return rawOptions(props).map((o) => ({label: o.label, value: optionValue(o)}));
}

/** Map a stored value back to its display label (falls back to the value). */
export const labelOf = (options: KitOption[], value: string): string =>
  options.find((o) => o.value === value)?.label ?? value;
