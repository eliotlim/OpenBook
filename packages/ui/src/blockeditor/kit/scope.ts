import type * as Y from 'yjs';
import {blockChildren, blockProp, blockType, rootBlocks, setBlockProp, type TextRun, walkBlocks, type BlockMap} from '../model';
import {varNameFromLabel} from './options';
import {containerCompletions} from './completion';

/**
 * The artifact kit's reactive backbone. Every *input* block publishes a named
 * value; formulas, charts, and status lights evaluate expressions over the
 * whole scope. Values are ordinary CRDT block props, so a stepper click or a
 * radio pick syncs to every collaborator — and the editor's version counter
 * re-renders every consumer on any change. No subscription plumbing needed.
 */

/** A legal reactive identifier. */
const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The name a block publishes under: its explicit variable `name` when set,
 * otherwise one derived from the human display `label` ("Dark mode" → darkMode).
 * So an author who only fills in a display name still gets a working reactive
 * symbol — without it, display-name-only inputs published nothing and the whole
 * dataflow looked empty. Returns '' when neither yields a legal identifier.
 */
export function publishedName(block: BlockMap): string {
  const explicit = (blockProp<string>(block, 'name') ?? '').trim();
  if (explicit) return NAME_RE.test(explicit) ? explicit : '';
  const derived = varNameFromLabel(blockProp<string>(block, 'label') ?? '');
  return derived && NAME_RE.test(derived) ? derived : '';
}

/** Block types that publish a named value into the scope. */
export const INPUT_TYPES = new Set([
  'slider', 'number', 'textfield', 'radio', 'checklist', 'dropdown', 'location', 'toggle',
  // June-2026 additions (kit/inputs2.tsx). Choice cards publish single|multi like
  // radio/checklist; the two long-text variants publish a plain string; the
  // searchable select / tag field publish single|multi like dropdown/checklist.
  'choicecards', 'longtext', 'richtext', 'searchselect', 'tagfield',
]);

/**
 * The reactive namespace a group publishes under — a legal identifier derived
 * from the group's display name. Inputs inside a named group are exported as
 * `group.field.value`; an unnamed group adds no namespace.
 */
export function groupKey(block: BlockMap): string {
  return varNameFromLabel(blockProp<string>(block, 'name') ?? '');
}

/** Walk inputs depth-first, tracking the nearest enclosing group's key. */
function eachInput(list: Y.Array<BlockMap>, group: string, cb: (block: BlockMap, group: string) => void): void {
  for (const block of list) {
    const type = blockType(block) as string;
    if (INPUT_TYPES.has(type)) cb(block, group);
    const children = blockChildren(block);
    if (children) eachInput(children, type === 'group' ? groupKey(block) || group : group, cb);
  }
}

/** The plain-text projection of a rich-text input's stored runs. Used as the
 *  block's published value (so evalExpr/export read a string) and by the export
 *  tokenizer. Defined here so scope, the renderer, and exports agree. */
export function richTextPlain(block: BlockMap): string {
  const runs = blockProp<TextRun[]>(block, 'runs');
  return Array.isArray(runs) ? runs.map((r) => r.t).join('') : '';
}

/** The published value of one input block (shape depends on the type). */
export function inputValue(block: BlockMap): unknown {
  switch (blockType(block) as string) {
  case 'slider':
  case 'number':
    return Number(blockProp<number>(block, 'value') ?? 0);
  case 'textfield':
    return String(blockProp<string>(block, 'value') ?? '');
  case 'radio':
  case 'dropdown':
    return blockProp<string>(block, 'value') ?? null;
  case 'checklist': {
    const selected = blockProp<string[]>(block, 'selected');
    return Array.isArray(selected) ? selected : [];
  }
  case 'choicecards': {
    // Multi-select cards publish the selected array; single cards publish a
    // scalar (mirrors checklist vs radio value rules).
    if (blockProp<boolean>(block, 'multi')) {
      const selected = blockProp<string[]>(block, 'selected');
      return Array.isArray(selected) ? selected : [];
    }
    return blockProp<string>(block, 'value') ?? null;
  }
  case 'searchselect':
  case 'tagfield': {
    // Multi publishes string[]; single (searchselect only) publishes a scalar.
    // The tag field is always multi.
    if ((blockType(block) as string) === 'tagfield' || blockProp<boolean>(block, 'multi')) {
      const selected = blockProp<string[]>(block, 'selected');
      return Array.isArray(selected) ? selected : [];
    }
    return blockProp<string>(block, 'value') ?? null;
  }
  case 'longtext':
    return String(blockProp<string>(block, 'value') ?? '');
  case 'richtext':
    // Publishes the PLAIN-TEXT projection so formulas/exports stay predictable;
    // the markup itself lives in `runs` (the block renders it; export reads it).
    return richTextPlain(block);
  case 'toggle':
    return Boolean(blockProp<boolean>(block, 'value') ?? false);
  case 'location': {
    const lat = blockProp<number>(block, 'lat');
    const lng = blockProp<number>(block, 'lng');
    return {lat: lat ?? null, lng: lng ?? null, label: blockProp<string>(block, 'label') ?? ''};
  }
  default:
    return undefined;
  }
}

/** Every named input's current value, by name. */
export function inputScope(doc: Y.Doc): Record<string, unknown> {
  // Container completion reads first (read-only signals from tabs/accordion);
  // a real input sharing the name wins, so it overrides below.
  const scope: Record<string, unknown> = {...containerCompletions(doc)};
  eachInput(rootBlocks(doc), '', (block, group) => {
    const field = publishedName(block);
    if (!field) return;
    if (group) {
      // Grouped: scope.<group>.<field>.value — composition made addressable.
      const bag = (scope[group] as Record<string, unknown>) ?? (scope[group] = {});
      (bag as Record<string, unknown>)[field] = {value: inputValue(block)};
    } else {
      scope[field] = inputValue(block);
    }
  });
  return scope;
}

/** Find the first input block published under `name`, or null. */
export function findInput(doc: Y.Doc, name: string): BlockMap | null {
  for (const {block} of walkBlocks(rootBlocks(doc))) {
    if (INPUT_TYPES.has(blockType(block) as string) && publishedName(block) === name) return block;
  }
  return null;
}

/** Write an input's value back from a synced/plain value (inverse of inputValue). */
export function setInputValue(block: BlockMap, value: unknown): void {
  const type = blockType(block) as string;
  switch (type) {
  case 'checklist':
    setBlockProp(block, 'selected', Array.isArray(value) ? value : []);
    break;
  case 'choicecards':
  case 'searchselect':
  case 'tagfield':
    // Array-valued when multi (tagfield always); scalar otherwise.
    if (type === 'tagfield' || blockProp<boolean>(block, 'multi')) {
      setBlockProp(block, 'selected', Array.isArray(value) ? value : []);
    } else {
      setBlockProp(block, 'value', value);
    }
    break;
  case 'richtext':
    // Composite markup — adopted from another page only as plain text, written
    // as a single run so the renderer stays consistent.
    setBlockProp(block, 'runs', [{t: String(value ?? '')}]);
    break;
  case 'location':
    // Composite value — left to its own controls for now.
    break;
  default:
    setBlockProp(block, 'value', value);
    break;
  }
}

/** A group's own inputs, keyed by published field name (not crossing into any
 *  nested group, which keeps its own namespace). Drives cross-page sync. */
export function groupInputs(group: BlockMap): Map<string, BlockMap> {
  const map = new Map<string, BlockMap>();
  const visit = (list: Y.Array<BlockMap>): void => {
    for (const block of list) {
      const type = blockType(block) as string;
      if (INPUT_TYPES.has(type)) {
        const field = publishedName(block);
        if (field && !map.has(field)) map.set(field, block);
      }
      const children = blockChildren(block);
      if (children && type !== 'group') visit(children);
    }
  };
  const children = blockChildren(group);
  if (children) visit(children);
  return map;
}

/**
 * Write a numeric input's value (button actions: set / increment). Clamps to
 * the input's own min/max when it declares them. No-op when the name doesn't
 * resolve or the target isn't numeric.
 */
export function setNamedNumber(doc: Y.Doc, name: string, next: (current: number) => number): void {
  const block = findInput(doc, name);
  if (!block) return;
  const type = blockType(block) as string;
  if (type !== 'slider' && type !== 'number' && type !== 'toggle') return;
  doc.transact(() => {
    if (type === 'toggle') {
      setBlockProp(block, 'value', !blockProp<boolean>(block, 'value'));
      return;
    }
    const current = Number(blockProp<number>(block, 'value') ?? 0);
    let value = next(current);
    const min = blockProp<number>(block, 'min');
    const max = blockProp<number>(block, 'max');
    if (typeof min === 'number') value = Math.max(min, value);
    if (typeof max === 'number') value = Math.min(max, value);
    setBlockProp(block, 'value', value);
  }, 'local');
}

/**
 * Evaluate an expression over the input scope. Same trust model as the app's
 * expr blocks: the document's own code runs client-side with the inputs in
 * scope. Returns `{value}` or `{error}` — callers render, never throw.
 */
export function evalExpr(source: string, scope: Record<string, unknown>): {value?: unknown; error?: string} {
  if (!source.trim()) return {value: undefined};
  try {
    const fn = new Function(...Object.keys(scope), `"use strict"; return (${source});`);
    return {value: fn(...Object.values(scope)) as unknown};
  } catch (err) {
    return {error: err instanceof Error ? err.message : String(err)};
  }
}

/**
 * Evaluate live-code: a single expression, or — when that doesn't parse — a
 * function body (multi-line code with its own `return`). Lets a live code
 * block hold real programs, not just one-liners.
 */
export function evalCode(source: string, scope: Record<string, unknown>): {value?: unknown; error?: string} {
  if (!source.trim()) return {value: undefined};
  const keys = Object.keys(scope);
  const values = Object.values(scope);
  try {
    const fn = new Function(...keys, `"use strict"; return (${source});`);
    return {value: fn(...values) as unknown};
  } catch (err) {
    if (!(err instanceof SyntaxError)) return {error: err instanceof Error ? err.message : String(err)};
  }
  try {
    const fn = new Function(...keys, `"use strict"; ${source}`);
    return {value: fn(...values) as unknown};
  } catch (err) {
    return {error: err instanceof Error ? err.message : String(err)};
  }
}

export interface ComputedScope {
  /** Every name a consumer can reference: inputs + named live-code outputs. */
  scope: Record<string, unknown>;
  /** Per-block evaluation results (live code + legacy formulas), by block id. */
  results: Map<string, {value?: unknown; error?: string}>;
}

/**
 * The document's full reactive scope: input values first, then every LIVE
 * code block (and legacy formula block) evaluated **in document order**, each
 * seeing the inputs plus all named outputs above it — so computations chain.
 * A single ordered pass: forward references read `undefined`, cycles can't
 * happen.
 */
export function computeScope(doc: Y.Doc): ComputedScope {
  const scope = inputScope(doc);
  const results = new Map<string, {value?: unknown; error?: string}>();
  for (const {block} of walkBlocks(rootBlocks(doc))) {
    const type = blockType(block) as string;
    const isLiveCode = type === 'code' && Boolean(blockProp<boolean>(block, 'live'));
    if (!isLiveCode && type !== 'formula') continue;
    const source = isLiveCode ? (blockTextString(block) ?? '') : (blockProp<string>(block, 'source') ?? '');
    const result = isLiveCode ? evalCode(source, scope) : evalExpr(source, scope);
    results.set(String(block.get('id')), result);
    const name = blockProp<string>(block, 'name');
    if (name && NAME_RE.test(name) && !result.error) scope[name] = result.value;
  }
  return {scope, results};
}

/** The plain text of a text-carrying block (code blocks store Y.Text). */
function blockTextString(block: BlockMap): string | undefined {
  const text = block.get('text');
  return text && typeof (text as {toString: () => string}).toString === 'function' ? String(text) : undefined;
}

/** Render an evaluated value the way the formula block does (compact numbers). */
export function formatValue(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'number' && !Number.isInteger(value)) return String(Math.round(value * 1000) / 1000);
  if (Array.isArray(value)) return value.map(formatValue).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
