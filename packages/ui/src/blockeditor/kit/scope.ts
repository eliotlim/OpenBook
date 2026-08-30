import type * as Y from 'yjs';
import {KIT_VALUE_BLOCK_TYPES} from '@book.dev/sdk';
import {blockChildren, blockId, blockProp, blockType, rootBlocks, setBlockProp, type TextRun, walkBlocks, type BlockMap} from '../model';
import {varNameFromLabel} from './options';
import {containerCompletions} from './completion';
import type {DbChartSeriesMap} from './chartData';
import {quickJSEvalBackend} from './sandbox/quickjsBackend';
import {quickJSSyncEvalBackend} from './sandbox/quickjsSyncBackend';

/**
 * The artifact kit's reactive backbone. Every *input* block publishes a named
 * value; formulas, charts, and status lights evaluate expressions over the
 * whole scope. Values are ordinary CRDT block props, so a stepper click or a
 * radio pick syncs to every collaborator. The evaluation cache snapshots each
 * document version and notifies subscribed render consumers asynchronously.
 */

/** A legal reactive identifier. */
export const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

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

/** Block types that publish a named value into the scope, derived from the SDK catalogue. */
export const INPUT_TYPES = KIT_VALUE_BLOCK_TYPES;

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
    return {lat: lat ?? null, lng: lng ?? null, label: blockProp<string>(block, 'labeltext') ?? ''};
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
  const target = name.trim();
  for (const {block} of walkBlocks(rootBlocks(doc))) {
    if (INPUT_TYPES.has(blockType(block) as string) && publishedName(block) === target) return block;
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
    if (value && typeof value === 'object') {
      const location = value as {lat?: unknown; lng?: unknown; label?: unknown};
      setBlockProp(block, 'lat', location.lat);
      setBlockProp(block, 'lng', location.lng);
      setBlockProp(block, 'labeltext', String(location.label ?? ''));
    }
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

/** One evaluation result. Evaluators surface document errors; they never throw
 * them through the render tree. */
export interface EvalResult {
  value?: unknown;
  error?: string;
}

/** A serializable request at the evaluator/Worker boundary. */
export interface EvalRequest {
  kind: 'expression' | 'code';
  source: string;
  scope: Record<string, unknown>;
  /** Absolute host timestamp shared by one authoritative export pass. */
  deadlineMs?: number;
}

/** Async evaluator seam, implemented by the resident QuickJS Worker. */
export interface EvalBackend {
  evaluate(request: EvalRequest): Promise<EvalResult>;
}

/** Synchronous evaluator seam for authoritative save/export checkpoints. */
export interface SyncEvalBackend {
  /** Fixed-cost WASM setup is lazy, but happens before the document budget starts. */
  prepare?(): Promise<void>;
  /** The release-SYNC VM runs without yielding once its lazily-loaded WASM is ready. */
  evaluate(request: EvalRequest): Promise<EvalResult>;
}

interface ExportSafeResult {
  ok: boolean;
  value?: unknown;
}

type ExportSafeReader = (
  source: string,
  get: (cellId: string) => unknown,
  bindings: Readonly<Record<string, unknown>>,
) => ExportSafeResult;

/** The standalone viewer injects SBX-3's compiler-free interpreter first. */
function readExportExpression(source: string, scope: Record<string, unknown>): EvalResult {
  const reader = (globalThis as {__OB_SAFE_EXPRESSION__?: ExportSafeReader}).__OB_SAFE_EXPRESSION__;
  if (!reader) return {error: 'Safe expression runtime is unavailable'};
  const result = reader(source, () => undefined, scope);
  return result.ok ? {value: result.value} : {error: 'Unsupported expression in standalone export'};
}

/** Viewer render evaluation stays inside SBX-3's interpreter; the app uses the Worker. */
export const renderEvalBackend: EvalBackend = __OB_SAFE_EXPORT_VIEWER__ ? {
  evaluate(request) {
    return Promise.resolve(readExportExpression(request.source, request.scope));
  },
} : quickJSEvalBackend;

/** Non-render async helpers. UI components should use `useCachedEval` so they
 * also get versioning, subscriptions, and last-known snapshots. */
export function evalExpr(
  source: string,
  scope: Record<string, unknown>,
  backend: EvalBackend = renderEvalBackend,
): Promise<EvalResult> {
  return backend.evaluate({kind: 'expression', source, scope});
}

export function evalCode(
  source: string,
  scope: Record<string, unknown>,
  backend: EvalBackend = renderEvalBackend,
): Promise<EvalResult> {
  return backend.evaluate({kind: 'code', source, scope});
}

export interface ComputedScope {
  /** Every name a consumer can reference: inputs + named live-code outputs. */
  scope: Record<string, unknown>;
  /** Per-block evaluation results (live code + legacy formulas), by block id. */
  results: Map<string, EvalResult>;
}

/** An immutable document-order program captured for asynchronous evaluation. */
export interface ScopeProgram {
  input: Record<string, unknown>;
  cells: Array<{id: string; name?: string; request: Omit<EvalRequest, 'scope'>}>;
}

/** Capture mutable CRDT state before the first async hop. */
export function captureScopeProgram(doc: Y.Doc): ScopeProgram {
  const cells: ScopeProgram['cells'] = [];
  for (const {block} of walkBlocks(rootBlocks(doc))) {
    const type = blockType(block) as string;
    const isLiveCode = type === 'code' && Boolean(blockProp<boolean>(block, 'live'));
    if (!isLiveCode && type !== 'formula') continue;
    cells.push({
      id: String(block.get('id')),
      name: blockProp<string>(block, 'name'),
      request: {
        kind: isLiveCode ? 'code' : 'expression',
        source: isLiveCode ? (blockTextString(block) ?? '') : (blockProp<string>(block, 'source') ?? ''),
      },
    });
  }
  return {input: inputScope(doc), cells};
}

/** Evaluate a captured program through the async backend, preserving ordered
 * chaining (each named cell is visible to the cells below it). */
export async function evaluateScopeProgram(
  program: ScopeProgram,
  backend: EvalBackend = renderEvalBackend,
): Promise<ComputedScope> {
  const scope = {...program.input};
  const results = new Map<string, EvalResult>();
  for (const cell of program.cells) {
    const result = await backend.evaluate({...cell.request, scope});
    results.set(cell.id, result);
    const name = cell.name?.trim();
    if (name && NAME_RE.test(name) && !result.error) scope[name] = result.value;
  }
  return {scope, results};
}

export const EXPORT_EVALUATION_BUDGET_MS = 100;
export const EXPORT_DEADLINE_ERROR = `Export evaluation exceeded the ${EXPORT_EVALUATION_BUDGET_MS} ms budget`;

const deadlineResult = (): EvalResult => ({error: EXPORT_DEADLINE_ERROR});

/**
 * Authoritative expression evaluation composes both safety layers: the app
 * awaits the lazily-created in-process release-SYNC QuickJS VM, while the
 * standalone viewer delegates to SBX-3's compiler-free expression reader.
 */
function evalExprSync(
  source: string,
  scope: Record<string, unknown>,
  backend: SyncEvalBackend,
  deadlineMs: number,
): Promise<EvalResult> {
  if (!source.trim()) return Promise.resolve({value: undefined});
  if (Date.now() >= deadlineMs) return Promise.resolve(deadlineResult());
  if (__OB_SAFE_EXPORT_VIEWER__) return Promise.resolve(readExportExpression(source, scope));
  return backend.evaluate({kind: 'expression', source, scope, deadlineMs});
}

/** Same composition for live-code bodies (the safe reader supports its bounded statement shell). */
function evalCodeSync(
  source: string,
  scope: Record<string, unknown>,
  backend: SyncEvalBackend,
  deadlineMs: number,
): Promise<EvalResult> {
  if (!source.trim()) return Promise.resolve({value: undefined});
  if (Date.now() >= deadlineMs) return Promise.resolve(deadlineResult());
  if (__OB_SAFE_EXPORT_VIEWER__) return Promise.resolve(readExportExpression(source, scope));
  return backend.evaluate({kind: 'code', source, scope, deadlineMs});
}

/**
 * The document's full reactive scope: input values first, then every LIVE
 * code block (and legacy formula block) evaluated **in document order**, each
 * seeing the inputs plus all named outputs above it — so computations chain.
 * A single ordered pass: forward references read `undefined`, cycles can't
 * happen.
 */
export async function computeScopeAuthoritative(
  doc: Y.Doc,
  backend: SyncEvalBackend = quickJSSyncEvalBackend,
  deadlineMs?: number,
): Promise<ComputedScope> {
  await backend.prepare?.();
  const evaluationDeadline = deadlineMs ?? Date.now() + EXPORT_EVALUATION_BUDGET_MS;
  const program = captureScopeProgram(doc);
  const scope = {...program.input};
  const results = new Map<string, EvalResult>();
  for (const cell of program.cells) {
    const result = Date.now() >= evaluationDeadline
      ? deadlineResult()
      : await (cell.request.kind === 'code'
        ? evalCodeSync(cell.request.source, scope, backend, evaluationDeadline)
        : evalExprSync(cell.request.source, scope, backend, evaluationDeadline));
    results.set(cell.id, result);
    const name = cell.name?.trim();
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

// ── Status light status (shared with the export pipeline) ────────────────────

/** The status-light state. `off` = neutral (no/unevaluable value). */
export type Status = 'ok' | 'warn' | 'bad' | 'off';

/**
 * Map a status-light expression result to a state. Booleans → ok/bad; numbers
 * → ok at/above `okAt`, warn at/above `warnAt`, else bad; the strings
 * ok/warn/bad pass through; anything else is neutral. Shared by the live block
 * and the exporters so a light's colour is identical in the window and a PDF.
 */
export function statusOf(value: unknown, error: string | undefined, okAt: number, warnAt: number): Status {
  if (error || value === undefined || value === null) return 'off';
  if (typeof value === 'boolean') return value ? 'ok' : 'bad';
  if (typeof value === 'string') return value === 'ok' || value === 'warn' || value === 'bad' ? value : 'off';
  if (typeof value === 'number') {
    if (value >= okAt) return 'ok';
    if (value >= warnAt) return 'warn';
    return 'bad';
  }
  return 'off';
}

// ── Export value resolution ──────────────────────────────────────────────────

/** One reactive block's resolved value for export (and a status light's state). */
export interface ExportCell {
  value: unknown;
  /** Status lights only: the resolved ok/warn/bad/off state. */
  status?: Status;
}

/**
 * Resolve every reactive block's CURRENT value the way the editor does, keyed by
 * block id — so static exports (PDF / Markdown) and the pre-hydration HTML show
 * the same numbers, charts, lights and bars as the live window. Inputs publish
 * their value; live code / formulas come from
 * {@link computeScopeAuthoritative}; charts,
 * status lights, and progress bars evaluate their expression over the same
 * scope (mirroring their block components).
 */
export async function computeExportCells(
  doc: Y.Doc,
  dbSeries?: DbChartSeriesMap,
  backend: SyncEvalBackend = quickJSSyncEvalBackend,
): Promise<Map<string, ExportCell>> {
  // Export is an explicit non-render checkpoint and reflects this exact
  // document through an in-process QuickJS sandbox. It must not depend on an
  // async render Worker or execute document formulas in the host realm.
  await backend.prepare?.();
  const deadlineMs = Date.now() + EXPORT_EVALUATION_BUDGET_MS;
  const {scope, results} = await computeScopeAuthoritative(doc, backend, deadlineMs);
  const cells = new Map<string, ExportCell>();
  for (const {block} of walkBlocks(rootBlocks(doc))) {
    const id = blockId(block);
    const type = blockType(block) as string;
    if (INPUT_TYPES.has(type)) {
      cells.set(id, {value: inputValue(block)});
    } else if (type === 'formula' || (type === 'code' && Boolean(blockProp<boolean>(block, 'live')))) {
      const r = results.get(id);
      cells.set(id, {value: r?.error ? undefined : r?.value});
    } else if (type === 'kitchart' && blockProp<string>(block, 'sourceMode') === 'database') {
      // A database-bound chart's data can't be recomputed from the doc alone (it
      // needs the data client, absent in a static export). It's resolved live at
      // export time and threaded in via `dbSeries` — the doc holds NO derived
      // snapshot, so viewing/presenting the chart never writes anything.
      cells.set(id, {value: dbSeries?.get(id)?.value});
    } else if (type === 'kitchart' || type === 'progressbar') {
      const {value} = await evalExprSync(blockProp<string>(block, 'source') ?? '', scope, backend, deadlineMs);
      cells.set(id, {value});
    } else if (type === 'statuslight') {
      const {value, error} = await evalExprSync(blockProp<string>(block, 'source') ?? '', scope, backend, deadlineMs);
      const okAt = Number(blockProp<number>(block, 'okAt') ?? 1);
      const warnAt = Number(blockProp<number>(block, 'warnAt') ?? 0);
      cells.set(id, {value, status: statusOf(value, error, okAt, warnAt)});
    }
  }
  return cells;
}
