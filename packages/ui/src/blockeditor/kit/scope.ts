import type * as Y from 'yjs';
import {blockProp, blockType, rootBlocks, setBlockProp, walkBlocks, type BlockMap} from '../model';

/**
 * The artifact kit's reactive backbone. Every *input* block publishes a named
 * value; formulas, charts, and status lights evaluate expressions over the
 * whole scope. Values are ordinary CRDT block props, so a stepper click or a
 * radio pick syncs to every collaborator — and the editor's version counter
 * re-renders every consumer on any change. No subscription plumbing needed.
 */

/** Block types that publish a named value into the scope. */
export const INPUT_TYPES = new Set(['slider', 'number', 'textfield', 'radio', 'checklist', 'location', 'toggle']);

/** The published value of one input block (shape depends on the type). */
export function inputValue(block: BlockMap): unknown {
  switch (blockType(block) as string) {
  case 'slider':
  case 'number':
    return Number(blockProp<number>(block, 'value') ?? 0);
  case 'textfield':
    return String(blockProp<string>(block, 'value') ?? '');
  case 'radio':
    return blockProp<string>(block, 'value') ?? null;
  case 'checklist': {
    const selected = blockProp<string[]>(block, 'selected');
    return Array.isArray(selected) ? selected : [];
  }
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
  const scope: Record<string, unknown> = {};
  for (const {block} of walkBlocks(rootBlocks(doc))) {
    if (!INPUT_TYPES.has(blockType(block) as string)) continue;
    const name = blockProp<string>(block, 'name');
    if (name && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) scope[name] = inputValue(block);
  }
  return scope;
}

/** Find the first input block published under `name`, or null. */
export function findInput(doc: Y.Doc, name: string): BlockMap | null {
  for (const {block} of walkBlocks(rootBlocks(doc))) {
    if (INPUT_TYPES.has(blockType(block) as string) && blockProp<string>(block, 'name') === name) return block;
  }
  return null;
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

/** Render an evaluated value the way the formula block does (compact numbers). */
export function formatValue(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'number' && !Number.isInteger(value)) return String(Math.round(value * 1000) / 1000);
  if (Array.isArray(value)) return value.map(formatValue).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
