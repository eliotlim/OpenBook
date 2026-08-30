/**
 * The block-type catalogue — the ONE types-only description of every block the
 * editor can render, shared by every layer that must reason about block types
 * without importing React:
 *
 *  - the UI's block model derives `BlockType`, `TEXT_BLOCKS` and
 *    `CONTAINER_BLOCKS` FROM this file (packages/ui/src/blockeditor/model.ts),
 *    so the core union cannot drift from the catalogue by construction;
 *  - the UI's runtime registry (registry.tsx + kit) is pinned to the `kit`
 *    entries by a drift-guard test (packages/ui/src/blockeditor/
 *    registryCatalogue.test.tsx) that registers every built-in custom block and
 *    fails when the registry and the catalogue disagree in either direction;
 *  - the server agent and the MCP server validate `add_blocks` /
 *    `create_artifact_page` / `update_block_props` payloads against it and
 *    serve it via their `list_block_types` tools.
 *
 * History: before this file the agent kept a hand-written `KNOWN_BLOCK_TYPES`
 * and the MCP server a hand-written `ARTIFACT_TYPES`; the two disagreed with
 * each other AND with the real registry (table/row/cell, image, notes, and
 * several kit blocks were missing from one or both). Those lists are gone —
 * everything reads this catalogue.
 *
 * Plugin blocks are NOT enumerated here (they are installed per library, not
 * compiled in). They are namespaced `<pluginId>/<type>` (plugins/api.ts), a
 * plugin declares its block types in its manifest (`PluginManifest.blocks`),
 * and validators accept them by pattern + an installed-plugin lookup where one
 * is available — see {@link isPluginBlockType} and {@link findUnknownBlockType}.
 */
import {BLOCK_PROP_JSON_SCHEMAS, BLOCK_PROP_SCHEMAS, type BlockPropsJsonSchema} from './blockPropSchemas';
export {BLOCK_PROP_JSON_SCHEMAS, BLOCK_PROP_SCHEMAS} from './blockPropSchemas';

/** How a block stores content: `container` blocks carry child blocks in
 *  `children`, `text` blocks carry rich text in `text`, `void` blocks carry
 *  only `props` (all kit widgets are void). */
export type BlockNature = 'container' | 'text' | 'void';

/** The value shapes per-type prop validation understands. Deliberately coarse
 *  — a permissive-but-typed check, not a schema language. */
export type BlockPropType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export interface BlockTypeInfo {
  /** The block `type` discriminator as stored in the document. */
  readonly type: string;
  /** `core` renders natively in the editor; `kit` is registered through the
   *  custom-block registry at startup (artifact kit, reactive blocks, dbview).
   *  Installed plugins contribute a third, per-library `plugin` category — see
   *  the module note. */
  readonly category: 'core' | 'kit';
  readonly nature: BlockNature;
  /** For child-only types: the ONE container this type must sit directly
   *  inside (column→columns, row→table, cell→row, tab→tabs,
   *  accordionsection→accordion). */
  readonly parent?: string;
  /** Agent-facing coarse summary; validation uses BLOCK_PROP_SCHEMAS. */
  readonly props?: Readonly<Record<string, BlockPropType>>;
  /** Publishes a named value into the page's reactive kit scope (mirrors
   *  `INPUT_TYPES` in packages/ui/src/blockeditor/kit/scope.ts). */
  readonly kitValue?: boolean;
  /** One-line usage hint surfaced in tool descriptions / list_block_types. */
  readonly hint?: string;
}

const CATALOGUE_LITERAL = [
  // ── Core text + structure ──────────────────────────────────────────────────
  {type: 'paragraph', category: 'core', nature: 'text', hint: 'plain rich text'},
  {type: 'heading', category: 'core', nature: 'text', props: {level: 'number'}, hint: '{level:1|2|3}'},
  {type: 'list', category: 'core', nature: 'text', props: {kind: 'string'}, hint: '{kind:"bullet"|"number"} — one block per item'},
  {type: 'todo', category: 'core', nature: 'text', props: {checked: 'boolean'}, hint: '{checked?}'},
  {type: 'quote', category: 'core', nature: 'text'},
  {type: 'callout', category: 'core', nature: 'text', props: {variant: 'string'}, hint: '{variant:"info"|"warn"|"success"}'},
  {type: 'code', category: 'core', nature: 'text', props: {language: 'string', live: 'boolean', name: 'string', collapsed: 'boolean'}, hint: '{language?,live?,name?,collapsed?}'},
  // A speaker note: editable on the page, shown only in the presenter view.
  {type: 'notes', category: 'core', nature: 'text', hint: 'speaker note — presenter view only, never exported'},
  {type: 'divider', category: 'core', nature: 'void'},
  // ── Core media leaves ──────────────────────────────────────────────────────
  {type: 'image', category: 'core', nature: 'void', props: {assetId: 'string', src: 'string', alt: 'string', caption: 'string', width: 'string'}, hint: '{assetId|src,alt?,caption?,width?} — width is a CSS length such as "60%"'},
  {type: 'htmlArtifact', category: 'core', nature: 'void', props: {assetId: 'string', title: 'string', height: 'number'}, hint: 'sandboxed HTML document {assetId,title?,height?} — height is CSS px'},
  // ── Core containers (children hold ordinary blocks) ────────────────────────
  {type: 'columns', category: 'core', nature: 'container', hint: 'side-by-side layout → column children (spans sum to 12)'},
  {type: 'column', category: 'core', nature: 'container', parent: 'columns', props: {span: 'number'}, hint: '{span:1-12}'},
  {type: 'table', category: 'core', nature: 'container', hint: 'table → row → cell; give every row the same number of cells'},
  {type: 'row', category: 'core', nature: 'container', parent: 'table', props: {header: 'boolean'}, hint: '{header?} for the header row'},
  {type: 'cell', category: 'core', nature: 'text', parent: 'row', hint: 'one table cell (rich text)'},
  {type: 'group', category: 'core', nature: 'container', props: {name: 'string', locked: 'boolean'}, hint: '{name?,locked?}'},
  {type: 'tabs', category: 'core', nature: 'container', hint: 'tabs → tab children'},
  {type: 'tab', category: 'core', nature: 'container', parent: 'tabs', props: {label: 'string'}, hint: '{label}'},
  {type: 'accordion', category: 'core', nature: 'container', props: {name: 'string', gated: 'boolean'}, hint: '{name?,gated?} → accordionsection children'},
  {type: 'accordionsection', category: 'core', nature: 'container', parent: 'accordion', props: {label: 'string', collapsed: 'boolean'}, hint: '{label,collapsed?}'},
  // ── Kit inputs (publish a named value into the reactive scope) ─────────────
  {type: 'slider', category: 'kit', nature: 'void', kitValue: true, props: {name: 'string', label: 'string', value: 'number', min: 'number', max: 'number', step: 'number'}, hint: '{name,label?,value,min,max,step?}'},
  {type: 'number', category: 'kit', nature: 'void', kitValue: true, props: {name: 'string', label: 'string', value: 'number', min: 'number', max: 'number', step: 'number'}, hint: '{name,label?,value,min?,max?,step?}'},
  {type: 'textfield', category: 'kit', nature: 'void', kitValue: true, props: {name: 'string', label: 'string', value: 'string', placeholder: 'string'}, hint: '{name,label?,value?,placeholder?}'},
  {type: 'longtext', category: 'kit', nature: 'void', kitValue: true, props: {name: 'string', label: 'string', value: 'string', placeholder: 'string'}, hint: '{name,label?,value?,placeholder?}'},
  {type: 'richtext', category: 'kit', nature: 'void', kitValue: true, props: {name: 'string', label: 'string', runs: 'array'}, hint: '{name,label?} — formatted long text'},
  {type: 'toggle', category: 'kit', nature: 'void', kitValue: true, props: {name: 'string', label: 'string', value: 'boolean'}, hint: '{name,label?,value:boolean}'},
  {type: 'radio', category: 'kit', nature: 'void', kitValue: true, props: {name: 'string', label: 'string', opts: 'array'}, hint: '{name,label?,value,opts:[{label,value}]}'},
  {type: 'dropdown', category: 'kit', nature: 'void', kitValue: true, props: {name: 'string', label: 'string', opts: 'array'}, hint: '{name,label?,value,opts:[{label,value}]}'},
  {type: 'checklist', category: 'kit', nature: 'void', kitValue: true, props: {name: 'string', label: 'string', selected: 'array', opts: 'array'}, hint: '{name,label?,selected:[],opts}'},
  {type: 'choicecards', category: 'kit', nature: 'void', kitValue: true, props: {name: 'string', label: 'string', opts: 'array', multi: 'boolean'}, hint: '{name,label?,value,opts:[{label,value,icon?}],multi?}'},
  {type: 'searchselect', category: 'kit', nature: 'void', kitValue: true, props: {name: 'string', label: 'string', opts: 'array', multi: 'boolean'}, hint: '{name,label?,value,opts,multi?}'},
  {type: 'tagfield', category: 'kit', nature: 'void', kitValue: true, props: {name: 'string', label: 'string', selected: 'array', freeEntry: 'boolean'}, hint: '{name,label?,selected:[],freeEntry?}'},
  {type: 'location', category: 'kit', nature: 'void', kitValue: true, props: {name: 'string', label: 'string'}, hint: '{name,label?}'},
  // ── Kit actions + reactive display (consume the scope via `source`) ────────
  {type: 'actionbutton', category: 'kit', nature: 'void', props: {btnlabel: 'string', action: 'string', target: 'string', amount: 'number', url: 'string'}, hint: '{btnlabel,action:"increment"|"set"|"toggle"|"link",target?,amount?,url?}'},
  {type: 'kitchart', category: 'kit', nature: 'void', props: {kind: 'string', title: 'string', labels: 'string', source: 'string'}, hint: '{kind:"line"|"area"|"bar"|"pie"|"donut"|"scatter"|"funnel",title?,labels?,source}'},
  {type: 'statuslight', category: 'kit', nature: 'void', props: {label: 'string', source: 'string', okAt: 'number', warnAt: 'number'}, hint: '{label?,source,okAt,warnAt}'},
  {type: 'progressbar', category: 'kit', nature: 'void', props: {label: 'string', source: 'string', max: 'number', format: 'string'}, hint: '{label?,source,max?,format?}'},
  {type: 'formula', category: 'kit', nature: 'void', props: {source: 'string'}, hint: '{source} — a JS expression over input names'},
  {type: 'linkcard', category: 'kit', nature: 'void', props: {title: 'string', url: 'string', description: 'string'}, hint: '{title,url,description?}'},
  {type: 'tooltipcard', category: 'kit', nature: 'void', props: {term: 'string', tip: 'string'}, hint: '{term,tip}'},
  {type: 'dbview', category: 'kit', nature: 'void', props: {pageId: 'string'}, hint: 'embedded live database view {pageId} — the page hosting the database'},
  {type: 'dbform', category: 'kit', nature: 'void', props: {databaseId: 'string', viewId: 'string'}, hint: 'embedded database form {databaseId,viewId} — a live reference, never a copied schema or capability'},
  {type: 'form', category: 'kit', nature: 'void', kitValue: false, props: {formId: 'string', submissionKey: 'string', enabled: 'boolean', databaseId: 'string', schema: 'object', label: 'string', description: 'string'}, hint: 'public form definition {formId,submissionKey,enabled,databaseId?,schema}'},
] as const satisfies readonly BlockTypeInfo[];

/** The core block `type` union — the UI's `BlockType` is THIS type, so the
 *  editor model and the catalogue cannot disagree about the core set. */
export type CoreBlockType = Extract<(typeof CATALOGUE_LITERAL)[number], {category: 'core'}>['type'];

/** The catalogue, widened to the interface type for consumers (the `as const`
 *  literal view above exists only for {@link CoreBlockType} extraction). */
export const BLOCK_TYPE_CATALOGUE: readonly BlockTypeInfo[] = CATALOGUE_LITERAL;

const byType = new Map<string, BlockTypeInfo>(BLOCK_TYPE_CATALOGUE.map((e) => [e.type, e]));

/** The catalogue entry for a type, or undefined (plugin/unknown types). */
export const blockTypeInfo = (type: string): BlockTypeInfo | undefined => byType.get(type);

/** Every catalogued (core + kit) type id. */
export const KNOWN_BLOCK_TYPE_IDS: ReadonlySet<string> = new Set(byType.keys());

/** Core types whose `children` hold ordinary blocks. */
export const CONTAINER_BLOCK_TYPES: ReadonlySet<CoreBlockType> = new Set(
  BLOCK_TYPE_CATALOGUE.filter((e) => e.nature === 'container').map((e) => e.type as CoreBlockType),
);

/** Core types that carry editable rich text. */
export const TEXT_BLOCK_TYPES: ReadonlySet<CoreBlockType> = new Set(
  BLOCK_TYPE_CATALOGUE.filter((e) => e.nature === 'text').map((e) => e.type as CoreBlockType),
);

/** Child-only types → the one container each must sit directly inside. */
export const CHILD_ONLY_PARENT: Readonly<Record<string, string>> = Object.fromEntries(
  BLOCK_TYPE_CATALOGUE.filter((e) => e.parent).map((e) => [e.type, e.parent as string]),
);

// ── Plugin block types ─────────────────────────────────────────────────────────

/**
 * Whether `type` is plugin-NAMESPACED: `<pluginId>/<blockType>` (plugins/api.ts
 * prefixes every registered plugin block with its manifest id). Pattern only —
 * says nothing about whether such a plugin is installed.
 */
export const isPluginBlockType = (type: string): boolean => /^[^\s/]+\/[^\s/]/.test(type);

/** The `<pluginId>` prefix of a plugin-namespaced type, or null. */
export const pluginIdOfBlockType = (type: string): string | null =>
  isPluginBlockType(type) ? type.slice(0, type.indexOf('/')) : null;

// ── Validation ─────────────────────────────────────────────────────────────────

/** Why {@link findUnknownBlockType} rejected a type. */
export interface UnknownBlockType {
  type: string;
  reason: 'unknown' | 'plugin-not-installed';
}

interface LooseBlock {
  type?: unknown;
  children?: unknown;
}

/**
 * The first block type (anywhere in the tree) that is neither catalogued nor an
 * acceptable plugin type, or null when every type is fine.
 *
 * Plugin types (`<pluginId>/<type>`) validate by pattern, then — when the
 * caller CAN enumerate installed plugins — by an installed-plugin lookup on the
 * id prefix. Pass `installedPluginIds: undefined` when no plugin listing is
 * available (older server, no client): pattern-valid plugin types are then
 * accepted opaquely, as the apply layer always has (never crash on them).
 */
export function findUnknownBlockType(
  blocks: readonly unknown[],
  opts: {installedPluginIds?: ReadonlySet<string>} = {},
  depth = 1,
): UnknownBlockType | null {
  for (const raw of blocks) {
    if (!raw || typeof raw !== 'object') return {type: '(not a block)', reason: 'unknown'};
    const b = raw as LooseBlock;
    const type = String(b.type ?? '');
    if (!byType.has(type)) {
      if (!isPluginBlockType(type)) return {type: type || '(missing type)', reason: 'unknown'};
      const pluginId = pluginIdOfBlockType(type) as string;
      if (opts.installedPluginIds && !opts.installedPluginIds.has(pluginId)) {
        return {type, reason: 'plugin-not-installed'};
      }
    }
    // Depth ceiling: never let a pathological payload exhaust the stack. Types
    // below this are left to {@link blockTreeError}, which rejects any payload
    // deeper than MAX_BLOCK_DEPTH anyway (callers run both checks).
    if (Array.isArray(b.children) && depth < TYPE_WALK_MAX_DEPTH) {
      const nested = findUnknownBlockType(b.children, opts, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

/** Recursion ceiling for {@link findUnknownBlockType} — generous headroom over
 *  {@link MAX_BLOCK_DEPTH}, purely a stack-exhaustion guard. */
const TYPE_WALK_MAX_DEPTH = 64;

/** A caller-facing message for an {@link UnknownBlockType}, or null. */
export function unknownBlockTypeMessage(bad: UnknownBlockType | null): string | null {
  if (!bad) return null;
  return bad.reason === 'plugin-not-installed'
    ? `Block type "${bad.type}" belongs to a plugin that is not installed in this library. Use list_block_types to see the installed plugins' blocks.`
    : `Unsupported block type "${bad.type}". Use list_block_types for the full catalogue of core, kit, and installed plugin block types.`;
}

/**
 * Max nesting depth for one write. Deep enough for every real layout —
 * `columns → column → table → row → cell → group → tabs → tab → paragraph` is
 * 9 with room to spare at 8 for the practical trees — and shallow enough that a
 * runaway/recursive model response can't build a pathological tree the editor
 * then has to render.
 */
export const MAX_BLOCK_DEPTH = 8;

/**
 * Max TOTAL blocks (all levels) in one write. A 20×8 table is 180 nodes, so
 * this fits any sane single write while bounding one request's cost; a bigger
 * document is several appends.
 */
export const MAX_BLOCK_NODES = 400;

/**
 * Validate a nested block payload's STRUCTURE against the catalogue: a
 * `children` array only on a container-nature type (anything else silently
 * drops the children at apply time), a child-only type only directly inside its
 * matching container, every `table` square (each `row` holding the same number
 * of `cell` children — a ragged table renders holes), and the depth/node caps.
 * Returns an actionable message, or null when the payload is fine.
 *
 * Block TYPES are not this function's business ({@link findUnknownBlockType}
 * covers those) — plugin/unknown leaf types walk through untouched.
 */
export function blockTreeError(
  blocks: readonly unknown[],
  opts: {maxDepth?: number; maxNodes?: number} = {},
): string | null {
  const maxDepth = opts.maxDepth ?? MAX_BLOCK_DEPTH;
  const maxNodes = opts.maxNodes ?? MAX_BLOCK_NODES;
  let count = 0;
  let deepest = 0;
  let deepestPath = '';
  let structural: string | null = null;
  const walk = (list: readonly unknown[], depth: number, path: string, parentType: string | null): void => {
    if (depth > deepest) {
      deepest = depth;
      deepestPath = path;
    }
    // Once past the cap the payload is already refused ("nested too deeply");
    // stop descending so a pathologically deep tree (tens of thousands of
    // levels) reports cleanly instead of exhausting the stack.
    if (depth > maxDepth) return;
    for (const [i, raw] of list.entries()) {
      count += 1;
      if (!raw || typeof raw !== 'object') continue; // findUnknownBlockType reports these
      const b = raw as LooseBlock;
      const type = String(b.type ?? '');
      const here = path ? `${path} > ${type}` : type;
      const children = Array.isArray(b.children) ? (b.children as unknown[]) : null;
      const hasChildren = children !== null && children.length > 0;
      if (structural === null) {
        const needs = CHILD_ONLY_PARENT[type];
        if (needs && parentType !== needs) {
          structural = parentType
            ? `A "${type}" block must be a direct child of a "${needs}" block, not a "${parentType}" block (at "${here}").`
            : `A "${type}" block can't be top-level — it belongs directly inside a "${needs}" block (at "${here}").`;
        } else if (hasChildren && !CONTAINER_BLOCK_TYPES.has(type as CoreBlockType)) {
          structural = `A "${type}" block can't hold children — only container blocks (${[...CONTAINER_BLOCK_TYPES].join(', ')}) do (at "${here}"). The nested blocks would be dropped.`;
        } else if (type === 'table' && hasChildren) {
          structural = raggedTableError(children, here);
        }
      }
      if (hasChildren) walk(children, depth + 1, `${here}[${i}]`, type);
    }
  };
  walk(blocks, 1, '', null);
  if (structural) return structural;
  if (deepest > maxDepth) {
    return `Blocks are nested too deeply: ${deepest} levels (max ${maxDepth}) at "${deepestPath}". Flatten the payload or split it across calls.`;
  }
  if (count > maxNodes) {
    return `Too many blocks in one call: ${count} (max ${maxNodes}, counting nested children). Split it into several calls.`;
  }
  return null;
}

/** Cell-count consistency for one table's rows: every `row` must hold the same
 *  number of `cell` children (the first row sets the width). Null when square. */
function raggedTableError(rows: readonly unknown[], path: string): string | null {
  let width = -1;
  for (const [i, raw] of rows.entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as LooseBlock;
    if (String(b.type ?? '') !== 'row') continue;
    const cells = (Array.isArray(b.children) ? (b.children as LooseBlock[]) : []).filter(
      (c) => c && typeof c === 'object' && String(c.type ?? '') === 'cell',
    ).length;
    if (width === -1) width = cells;
    else if (cells !== width) {
      return `Table rows must all have the same number of cells: row ${i + 1} has ${cells}, but the first row has ${width} (at "${path}"). Pad the short rows with empty cells.`;
    }
  }
  return null;
}

/**
 * Per-type prop VALUE validation for one block's props patch. Permissive but
 * typed: only props the catalogue declares for `type` (plus the common block
 * props) are checked; unknown props pass, `null` passes (it removes the key),
 * and plugin/unknown types pass entirely. Returns a message, or null.
 */
export function invalidBlockProps(type: string, props: Record<string, unknown>): string | null {
  const schema = BLOCK_PROP_SCHEMAS[type as keyof typeof BLOCK_PROP_SCHEMAS];
  if (!schema) return null; // plugin props belong to their plugin
  const parsed = schema.safeParse(props);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  const prop = issue.path.length ? String(issue.path[0]) : Object.keys(props)[0] ?? '(props)';
  return `Invalid prop "${prop}" of a "${type}" block: ${issue.message} (got ${clipJson(props[prop])}).`;
}

const clipJson = (v: unknown): string => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
};

// ── Presentation (list_block_types + tool descriptions) ────────────────────────

/** The manifest-declared blocks of an installed plugin, as the catalogue
 *  listing consumes them (a structural subset of the SDK's `StoredPlugin`). */
export interface PluginBlockSource {
  manifest: {id: string; name?: string; blocks?: ReadonlyArray<{type: string; description?: string}>};
  enabled?: boolean;
}

/**
 * The full catalogue as `list_block_types` text: every core + kit entry, then
 * one `plugin` entry per block each installed plugin DECLARES in its manifest
 * (`PluginManifest.blocks`). Pass the installed plugins where a listing is
 * available; omit it and the plugin section says so instead of guessing.
 */
export function blockCatalogueText(plugins?: readonly PluginBlockSource[], types?: readonly string[]): string {
  const wanted = types ? new Set(types) : null;
  const blocks = BLOCK_TYPE_CATALOGUE.filter((e) => !wanted || wanted.has(e.type)).map((e) => ({
    type: e.type, category: e.category, nature: e.nature,
    ...(e.parent ? {parent: e.parent} : {}), ...(e.kitValue ? {kitValue: true} : {}),
    description: e.hint ?? `${e.type} ${e.nature} block.`,
    propsSchema: BLOCK_PROP_JSON_SCHEMAS[e.type as keyof typeof BLOCK_PROP_JSON_SCHEMAS] as BlockPropsJsonSchema,
  }));
  const pluginBlocks = plugins?.flatMap((p) => (p.manifest.blocks ?? []).map((b) => ({
    type: `${p.manifest.id}/${b.type}`, category: 'plugin', nature: 'void',
    description: b.description ?? `${p.manifest.name ?? p.manifest.id} plugin block.`,
    propsSchema: {type: 'object', properties: {}, additionalProperties: true}, enabled: p.enabled !== false,
  })).filter((b) => !wanted || wanted.has(b.type))) ?? null;
  return JSON.stringify({blocks, pluginBlocks, pluginListingAvailable: plugins !== undefined});
}

/**
 * The `add_blocks` tool description, generated from the catalogue so the type
 * list in the model's guidance can never drift from what validation accepts
 * (this replaces the old hand-written BLOCK_CATALOGUE prose in the agent).
 */
export function addBlocksGuidance(): string {
  const hinted = (e: BlockTypeInfo): string => (e.hint ? `${e.type} ${e.hint}` : e.type);
  const core = BLOCK_TYPE_CATALOGUE.filter((e) => e.category === 'core');
  const kit = BLOCK_TYPE_CATALOGUE.filter((e) => e.category === 'kit');
  return [
    'Append rich blocks to a page — text, layouts, tables, media, interactive inputs, and charts. User approves before they are added.',
    'Each block is {type, text?, props?, children?}. `text` is a plain string (or rich runs [{"t","a":{b,i,u,s,c,a}}]); `children` nests blocks inside containers. Call list_block_types for the full catalogue including installed plugin blocks.',
    `TEXT: ${core.filter((e) => e.nature === 'text' && !e.parent).map(hinted).join('; ')}.`,
    `CONTAINERS (use children): ${core.filter((e) => e.nature === 'container' || e.parent).map(hinted).join('; ')}. Give every table row the same number of cells.`,
    `MEDIA/OTHER: ${core.filter((e) => e.nature === 'void').map(hinted).join('; ')}.`,
    `INPUTS (each publishes props.name into the reactive scope): ${kit.filter((e) => e.kitValue).map(hinted).join('; ')}.`,
    `REACTIVE DISPLAY/ACTIONS (props.source is a JS expression over input names): ${kit.filter((e) => !e.kitValue).map(hinted).join('; ')}.`,
    'Example: a budget widget → [{"type":"heading","text":"Budget","props":{"level":2}},{"type":"columns","children":[{"type":"column","props":{"span":5},"children":[{"type":"slider","props":{"name":"spent","label":"Spent","value":80,"min":0,"max":200}},{"type":"number","props":{"name":"budget","label":"Budget","value":120}}]},{"type":"column","props":{"span":7},"children":[{"type":"kitchart","props":{"kind":"bar","title":"Spent vs budget","labels":"Spent, Budget","source":"[spent, budget]"}},{"type":"statuslight","props":{"label":"On track","source":"budget - spent","okAt":0,"warnAt":-20}}]}]}].',
  ].join('\n');
}
