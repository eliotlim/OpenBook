import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {
  appendBlocksToSnapshot,
  appendTextToSnapshot,
  applyTableOpToSnapshot,
  projectAppendBlocks,
  resolveTableOp,
  snapshotTableIdFor,
  snapshotTableView,
  snapshotTables,
  snapshotText,
  tableOpError,
  tableOpRemovesTable,
  tableShapeOf,
  textSnapshot,
  type AgentEditsMode,
  type DataClient,
  type PageSnapshot,
  type SnapshotTableView,
  type StoredSuggestion,
  type SuggestionKind,
  type SuggestionTarget,
  type TableOpAddress,
  type TableOpKind,
} from '@book.dev/sdk';

// ── Read helpers over the JSON projection (shared shape with the in-app agent) ─

interface AnyJsonBlock {
  id?: string;
  type?: string;
  text?: Array<{t: string}>;
  props?: Record<string, unknown>;
  children?: AnyJsonBlock[];
}

const runText = (b: AnyJsonBlock): string => (Array.isArray(b.text) ? b.text.map((r) => r.t).join('') : '');

function blockdocBlocks(data: PageSnapshot | null | undefined): AnyJsonBlock[] | null {
  if (!data || data.editor !== 'blocks') return null;
  const bd = data.blockdoc as {blocks?: AnyJsonBlock[]} | undefined;
  return bd?.blocks ?? [];
}

function blockTreeLines(data: PageSnapshot | null | undefined): string[] {
  const out: string[] = [];
  const blocks = blockdocBlocks(data);
  if (blocks) {
    const walk = (list: AnyJsonBlock[], depth: number): void => {
      for (const b of list) {
        const text = runText(b).slice(0, 60);
        const props = b.props && Object.keys(b.props).length ? ` props=${JSON.stringify(b.props).slice(0, 120)}` : '';
        out.push(`${'  '.repeat(depth)}- [${b.id ?? '?'}] ${b.type ?? '?'}${text ? `: ${text}` : ''}${props}`);
        if (b.children) walk(b.children, depth + 1);
      }
    };
    walk(blocks, 0);
    return out;
  }
  const ejs = (data?.editorjs as {blocks?: Array<{id?: string; type?: string; data?: {text?: unknown}}>} | undefined)?.blocks ?? [];
  for (const b of ejs) {
    const t = typeof b.data?.text === 'string' ? String(b.data.text).replace(/<[^>]+>/g, '').slice(0, 60) : '';
    out.push(`- [${b.id ?? '?'}] ${b.type ?? '?'}${t ? `: ${t}` : ''}`);
  }
  return out;
}

const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const INPUT_TYPES = new Set(['slider', 'number', 'textfield', 'radio', 'checklist', 'dropdown', 'location', 'toggle']);

function varNameFromLabel(label: string): string {
  const cleaned = label.trim().replace(/[^A-Za-z0-9]+(.)?/g, (_, c?: string) => (c ? c.toUpperCase() : ''));
  const name = cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
  return NAME_RE.test(name) ? name : '';
}

function publishedName(b: AnyJsonBlock): string {
  const explicit = String(b.props?.name ?? '').trim();
  if (explicit) return NAME_RE.test(explicit) ? explicit : '';
  return varNameFromLabel(String(b.props?.label ?? ''));
}

function inputValueOf(b: AnyJsonBlock): unknown {
  const p = b.props ?? {};
  switch (b.type) {
  case 'slider':
  case 'number':
    return Number(p.value ?? 0);
  case 'textfield':
    return String(p.value ?? '');
  case 'radio':
  case 'dropdown':
    return p.value ?? null;
  case 'checklist':
    return Array.isArray(p.selected) ? p.selected : [];
  case 'toggle':
    return Boolean(p.value ?? false);
  default:
    return undefined;
  }
}

function kitValues(data: PageSnapshot | null | undefined): Record<string, unknown> {
  const blocks = blockdocBlocks(data);
  if (!blocks) return {};
  const scope: Record<string, unknown> = {};
  const walk = (list: AnyJsonBlock[]): void => {
    for (const b of list) {
      if (b.type && INPUT_TYPES.has(b.type)) {
        const name = publishedName(b);
        if (name && !(name in scope)) scope[name] = inputValueOf(b);
      }
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  return scope;
}

/**
 * Set a named kit input's value in the JSON projection (block-editor pages).
 * Clears the stale CRDT `update` so the page rebuilds from the projection on
 * next load. Returns the new snapshot, or null when the input isn't found.
 */
function setKitValueInSnapshot(data: PageSnapshot, name: string, value: unknown): PageSnapshot | null {
  const blocks = blockdocBlocks(data);
  if (!blocks) return null;
  let applied = false;
  const walk = (list: AnyJsonBlock[]): void => {
    for (const b of list) {
      if (!applied && b.type && INPUT_TYPES.has(b.type) && publishedName(b) === name) {
        b.props = b.props ?? {};
        if (b.type === 'checklist') b.props.selected = Array.isArray(value) ? value : [];
        else b.props.value = value;
        applied = true;
      }
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  if (!applied) return null;
  const bd = data.blockdoc as {blocks?: unknown[]; update?: string; v?: number};
  return {...data, blockdoc: {...bd, update: undefined, blocks}};
}

/** Read one block's plain text from the JSON projection. Returns null if absent. */
function blockTextInSnapshot(data: PageSnapshot | null | undefined, blockId: string): string | null {
  const blocks = blockdocBlocks(data);
  if (!blocks) return null;
  let found: string | null = null;
  const walk = (list: AnyJsonBlock[]): void => {
    for (const b of list) {
      if (found === null && b.id === blockId) found = runText(b);
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  return found;
}

/** Replace one block's text in the JSON projection. Returns null if absent. */
function setBlockTextInSnapshot(data: PageSnapshot, blockId: string, text: string): PageSnapshot | null {
  const blocks = blockdocBlocks(data);
  if (!blocks) return null;
  let applied = false;
  const walk = (list: AnyJsonBlock[]): void => {
    for (const b of list) {
      if (!applied && b.id === blockId) {
        b.text = [{t: text}];
        applied = true;
      }
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  if (!applied) return null;
  const bd = data.blockdoc as {blocks?: unknown[]; update?: string; v?: number};
  return {...data, blockdoc: {...bd, update: undefined, blocks}};
}

/** One block's `{type, props}` from the JSON projection, at ANY depth. Null if absent. */
function blockInfoInSnapshot(
  data: PageSnapshot | null | undefined,
  blockId: string,
): {type: string; props: Record<string, unknown>} | null {
  const blocks = blockdocBlocks(data);
  if (!blocks) return null;
  let found: {type: string; props: Record<string, unknown>} | null = null;
  const walk = (list: AnyJsonBlock[]): void => {
    for (const b of list) {
      if (found === null && b.id === blockId) found = {type: b.type ?? 'paragraph', props: {...(b.props ?? {})}};
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  return found;
}

/**
 * Remove one block (with its whole subtree) from the JSON projection, at ANY
 * depth — a nested block, a table `row`, or a `cell` is as removable as a
 * top-level paragraph, because the model is uniformly recursive. Returns null
 * when the id isn't on the page.
 */
function deleteBlockInSnapshot(data: PageSnapshot, blockId: string): PageSnapshot | null {
  const blocks = blockdocBlocks(data);
  if (!blocks) return null;
  let applied = false;
  const prune = (list: AnyJsonBlock[]): void => {
    const at = list.findIndex((b) => b.id === blockId);
    if (at >= 0) {
      list.splice(at, 1);
      applied = true;
      return;
    }
    for (const b of list) {
      if (!applied && b.children) prune(b.children);
    }
  };
  prune(blocks);
  if (!applied) return null;
  const bd = data.blockdoc as {blocks?: unknown[]; update?: string; v?: number};
  return {...data, blockdoc: {...bd, update: undefined, blocks}};
}

/**
 * SHALLOW-MERGE props onto one block in the JSON projection, at ANY depth. An
 * explicit `null` REMOVES the key (JSON can't carry `undefined`, so `null` is the
 * only wire-level way to say "delete this prop"; `patchBlock` in the editor's
 * model applies the same rule, so a direct write and an accepted suggestion land
 * identically). Returns the new snapshot plus the merged props, or null when the
 * id isn't on the page.
 */
function setBlockPropsInSnapshot(
  data: PageSnapshot,
  blockId: string,
  props: Record<string, unknown>,
): {data: PageSnapshot; props: Record<string, unknown>} | null {
  const blocks = blockdocBlocks(data);
  if (!blocks) return null;
  let merged: Record<string, unknown> | null = null;
  const walk = (list: AnyJsonBlock[]): void => {
    for (const b of list) {
      if (merged === null && b.id === blockId) {
        const next = {...(b.props ?? {})};
        for (const [k, v] of Object.entries(props)) {
          if (v === null) delete next[k];
          else next[k] = v;
        }
        b.props = next;
        merged = next;
      }
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  if (merged === null) return null;
  const bd = data.blockdoc as {blocks?: unknown[]; update?: string; v?: number};
  return {data: {...data, blockdoc: {...bd, update: undefined, blocks}}, props: merged};
}

/**
 * The OpenBook MCP server: exposes a library to any MCP client (Claude
 * Desktop, Claude Code, …) as a set of tools over the same `@book.dev/sdk`
 * contract the apps use. Read tools degrade gracefully (search is lexical
 * BM25 even with the AI engine off). Write tools that MUTATE existing content
 * are governed by the library's AGENT-EDITS POLICY (AGED-3), resolved PER WRITE
 * from the SERVER-RESOLVED effective mode on the PAT-readable per-page route
 * (AGED-6 — the page's `agentEdits` override already resolved against the
 * instance-wide default): only a resolved `'direct'` applies the change
 * immediately; anything else persists a REVIEWABLE SUGGESTION — routed through
 * the same review layer (StoredSuggestion) as the in-app agent, so nothing an
 * MCP client writes lands until a human accepts it. The safe default is
 * `suggest`; the mode fetch failing (offline / a pre-AGED-6 server) fails safe
 * to `suggest`. The server is the AUTHORITATIVE backstop — it 403s a direct
 * write the policy forbids regardless of what the tool layer resolved. Creating
 * new pages/rows stays immediate (non-destructive).
 */

const clip = (s: string, n = 4000): string => (s.length > n ? `${s.slice(0, n)}…` : s);

const text = (value: string) => ({content: [{type: 'text' as const, text: value}]});
const failure = (value: string) => ({content: [{type: 'text' as const, text: value}], isError: true});

// ── Nested block payloads (API-1) ─────────────────────────────────────────────
// The document model is ONE recursive shape — a container block (`columns` →
// `column`, `table` → `row` → `cell`, `group`, `tabs` → `tab`, `accordion` →
// `accordionsection`) holds ordinary blocks in `children`, to any depth. The
// tool schemas below mirror that with a `z.lazy` self-reference, so an MCP client
// can build a table or a two-column layout in ONE call. The apply layer is
// already recursive and type-agnostic (`coerceNewBlock`/`makeBlock`), so nothing
// downstream needs a per-type case.

/** A block a client may send to `append_blocks` / `create_artifact_page`. */
export interface NestedBlockInput {
  type: string;
  text?: string;
  props?: Record<string, unknown>;
  children?: NestedBlockInput[];
}

/**
 * Max nesting depth of one payload (top-level blocks are depth 1). Deep enough
 * for every real layout — `columns → column → table → row → cell → group →
 * paragraph` is 7 — and shallow enough that a runaway/recursive model response
 * can't build a pathological tree the editor then has to render. Rejected with a
 * message naming the offending path, not silently truncated.
 */
const MAX_BLOCK_DEPTH = 8;

/**
 * Max TOTAL blocks (all levels) in one call. A 20×8 table is 180 nodes, so this
 * fits any sane single write while bounding one request's cost; a bigger document
 * is several appends. Counted over the whole tree, not per level.
 */
const MAX_BLOCK_NODES = 400;

/** Text description shared by both block schemas. */
const BLOCK_TEXT_DESC = 'Text content (paragraph/heading/todo/quote/callout/code/list, and a table `cell`).';

/** Children description shared by both block schemas. */
const BLOCK_CHILDREN_DESC =
  'Nested blocks — ONLY for container types: columns→column, table→row→cell, group, tabs→tab, accordion→accordionsection. ' +
  `Nest to at most ${MAX_BLOCK_DEPTH} levels, ${MAX_BLOCK_NODES} blocks total per call.`;

/** A recursive block schema: `children` refers back to itself via `z.lazy`. */
function nestedBlockSchema(typeDesc: string, propsDesc: string): z.ZodType<NestedBlockInput> {
  const schema: z.ZodType<NestedBlockInput> = z.lazy(() =>
    z.object({
      type: z.string().describe(typeDesc),
      text: z.string().optional().describe(BLOCK_TEXT_DESC),
      props: z.record(z.unknown()).optional().describe(propsDesc),
      children: z.array(schema).optional().describe(BLOCK_CHILDREN_DESC),
    }),
  );
  return schema;
}

/**
 * Validate a nested payload against {@link MAX_BLOCK_DEPTH} / {@link MAX_BLOCK_NODES}.
 * Returns an error message for the client, or null when the payload is fine.
 * (Structural limits only — block TYPES stay unvalidated here so the type-agnostic
 * apply layer keeps accepting custom/plugin blocks.)
 */
function blockPayloadError(blocks: NestedBlockInput[]): string | null {
  let count = 0;
  let deepest = 0;
  let deepestPath = '';
  const walk = (list: NestedBlockInput[], depth: number, path: string): void => {
    if (depth > deepest) {
      deepest = depth;
      deepestPath = path;
    }
    for (const [i, b] of list.entries()) {
      count += 1;
      const here = path ? `${path} > ${b.type}` : b.type;
      if (b.children && b.children.length > 0) walk(b.children, depth + 1, `${here}[${i}]`);
    }
  };
  walk(blocks, 1, '');
  if (deepest > MAX_BLOCK_DEPTH) {
    return `Blocks are nested too deeply: ${deepest} levels (max ${MAX_BLOCK_DEPTH}) at "${deepestPath}". Flatten the payload or split it across calls.`;
  }
  if (count > MAX_BLOCK_NODES) {
    return `Too many blocks in one call: ${count} (max ${MAX_BLOCK_NODES}, counting nested children). Split it into several append_blocks calls.`;
  }
  return null;
}

/** Every block type in a payload, all levels (for the artifact type gate). */
function blockTypesIn(blocks: NestedBlockInput[], out: string[] = []): string[] {
  for (const b of blocks) {
    out.push(b.type);
    if (b.children) blockTypesIn(b.children, out);
  }
  return out;
}

/**
 * The write-tool kind an MCP mutation maps to (the same identifiers the in-app
 * agent's proposals use, carried into the suggestion payload as `applyKind` so
 * the editor bridge replays an MCP-authored suggestion exactly like an
 * agent-authored one — hence `set_block_props` for the `update_block_props` tool:
 * the identifier is the BRIDGE's, not the tool's). The SDK suggestion `kind` each
 * maps to mirrors `SUGGESTION_KIND` in packages/server/src/ai/agent.ts.
 */
type McpWriteKind = 'append_blocks' | 'update_block' | 'set_kit_value' | 'set_db_cell' | 'delete_block' | 'set_block_props' | TableOpKind;

const MCP_SUGGESTION_KIND: Record<McpWriteKind, SuggestionKind> = {
  append_blocks: 'insert',
  update_block: 'replace-text',
  set_kit_value: 'replace-text',
  set_db_cell: 'set-cell',
  delete_block: 'delete',
  set_block_props: 'replace-text',
  // API-3: every table STRUCTURE op reviews as one `table-op` kind; the
  // `payload.applyKind` (the tool name, which is also the bridge's proposal kind)
  // says which op to replay.
  table_insert_row: 'table-op',
  table_delete_row: 'table-op',
  table_duplicate_row: 'table-op',
  table_insert_column: 'table-op',
  table_delete_column: 'table-op',
  table_move_row: 'table-op',
  table_move_column: 'table-op',
  table_set_cell: 'table-op',
  table_set_row_color: 'table-op',
  table_set_column_color: 'table-op',
};

/**
 * Display author for suggestions an MCP client proposes. `authorKind` is `ai`
 * (a machine-generated proposal a human reviews) — this label lets the reviewer
 * see the change originated from an external MCP client rather than the in-app
 * assistant.
 */
const MCP_AUTHOR_NAME = 'MCP client';

/**
 * The read accessor the per-write agent-edits resolution needs beyond the base
 * {@link DataClient}. An MCP server always runs against an `HttpDataClient`, which
 * has it — so this is a structural widening, not a new implementation burden.
 *
 * AGED-6: resolution reads ONLY `getEffectiveAgentEdits` — the SERVER-RESOLVED
 * effective mode on the PAT-readable per-page route (`GET /api/pages/:id/agent-edits`,
 * `.effective`). It no longer needs the privileged `GET /api/instance` read (which the
 * AGENT-6 scope-gate denies to a PAT), so the instance-wide `direct` default now
 * governs an `inherit` page over remote MCP too. The server write-gate (AGED-2)
 * remains the authoritative backstop for a forbidden direct write.
 */
type PolicyClient = DataClient & {
  /** A page's server-resolved effective agent-edits mode (`inherit` already resolved
   *  against the instance default), AGED-6. */
  getEffectiveAgentEdits(pageId: string): Promise<AgentEditsMode>;
};

/** Configuration for the MCP server. */
export interface OpenBookMcpOptions {
  /** Server version reported in the MCP handshake. */
  version?: string;
  /**
   * @deprecated AGED-3 retired this flag: the direct-vs-suggest decision is now
   * resolved PER WRITE from the library's agent-edits policy (the page's
   * `agentEdits` override + the instance mode), NOT a static server flag. This
   * field is accepted for source compatibility but IGNORED — remove it. The
   * server remains the authoritative backstop for a forbidden direct write.
   */
  allowDirectEdits?: boolean;
}

export function createOpenBookMcpServer(client: PolicyClient, options: OpenBookMcpOptions = {}): McpServer {
  const {version = '0.1.0'} = options;
  const server = new McpServer({name: 'openbook', version});

  /**
   * The effective agent-edits mode for a write to `pageId`, read FRESH per write from
   * the SERVER-RESOLVED effective mode on the PAT-readable per-page route (AGED-6) —
   * so a per-page override AND the instance-wide default both take effect immediately,
   * without the privileged instance read. FAIL-SAFE: if the mode can't be read
   * (offline / a pre-AGED-6 server that omits `effective`) return `'suggest'` — never
   * direct. Callers treat ONLY an exact `'direct'` as direct (Sasha, AGED-1 review);
   * the server write-gate backstops a forbidden direct write regardless.
   */
  const resolveWritePolicy = async (pageId: string): Promise<AgentEditsMode> => {
    try {
      const effective = await client.getEffectiveAgentEdits(pageId);
      return effective === 'direct' ? 'direct' : 'suggest';
    } catch {
      return 'suggest';
    }
  };

  /**
   * Persist a content mutation as a reviewable SUGGESTION (default) instead of
   * applying it. The `kind`/`target`/`before`/`after`/`payload` mirror the
   * in-app agent's `enqueue` (packages/server/src/ai/agent.ts) so both produce
   * the same `StoredSuggestion` and share the accept/apply bridge. Returns the
   * stored suggestion.
   */
  const recordSuggestion = (input: {
    kind: McpWriteKind;
    pageId: string;
    summary: string;
    before?: string;
    after?: string;
    target: SuggestionTarget;
    payload: Record<string, unknown>;
  }): Promise<StoredSuggestion> =>
    client.createSuggestion({
      pageId: input.pageId,
      authorKind: 'ai',
      authorName: MCP_AUTHOR_NAME,
      kind: MCP_SUGGESTION_KIND[input.kind],
      target: input.target,
      before: input.before ?? '',
      after: input.after ?? '',
      payload: {...input.payload, applyKind: input.kind, summary: input.summary},
    });

  /** The tool result a queued (not applied) suggestion returns to the client. */
  const suggested = (summary: string, s: StoredSuggestion) =>
    text(`Suggested for review (not applied): ${summary}. It is queued in the review pane (suggestion ${s.id}); a human must accept it before it changes the library.`);

  server.registerTool(
    'list_pages',
    {
      title: 'List pages',
      description: 'List library pages (id and title), most recently updated first.',
      inputSchema: {},
    },
    async () => {
      const pages = await client.listPages();
      if (pages.length === 0) return text('The library has no pages yet.');
      return text(pages.map((p) => `- [${p.id}] ${p.name ?? 'Untitled'}`).join('\n'));
    },
  );

  server.registerTool(
    'read_page',
    {
      title: 'Read a page',
      description: 'Read the full text of one page by id.',
      inputSchema: {pageId: z.string().describe('The page id (from list_pages or search_notes).')},
    },
    async ({pageId}) => {
      const page = await client.getPage(pageId);
      if (!page) return failure('Page not found.');
      return text(`Title: ${page.name ?? 'Untitled'}\n\n${clip(snapshotText(page.data) || '(empty page)')}`);
    },
  );

  server.registerTool(
    'search_notes',
    {
      title: 'Search notes',
      description:
        'Search every note/page in the library; returns ranked matches with snippets. Works without an AI model (keyword ranking) and upgrades to semantic ranking when the server has one.',
      inputSchema: {
        query: z.string().describe('What to look for.'),
        limit: z.number().int().min(1).max(25).optional().describe('Max results (default 8).'),
      },
    },
    async ({query, limit}) => {
      const res = await client.aiSearch(query, limit ?? 8);
      if (res.results.length === 0) return text('No matching notes.');
      return text(res.results.map((r) => `- [${r.pageId}] ${r.title}: ${r.snippet}`).join('\n'));
    },
  );

  server.registerTool(
    'create_page',
    {
      title: 'Create a page',
      description: 'Create a new page with a title and optional text content (one paragraph per line). Creating a page is non-destructive, so it is applied immediately (edits to EXISTING content are proposed as reviewable suggestions instead).',
      inputSchema: {
        title: z.string().describe('The page title — a display label; it need not be unique (pages are identified by id).'),
        content: z.string().optional().describe('Plain-text body; each line becomes a paragraph.'),
      },
    },
    async ({title, content}) => {
      const name = title.trim();
      if (!name) return failure('A title is required.');
      try {
        const page = await client.savePage({name, data: textSnapshot(content ?? '', 'mcp')});
        return text(`Created page "${name}" with id ${page.id}.`);
      } catch (err) {
        return failure(`Could not create the page: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // The block types an artifact page may contain, with loose prop schemas —
  // unknown props pass through (the editor ignores what it doesn't know),
  // unknown TYPES are rejected so a typo'd artifact can't render as a wall
  // of "Unsupported block" placeholders. Container + table types are in the set
  // so an artifact can be LAID OUT (columns/group/tabs/accordion) and hold a
  // table; the gate runs over EVERY level of the payload, not just the top.
  const ARTIFACT_TYPES = new Set([
    'heading', 'paragraph', 'todo', 'quote', 'callout', 'divider', 'code', 'list',
    'slider', 'formula', 'number', 'textfield', 'radio', 'checklist', 'toggle',
    'location', 'actionbutton', 'kitchart', 'statuslight', 'tooltipcard', 'linkcard',
    'columns', 'column', 'table', 'row', 'cell', 'group',
    'tabs', 'tab', 'accordion', 'accordionsection',
  ]);

  const artifactBlock = nestedBlockSchema(
    'Block type, e.g. heading | paragraph | number | slider | radio | checklist | toggle | kitchart | statuslight | actionbutton | formula | linkcard | tooltipcard | location | textfield — or a container: columns | column | table | row | cell | group | tabs | tab | accordion | accordionsection',
    'Block props. Inputs publish {name} into a shared scope: number {name,value,min,max,step}; slider {name,value,min,max}; radio/checklist {name,options:"A, B",value|selected}; toggle {name,value}. ' +
      'Consumers evaluate expressions over the scope: kitchart {kind:line|area|bar|pie|donut|scatter|funnel, source:"[n, n*2]", title, labels}; statuslight {label, source, okAt, warnAt}; formula {source}. ' +
      'actionbutton {btnlabel, action:increment|set|toggle|link, target, amount, url}; linkcard {title, description, url}; tooltipcard {term, tip}; heading {level}. ' +
      'Layout: column {span} (12-unit grid); table row {header:true} for the header row.',
  );

  server.registerTool(
    'create_artifact_page',
    {
      title: 'Create an artifact page',
      description:
        'Create an interactive page from blocks: named inputs (number stepper, slider, radio, checklist, toggle, text field) publish values onto a shared scope, and live blocks compute over it (kitchart, statuslight, formula — JavaScript expressions over the input names). Use this to BUILD calculators, dashboards, and pickers instead of writing HTML. Blocks NEST via `children`, so the page can be laid out in columns/tabs/groups and hold tables (table → row → cell). Creating a page is non-destructive, so it is applied immediately.',
      inputSchema: {
        title: z.string().describe('The page title — a display label; it need not be unique (pages are identified by id).'),
        blocks: z.array(artifactBlock).min(1).describe('The page content, top to bottom. Containers carry their contents in `children`.'),
      },
    },
    async ({title, blocks}) => {
      const name = title.trim();
      if (!name) return failure('A title is required.');
      const limit = blockPayloadError(blocks);
      if (limit) return failure(limit);
      // The type gate runs over EVERY level — a typo'd nested type would otherwise
      // render as an "Unsupported block" placeholder inside an otherwise fine page.
      const bad = blockTypesIn(blocks).find((t) => !ARTIFACT_TYPES.has(t));
      if (bad) return failure(`Unknown block type "${bad}". Use one of: ${[...ARTIFACT_TYPES].join(', ')}.`);
      // Recursive projection (children preserved, text→runs at every level) — the
      // same helper `append_blocks` uses, so the two paths can never drift.
      const projected = projectAppendBlocks(blocks, 'mcp');
      try {
        const page = await client.savePage({
          name,
          data: {editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: {blocks: projected}},
        });
        return text(`Created artifact page "${name}" with id ${page.id} (${blocks.length} blocks).`);
      } catch (err) {
        return failure(`Could not create the page: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerTool(
    'append_to_page',
    {
      title: 'Append to a page',
      description:
        'Append text to the end of an existing page (one paragraph per line). Whether this applies directly or is queued as a REVIEWABLE SUGGESTION is decided per write by the library/page agent-edits policy (default: suggest — nothing lands until a human accepts it in the review pane).',
      inputSchema: {
        pageId: z.string().describe('The page id.'),
        content: z.string().describe('Plain-text to append; each line becomes a paragraph.'),
      },
    },
    async ({pageId, content}) => {
      const page = await client.getPage(pageId);
      if (!page) return failure('Page not found.');
      const paragraphs = content.split('\n').map((l) => l.trim()).filter(Boolean);
      if (paragraphs.length === 0) return failure('Nothing to append.');
      if ((await resolveWritePolicy(pageId)) !== 'direct') {
        const blocks = paragraphs.map((t) => ({type: 'paragraph', text: t}));
        const summary = `Append ${paragraphs.length} paragraph(s) to "${page.name ?? 'Untitled'}"`;
        const s = await recordSuggestion({kind: 'append_blocks', pageId, summary, after: clip(content, 200), target: {}, payload: {pageId, blocks}});
        return suggested(summary, s);
      }
      const data = appendTextToSnapshot(page.data, content, `mcp-${Date.now().toString(36)}`);
      if (data === page.data) return failure('Nothing to append.');
      try {
        await client.savePage({id: page.id, name: page.name, data});
      } catch (err) {
        return failure(`Could not append (the server declined the direct write): ${err instanceof Error ? err.message : String(err)}`);
      }
      return text(`Appended directly to "${page.name ?? 'Untitled'}".`);
    },
  );

  server.registerTool(
    'list_database_rows',
    {
      title: 'List database rows',
      description: 'List the rows of the database hosted on a page (each row’s id, title, and properties).',
      inputSchema: {pageId: z.string().describe('The id of the page that hosts the database.')},
    },
    async ({pageId}) => {
      const database = await client.getPageDatabase(pageId);
      if (!database) return failure('That page hosts no database.');
      const rows = await client.listRows(database.id);
      if (rows.length === 0) return text(`Database "${database.name ?? 'Untitled'}" has no rows.`);
      const lines = rows.map((r) => `- [${r.id}] ${r.name ?? 'Untitled'} ${JSON.stringify(r.properties ?? {})}`);
      return text(`Database "${database.name ?? 'Untitled'}" (${database.id}):\n${lines.join('\n')}`);
    },
  );

  server.registerTool(
    'create_database_row',
    {
      title: 'Create a database row',
      description: 'Add a row to the database hosted on a page, optionally with a title and property values. Adding a row is applied immediately (creation is non-destructive); editing an EXISTING cell via set_db_cell is proposed as a reviewable suggestion instead.',
      inputSchema: {
        pageId: z.string().describe('The id of the page that hosts the database.'),
        name: z.string().optional().describe('The row title.'),
        properties: z.record(z.unknown()).optional().describe('Property values keyed by property id.'),
      },
    },
    async ({pageId, name, properties}) => {
      const database = await client.getPageDatabase(pageId);
      if (!database) return failure('That page hosts no database.');
      const row = await client.createRow(database.id, {name: name ?? null, properties});
      return text(`Created row "${row.name ?? 'Untitled'}" with id ${row.id} in database "${database.name ?? 'Untitled'}".`);
    },
  );

  // ── Inspection (block tree + kit values) ─────────────────────────────────────

  server.registerTool(
    'inspect_page_structure',
    {
      title: 'Inspect page structure',
      description: 'Show a page\'s BLOCK TREE (block ids, types, short text, props) — not just its flat text. Use before editing blocks or kit values.',
      inputSchema: {pageId: z.string().describe('The page id.')},
    },
    async ({pageId}) => {
      const page = await client.getPage(pageId);
      if (!page) return failure('Page not found.');
      const lines = blockTreeLines(page.data);
      return text(lines.length ? lines.join('\n') : '(empty document)');
    },
  );

  server.registerTool(
    'get_kit_values',
    {
      title: 'Get kit values',
      description: 'Read the named reactive input values (the inputScope) a page\'s artifact-kit blocks publish.',
      inputSchema: {pageId: z.string().describe('The page id.')},
    },
    async ({pageId}) => {
      const page = await client.getPage(pageId);
      if (!page) return failure('Page not found.');
      const scope = kitValues(page.data);
      const keys = Object.keys(scope);
      if (keys.length === 0) return text('This page publishes no named kit values.');
      return text(keys.map((k) => `- ${k} = ${JSON.stringify(scope[k])}`).join('\n'));
    },
  );

  server.registerTool(
    'list_db_views',
    {
      title: 'List database views',
      description: 'List the views of the database hosted on a page (id, name, type, group-by property).',
      inputSchema: {pageId: z.string().describe('The page hosting the database.')},
    },
    async ({pageId}) => {
      const database = await client.getPageDatabase(pageId);
      if (!database) return failure('That page hosts no database.');
      const views = database.schema.views ?? [];
      if (views.length === 0) return text(`Database "${database.name ?? 'Untitled'}" has no views.`);
      return text(
        views
          .map((v) => `- [${v.id}] ${v.name} (${v.type}${v.groupByPropertyId ? `, grouped by ${v.groupByPropertyId}` : ''})`)
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'get_db_row',
    {
      title: 'Get a database row',
      description: 'Read one database row by id: its title, manual property values, and exported reactive cell values.',
      inputSchema: {
        pageId: z.string().describe('The page hosting the database.'),
        rowId: z.string().describe('The row (page) id.'),
      },
    },
    async ({pageId, rowId}) => {
      const database = await client.getPageDatabase(pageId);
      if (!database) return failure('That page hosts no database.');
      const rows = await client.listRows(database.id);
      const row = rows.find((r) => r.id === rowId);
      if (!row) return failure('Row not found in this database.');
      return text(
        [`Title: ${row.name ?? 'Untitled'}`, `Properties: ${JSON.stringify(row.properties)}`, `Exports: ${JSON.stringify(row.exports)}`].join('\n'),
      );
    },
  );

  // ── Writes ───────────────────────────────────────────────────────────────────
  // These tools MUTATE existing page/database content. Each resolves the library's
  // AGENT-EDITS POLICY PER WRITE (AGED-3, `resolveWritePolicy`): only a resolved
  // `'direct'` applies the change immediately; anything else — the safe default, an
  // explicit page/instance `suggest`, or a failed/absent policy fetch — persists a
  // reviewable SUGGESTION (StoredSuggestion) through the same review layer the in-app
  // agent uses (packages/server/src/ai/agent.ts), with matching kind/target/payload,
  // so nothing an MCP client writes lands until a human accepts it. The server is the
  // authoritative backstop: a direct write the policy forbids is 403'd there even if
  // the local resolution said direct (the tool surfaces that steer, it never fights
  // it). Pure CREATION tools above (create_page, create_artifact_page,
  // create_database_row) stay immediate — they add new, non-destructive content and
  // the review model has no target page / suggestion kind for a not-yet-existing
  // page, matching the agent's "creation applies immediately" rule.

  // `append_blocks` accepts ANY block type (including plugin/custom ones): the apply
  // layer is type-agnostic, and a type gate here would reject blocks the editor can
  // render perfectly well. Structure (depth/size) IS bounded — see blockPayloadError.
  const appendBlock = nestedBlockSchema(
    'Block type: paragraph | heading | todo | quote | callout | code | list | divider | image, a container (columns | column | table | row | cell | group | tabs | tab | accordion | accordionsection), or any kit block (slider, number, toggle, radio, checklist, textfield, kitchart, statuslight, formula, …).',
    'Block props, e.g. heading {level}, list {kind}, todo {checked}, callout {variant}, code {language}, column {span} (12-unit grid), table row {header:true}.',
  );

  /** Total blocks in a payload, nested children included (for the write summary). */
  const totalBlocks = (list: NestedBlockInput[]): number =>
    list.reduce((n, b) => n + 1 + (b.children ? totalBlocks(b.children) : 0), 0);

  /** `"3 block(s)"`, or `"1 block(s) (7 including nested)"` when the payload nests. */
  const blockCountLabel = (list: NestedBlockInput[]): string => {
    const total = totalBlocks(list);
    return total === list.length ? `${list.length} block(s)` : `${list.length} block(s) (${total} including nested)`;
  };

  server.registerTool(
    'append_blocks',
    {
      title: 'Append blocks',
      description:
        'Append typed blocks to the end of a block-editor page. Blocks NEST: a container block carries its contents in `children`, to any depth, so one call can build a whole table or layout. ' +
        'A TABLE is table → row → cell: {"type":"table","children":[{"type":"row","props":{"header":true},"children":[{"type":"cell","text":"Item"},{"type":"cell","text":"Qty"}]},{"type":"row","children":[{"type":"cell","text":"Apples"},{"type":"cell","text":"3"}]}]} — give every row the same number of cells (column widths/order are assigned automatically when the page opens). ' +
        'TWO COLUMNS are columns → column (span is a 12-unit grid): {"type":"columns","children":[{"type":"column","props":{"span":6},"children":[{"type":"heading","text":"Left","props":{"level":2}}]},{"type":"column","props":{"span":6},"children":[{"type":"paragraph","text":"Right"}]}]}. ' +
        'Other containers: group, tabs → tab, accordion → accordionsection. Leaf blocks (paragraph/heading/todo/quote/callout/code/list/divider, kit inputs) take `text`/`props` and no children. ' +
        'Whether this applies directly or is queued as a REVIEWABLE SUGGESTION is decided per write by the library/page agent-edits policy (default: suggest — applied only when a human accepts it).',
      inputSchema: {
        pageId: z.string().describe('The page id (a block-editor page).'),
        blocks: z
          .array(appendBlock)
          .min(1)
          .describe('Blocks to append, top to bottom. Containers carry their contents in `children`.'),
      },
    },
    async ({pageId, blocks}) => {
      const page = await client.getPage(pageId);
      if (!page) return failure('Page not found.');
      if ((page.data as {editor?: string}).editor !== 'blocks') {
        return failure('That page is a legacy editor page — use append_to_page instead.');
      }
      const limit = blockPayloadError(blocks);
      if (limit) return failure(limit);
      if ((await resolveWritePolicy(pageId)) !== 'direct') {
        const summary = `Append ${blockCountLabel(blocks)} to "${page.name ?? 'Untitled'}"`;
        // The preview lists the top level with each container's child count; the FULL
        // nested payload rides in `payload.blocks` (the bridge's coerceNewBlock recurses),
        // so accepting the suggestion materializes the whole tree.
        const after = clip(
          blocks.map((b) => (b.text ? `${b.type}: ${b.text}` : b.children?.length ? `${b.type} (${b.children.length} children)` : b.type)).join('\n'),
          200,
        );
        const s = await recordSuggestion({kind: 'append_blocks', pageId, summary, after, target: {}, payload: {pageId, blocks}});
        return suggested(summary, s);
      }
      const data = appendBlocksToSnapshot(page.data, blocks, `mcp-${Date.now().toString(36)}`);
      if (!data) return failure('That page is a legacy editor page — use append_to_page instead.');
      try {
        await client.savePage({id: page.id, name: page.name, data});
      } catch (err) {
        return failure(`Could not append (the server declined the direct write): ${err instanceof Error ? err.message : String(err)}`);
      }
      return text(`Appended ${blockCountLabel(blocks)} directly to "${page.name ?? 'Untitled'}".`);
    },
  );

  server.registerTool(
    'update_block',
    {
      title: 'Update a block',
      description:
        'Replace the text of one block on a block-editor page (find the block id via inspect_page_structure). Whether this applies directly or is queued as a REVIEWABLE SUGGESTION is decided per write by the library/page agent-edits policy (default: suggest — applied only when a human accepts it).',
      inputSchema: {
        pageId: z.string().describe('The page id.'),
        blockId: z.string().describe('The block id from inspect_page_structure.'),
        text: z.string().describe('The new plain text for the block.'),
      },
    },
    async ({pageId, blockId, text: newText}) => {
      const page = await client.getPage(pageId);
      if (!page) return failure('Page not found.');
      if ((await resolveWritePolicy(pageId)) !== 'direct') {
        const before = blockTextInSnapshot(page.data, blockId);
        if (before === null) return failure(`No block "${blockId}" on that block-editor page — use inspect_page_structure.`);
        const summary = `Edit block ${blockId} on "${page.name ?? 'Untitled'}"`;
        // The full prior text (not the clipped diff `before`) rides in the payload
        // as the merge base, matching the agent's update_block proposal.
        const s = await recordSuggestion({
          kind: 'update_block',
          pageId,
          summary,
          before: clip(before, 200),
          after: clip(newText, 200),
          target: {blockId},
          payload: {pageId, blockId, text: newText, before},
        });
        return suggested(summary, s);
      }
      const data = setBlockTextInSnapshot(page.data, blockId, newText);
      if (!data) return failure(`No block "${blockId}" on that block-editor page — use inspect_page_structure.`);
      try {
        await client.savePage({id: page.id, name: page.name, data});
      } catch (err) {
        return failure(`Could not update the block (the server declined the direct write): ${err instanceof Error ? err.message : String(err)}`);
      }
      return text(`Updated block ${blockId} directly on "${page.name ?? 'Untitled'}".`);
    },
  );

  server.registerTool(
    'update_block_props',
    {
      title: 'Update a block\'s type/props',
      description:
        'Change one block\'s PROPS on a block-editor page — heading level, list kind, todo checked, callout variant, code language, image alt/width, a kit input\'s value/min/max/options, a table row\'s header flag. Use update_block for the block\'s TEXT and this for its format. Find the block id and its current props via inspect_page_structure; works on NESTED blocks too (a block inside a column/group, a table row or cell). ' +
        'MERGE SEMANTICS: props are merged SHALLOWLY over the block\'s existing props — keys you omit are left untouched, keys you pass are overwritten, and passing null for a key REMOVES it (e.g. {"bg": null} clears a background). Nested objects/arrays are replaced wholesale, never deep-merged. ' +
        'Whether this applies directly or is queued as a REVIEWABLE SUGGESTION is decided per write by the library/page agent-edits policy (default: suggest — applied only when a human accepts it).',
      inputSchema: {
        pageId: z.string().describe('The page id.'),
        blockId: z.string().describe('The block id from inspect_page_structure (may be a nested block).'),
        props: z
          .record(z.unknown())
          .describe('Props to merge, e.g. {"level":2} / {"checked":true} / {"variant":"warn"} / {"language":"python"} / {"min":0,"max":100,"value":40} / {"header":true}. Pass null as a value to REMOVE that prop.'),
      },
    },
    async ({pageId, blockId, props}) => {
      const page = await client.getPage(pageId);
      if (!page) return failure('Page not found.');
      const missing = `No block "${blockId}" on that block-editor page — use inspect_page_structure.`;
      if (Object.keys(props).length === 0) return failure('Provide at least one prop to set (or null to remove one).');
      const info = blockInfoInSnapshot(page.data, blockId);
      if (!info) return failure(missing);
      if ((await resolveWritePolicy(pageId)) !== 'direct') {
        const summary = `Update props of ${info.type} block ${blockId} on "${page.name ?? 'Untitled'}"`;
        // `applyKind: set_block_props` is the editor bridge's identifier for this
        // change (patchBlock), so an accepted MCP suggestion replays exactly like the
        // in-app agent's update_block_props — including null-removes-the-key.
        const s = await recordSuggestion({
          kind: 'set_block_props',
          pageId,
          summary,
          before: clip(JSON.stringify(info.props), 200),
          after: clip(JSON.stringify(props), 200),
          target: {blockId},
          payload: {pageId, blockId, props},
        });
        return suggested(summary, s);
      }
      const applied = setBlockPropsInSnapshot(page.data, blockId, props);
      if (!applied) return failure(missing);
      try {
        await client.savePage({id: page.id, name: page.name, data: applied.data});
      } catch (err) {
        return failure(`Could not update the props (the server declined the direct write): ${err instanceof Error ? err.message : String(err)}`);
      }
      return text(`Updated props of block ${blockId} directly on "${page.name ?? 'Untitled'}" — now ${JSON.stringify(applied.props)}.`);
    },
  );

  server.registerTool(
    'delete_block',
    {
      title: 'Delete a block',
      description:
        'Remove ONE block (and everything inside it) from a block-editor page. Find the block id via inspect_page_structure. Works at ANY depth — a top-level block, a block nested in a column/group/tab, or a table `row` or `cell`; deleting a container deletes its children with it. To empty a block instead of removing it, use update_block with empty text. ' +
        'Whether this applies directly or is queued as a REVIEWABLE SUGGESTION is decided per write by the library/page agent-edits policy (default: suggest — applied only when a human accepts it).',
      inputSchema: {
        pageId: z.string().describe('The page id.'),
        blockId: z.string().describe('The block id from inspect_page_structure (may be a nested block, a table row, or a cell).'),
      },
    },
    async ({pageId, blockId}) => {
      const page = await client.getPage(pageId);
      if (!page) return failure('Page not found.');
      const missing = `No block "${blockId}" on that block-editor page — use inspect_page_structure.`;
      const info = blockInfoInSnapshot(page.data, blockId);
      if (!info) return failure(missing);
      if ((await resolveWritePolicy(pageId)) !== 'direct') {
        const summary = `Delete ${info.type} block ${blockId} on "${page.name ?? 'Untitled'}"`;
        const before = blockTextInSnapshot(page.data, blockId);
        const s = await recordSuggestion({
          kind: 'delete_block',
          pageId,
          summary,
          before: clip(before || `(${info.type} block)`, 200),
          after: '',
          target: {blockId},
          payload: {pageId, blockId},
        });
        return suggested(summary, s);
      }
      const data = deleteBlockInSnapshot(page.data, blockId);
      if (!data) return failure(missing);
      try {
        await client.savePage({id: page.id, name: page.name, data});
      } catch (err) {
        return failure(`Could not delete the block (the server declined the direct write): ${err instanceof Error ? err.message : String(err)}`);
      }
      return text(`Deleted ${info.type} block ${blockId} directly from "${page.name ?? 'Untitled'}".`);
    },
  );

  server.registerTool(
    'set_kit_value',
    {
      title: 'Set a kit value',
      description:
        'Set a named reactive input on a page (slider/number/toggle/textfield/radio/dropdown/checklist). Find names via get_kit_values. Whether this applies directly or is queued as a REVIEWABLE SUGGESTION is decided per write by the library/page agent-edits policy (default: suggest — applied only when a human accepts it).',
      inputSchema: {
        pageId: z.string().describe('The page id.'),
        name: z.string().describe('The published input name (from get_kit_values).'),
        value: z.unknown().describe('The new value (number/string/boolean/array).'),
      },
    },
    async ({pageId, name, value}) => {
      const page = await client.getPage(pageId);
      if (!page) return failure('Page not found.');
      if ((await resolveWritePolicy(pageId)) !== 'direct') {
        const scope = kitValues(page.data);
        if (!(name in scope)) return failure(`No input named "${name}" on that page — use get_kit_values.`);
        const summary = `Set "${name}" = ${JSON.stringify(value)}`;
        const s = await recordSuggestion({
          kind: 'set_kit_value',
          pageId,
          summary,
          before: JSON.stringify(scope[name]),
          after: JSON.stringify(value),
          target: {},
          payload: {pageId, name, value},
        });
        return suggested(summary, s);
      }
      const data = setKitValueInSnapshot(page.data, name, value);
      if (!data) return failure(`No input named "${name}" on that page — use get_kit_values.`);
      try {
        await client.savePage({id: page.id, name: page.name, data});
      } catch (err) {
        return failure(`Could not set the value (the server declined the direct write): ${err instanceof Error ? err.message : String(err)}`);
      }
      return text(`Set "${name}" = ${JSON.stringify(value)} directly on "${page.name ?? 'Untitled'}".`);
    },
  );

  server.registerTool(
    'set_db_cell',
    {
      title: 'Set a database cell',
      description:
        'Set a manual property value on a database row (by property id). Whether this applies directly or is queued as a REVIEWABLE SUGGESTION is decided per write by the library/page agent-edits policy of the host page (default: suggest — applied only when a human accepts it).',
      inputSchema: {
        pageId: z.string().describe('The page hosting the database.'),
        rowId: z.string().describe('The row (page) id.'),
        propertyId: z.string().describe('The property id to set.'),
        value: z.unknown().describe('The new cell value.'),
      },
    },
    async ({pageId, rowId, propertyId, value}) => {
      const database = await client.getPageDatabase(pageId);
      if (!database) return failure('That page hosts no database.');
      const prop = (database.schema.properties ?? []).find((p) => p.id === propertyId);
      if (!prop) return failure(`No property "${propertyId}" on this database — use get_db_row.`);
      // The policy is resolved on the database's HOST page — the page the review pane
      // opens against and the page whose `agentEdits` override governs its cells.
      if ((await resolveWritePolicy(pageId)) !== 'direct') {
        const rows = await client.listRows(database.id);
        const row = rows.find((r) => r.id === rowId);
        if (!row) return failure('Row not found in this database.');
        const summary = `Set ${prop.name} = ${JSON.stringify(value)} on "${row.name ?? 'Untitled'}"`;
        const s = await recordSuggestion({
          kind: 'set_db_cell',
          // A cell suggestion is reviewed on the database's HOST page (the page
          // the review pane opens against), matching the agent's set_db_cell.
          pageId,
          summary,
          before: JSON.stringify(row.properties?.[propertyId] ?? null),
          after: JSON.stringify(value),
          target: {databaseId: database.id, rowId, propertyId},
          payload: {databaseId: database.id, rowId, propertyId, value},
        });
        return suggested(summary, s);
      }
      try {
        await client.updateRow(database.id, rowId, {properties: {[propertyId]: value}});
      } catch (err) {
        return failure(`Could not set the cell (the server declined the direct write): ${err instanceof Error ? err.message : String(err)}`);
      }
      return text(`Set ${prop.name} = ${JSON.stringify(value)} directly on row ${rowId}.`);
    },
  );

  // ── Table structure (API-3) ──────────────────────────────────────────────────
  //
  // The seven structural table ops the editor's context menu offers, plus cell
  // text and row/column tints, exposed as tools of the same names as the editor
  // bridge's proposal kinds. Everything shares ONE definition per concern with the
  // in-app paths, which is what keeps the editor, the agent, and MCP in agreement:
  //
  //  · COORDINATES are SORTED (render-order) indices — the space the editor's
  //    `cellPosition` reports, NOT the order rows/cells happen to sit in the
  //    stored array. Ids (`cellId`, `rowId`, `colId`) are also accepted and are
  //    resolved to those indices by the SDK's `resolveTableOp`.
  //  · GUARDS come from the SDK's `tableOpError` — bounds, plus the editor's
  //    header-row rule (a row cannot be inserted ABOVE row 0 while the table's
  //    `header` prop is set, because rendering is positional: the blank new row
  //    would become the header and silently demote the real one). Validation runs
  //    BEFORE the policy branch, so suggest mode and direct mode refuse identically
  //    and a refused op queues nothing.
  //  · THE LAST ROW / COLUMN removes the WHOLE table, exactly as the editor's
  //    `tableDeleteRow` / `tableDeleteColumn` do. The tool says so in its result.
  //
  // THE `col:` / `ord` DECISION (see `packages/sdk/src/tableSnapshot.ts` for the
  // full rationale): a table built by `append_blocks` has NO order keys, because an
  // MCP client cannot invent them. Rather than staying positional and deferring to
  // the editor's `ensureTableOrderInTx`, these tools MIGRATE EAGERLY — every op
  // first backfills `table.props['col:<id>']` and `row.props.ord` using the SAME
  // deterministic scheme (`c0…cN-1`, `keysBetween(null, null, n)`) and the SAME key
  // algebra the editor uses, so a table migrated here and one migrated by the
  // editor end up with byte-identical keys. Insert and move are DEFINED as
  // order-key edits; a positional-only implementation would have to reorder nodes a
  // concurrent peer is editing and would disagree with the editor on an
  // already-keyed table. `inspect_table` reports a not-yet-migrated table as
  // "unmigrated" so the difference is visible.
  //
  // These tools are the ONLY sanctioned way to write `ord` / `col:` / `colbg:`;
  // `update_block_props` refuses those keys.

  /** The write-summary label for a table op (also the suggestion's summary). */
  const tableOpLabel = (kind: TableOpKind, view: SnapshotTableView, resolved: {rowIndex?: number; colIndex?: number; toIndex?: number; text?: string; color?: string | null}): string => {
    const where = `table ${view.tableId}`;
    switch (kind) {
    case 'table_insert_row': return `Insert a row at position ${resolved.rowIndex} of ${where}`;
    case 'table_delete_row': return `Delete row ${resolved.rowIndex} of ${where}`;
    case 'table_duplicate_row': return `Duplicate row ${resolved.rowIndex} of ${where}`;
    case 'table_insert_column': return `Insert a column at position ${resolved.colIndex} of ${where}`;
    case 'table_delete_column': return `Delete column ${resolved.colIndex} of ${where}`;
    case 'table_move_row': return `Move row ${resolved.rowIndex} to position ${resolved.toIndex} of ${where}`;
    case 'table_move_column': return `Move column ${resolved.colIndex} to position ${resolved.toIndex} of ${where}`;
    case 'table_set_cell': return `Set row ${resolved.rowIndex}, column ${resolved.colIndex} of ${where} to "${clip(resolved.text ?? '', 60)}"`;
    case 'table_set_row_color': return `${resolved.color ? `Tint row ${resolved.rowIndex} ${resolved.color}` : `Clear the tint on row ${resolved.rowIndex}`} of ${where}`;
    case 'table_set_column_color': return `${resolved.color ? `Tint column ${resolved.colIndex} ${resolved.color}` : `Clear the tint on column ${resolved.colIndex}`} of ${where}`;
    }
  };

  /** The before→after pair the review card shows for a table op. */
  const tableOpDiff = (kind: TableOpKind, view: SnapshotTableView, resolved: {rowIndex?: number; colIndex?: number; toIndex?: number; text?: string; color?: string | null}): {before: string; after: string} => {
    const row = (r: number | undefined): string => (r === undefined ? '' : (view.cells[r] ?? []).join(' | '));
    const column = (c: number | undefined): string => (c === undefined ? '' : view.cells.map((cells) => cells[c] ?? '').join(' | '));
    switch (kind) {
    case 'table_insert_row': return {before: '', after: `(blank row at position ${resolved.rowIndex})`};
    case 'table_insert_column': return {before: '', after: `(blank column at position ${resolved.colIndex})`};
    case 'table_delete_row': return {before: row(resolved.rowIndex), after: ''};
    case 'table_delete_column': return {before: column(resolved.colIndex), after: ''};
    case 'table_duplicate_row': return {before: row(resolved.rowIndex), after: `${row(resolved.rowIndex)} (copied below)`};
    case 'table_move_row': return {before: `row ${resolved.rowIndex}: ${row(resolved.rowIndex)}`, after: `position ${resolved.toIndex}`};
    case 'table_move_column': return {before: `column ${resolved.colIndex}: ${column(resolved.colIndex)}`, after: `position ${resolved.toIndex}`};
    case 'table_set_cell': return {before: view.cells[resolved.rowIndex ?? 0]?.[resolved.colIndex ?? 0] ?? '', after: resolved.text ?? ''};
    case 'table_set_row_color': return {before: '(row tint)', after: resolved.color ?? '(none)'};
    case 'table_set_column_color': return {before: '(column tint)', after: resolved.color ?? '(none)'};
    }
  };

  /**
   * Run one table op end to end: locate the table, resolve id-or-index addressing
   * to SORTED coordinates, validate, then either queue a suggestion or apply the
   * op to the stored snapshot. Shared by all ten tools so they can't drift in
   * their error wording, their policy handling, or their payload shape.
   */
  const runTableOp = async (kind: TableOpKind, pageId: string, address: TableOpAddress & {tableId?: string}) => {
    const page = await client.getPage(pageId);
    if (!page) return failure('Page not found.');
    if ((page.data as {editor?: string}).editor !== 'blocks') {
      return failure('That page is a legacy editor page — it has no block tables.');
    }
    // The table is named directly, or inferred from a cell/row id inside it.
    const anchor = address.tableId ?? address.cellId ?? address.rowId;
    if (!anchor) return failure('Provide a tableId (or a cellId / rowId inside the table) — find them with inspect_table.');
    const tableId = snapshotTableIdFor(page.data, anchor);
    if (!tableId) return failure(`No table containing "${anchor}" on that page — use inspect_table to list this page's tables.`);
    const view = snapshotTableView(page.data, tableId);
    if (!view) return failure(`No table "${tableId}" on that page — use inspect_table.`);

    const resolved = resolveTableOp(view, kind, address);
    if ('error' in resolved) return failure(resolved.error);
    const {op} = resolved;
    const invalid = tableOpError(tableShapeOf(view), op);
    if (invalid) return failure(invalid);

    const summary = tableOpLabel(kind, view, op);
    const removesTable = tableOpRemovesTable(tableShapeOf(view), op);

    if ((await resolveWritePolicy(pageId)) !== 'direct') {
      const {before, after} = tableOpDiff(kind, view, op);
      // The payload carries BOTH the resolved sorted indices and the STABLE ids of
      // the nodes they resolved to (when the node already exists — an insert has no
      // node yet). The editor bridge prefers the ids, so a suggestion that sits in
      // review while the table is reordered still edits the row/cell it meant, and
      // errors cleanly if that node is gone instead of hitting whatever now occupies
      // the index.
      const stable: Record<string, unknown> = {};
      if (op.rowIndex !== undefined && kind !== 'table_insert_row' && view.rowIds[op.rowIndex]) stable.rowId = view.rowIds[op.rowIndex];
      if (op.colIndex !== undefined && kind !== 'table_insert_column' && view.colIds[op.colIndex]) stable.colId = view.colIds[op.colIndex];
      if (kind === 'table_set_cell') {
        const cellId = view.cellIds[op.rowIndex ?? 0]?.[op.colIndex ?? 0];
        if (cellId) stable.cellId = cellId;
        delete stable.rowId;
        delete stable.colId;
      }
      // `op.kind` is dropped: the bridge reads the op from `payload.applyKind`
      // (added by recordSuggestion), and two names for the same thing invite drift.
      const coords: Record<string, unknown> = {...op};
      delete coords.kind;
      const s = await recordSuggestion({
        kind,
        pageId,
        summary,
        before: clip(before, 200),
        after: clip(after, 200),
        // The review card anchors on the TABLE block — the thing the reviewer looks
        // at — while the payload holds the precise coordinates.
        target: {blockId: tableId},
        payload: {pageId, tableId, ...coords, ...stable},
      });
      return suggested(summary, s);
    }

    const applied = applyTableOpToSnapshot(page.data, tableId, op);
    if (!applied) return failure(`No table "${tableId}" on that page — use inspect_table.`);
    try {
      await client.savePage({id: page.id, name: page.name, data: applied.data});
    } catch (err) {
      return failure(`Could not apply the table op (the server declined the direct write): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (applied.removedTable || removesTable) {
      return text(`${summary} — that was the last ${kind === 'table_delete_row' ? 'row' : 'column'}, so the whole table block was removed from "${page.name ?? 'Untitled'}" (the editor behaves the same way).`);
    }
    const after = snapshotTableView(applied.data, tableId);
    return text(`${summary} — applied directly. The table is now ${after?.rows ?? '?'} row(s) × ${after?.cols ?? '?'} column(s).`);
  };

  const PAGE_ARG = z.string().describe('The page id.');
  const TABLE_ARG = z
    .string()
    .optional()
    .describe('The table block id (from inspect_table / inspect_page_structure). Optional when a cellId or rowId inside the table is given.');
  const ROW_INDEX = (what: string) => z.number().int().optional().describe(`${what} Counted in RENDER order, 0-based (row 0 is the header row when the table has one).`);
  const COL_INDEX = (what: string) => z.number().int().optional().describe(`${what} Counted in RENDER order, 0-based (column 0 is the leftmost).`);
  const COLOR_ARG = z
    .string()
    .nullable()
    .describe('A palette token (e.g. "amber", "blue", "green"), or null to clear the tint.');

  /** Boilerplate shared by every table write tool's description. */
  const TABLE_POLICY_NOTE =
    'Coordinates are RENDER-order (sorted) indices, the same ones inspect_table prints — not positions in the stored array. ' +
    'Whether this applies directly or is queued as a REVIEWABLE SUGGESTION is decided per write by the library/page agent-edits policy (default: suggest — applied only when a human accepts it).';

  server.registerTool(
    'inspect_table',
    {
      title: 'Inspect a table',
      description:
        'Show a block table in RENDER order: its size, whether it has a header row, its column ids, and every row/cell id with its text. Call this BEFORE any table_* tool — the row, column and cell ids it prints are what those tools address, and the indices it prints are the RENDER-order coordinates they take (a stored table\'s array order is NOT its render order once it has been reordered). ' +
        'Omit tableId to list every table on the page. A table reported as "unmigrated" has no order keys yet (it was built by append_blocks); the first table_* op assigns them without changing what you see here.',
      inputSchema: {
        pageId: PAGE_ARG,
        tableId: z.string().optional().describe('The table block id. Omit to list every table on the page.'),
      },
    },
    async ({pageId, tableId}) => {
      const page = await client.getPage(pageId);
      if (!page) return failure('Page not found.');
      if (!tableId) {
        const tables = snapshotTables(page.data);
        if (tables.length === 0) return text('That page has no tables.');
        return text(tables.map((t) => `- [${t.id}] ${t.rows} row(s) × ${t.cols} column(s)${t.header ? ', header row' : ''}`).join('\n'));
      }
      const view = snapshotTableView(page.data, tableId);
      if (!view) return failure(`No table "${tableId}" on that page — omit tableId to list this page's tables.`);
      const lines = [
        `Table [${view.tableId}] — ${view.rows} row(s) × ${view.cols} column(s), header row: ${view.header ? 'yes' : 'no'}`,
        view.colIds.length > 0
          ? `Column ids (render order): ${view.colIds.map((id, i) => `${i}=${id}`).join('  ')}`
          : 'Column ids: none yet (unmigrated — the first table_* op assigns them; render order is the stored order until then)',
      ];
      view.cells.forEach((cells, r) => {
        const body = cells.map((t, c) => `${c}:"${clip(t, 40)}"${view.cellIds[r][c] ? ` [${view.cellIds[r][c]}]` : ' [gap]'}`).join('  ');
        lines.push(`row ${r} [${view.rowIds[r]}]${view.header && r === 0 ? ' (header)' : ''}: ${body}`);
      });
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'table_insert_row',
    {
      title: 'Insert a table row',
      description:
        'Insert a blank row into a table at a RENDER-order position, with one cell per column. Pass the position you want the new row to OCCUPY: 0 puts it first, and the table\'s current row count appends it at the end. ' +
        'REFUSED at position 0 when the table has a header row — rendering is positional, so the blank row would become the header and demote the real one; insert at 1 to add a row directly below the header. ' +
        TABLE_POLICY_NOTE,
      inputSchema: {
        pageId: PAGE_ARG,
        tableId: TABLE_ARG,
        rowIndex: z.number().int().describe('Where the new row should land, 0-based in RENDER order (0…row count; the row count appends).'),
        cellId: z.string().optional().describe('A cell inside the target table — an alternative to tableId for naming the table.'),
      },
    },
    async ({pageId, tableId, rowIndex, cellId}) =>
      // A cellId here names the TABLE only; the caller's explicit rowIndex decides
      // where the row lands, so the cell's own coordinates must not override it.
      runTableOp('table_insert_row', pageId, {tableId: tableId ?? cellId, rowIndex}),
  );

  server.registerTool(
    'table_delete_row',
    {
      title: 'Delete a table row',
      description:
        'Delete one row of a table (with its cells). Address it by RENDER-order index or by its row block id. Deleting the LAST remaining row removes the whole table block — the same rule the editor follows. ' +
        TABLE_POLICY_NOTE,
      inputSchema: {
        pageId: PAGE_ARG,
        tableId: TABLE_ARG,
        rowIndex: ROW_INDEX('The row to delete.'),
        rowId: z.string().optional().describe('The row block id (from inspect_table) — an alternative to rowIndex, and it names the table too.'),
      },
    },
    async ({pageId, tableId, rowIndex, rowId}) => runTableOp('table_delete_row', pageId, {tableId, rowIndex, rowId}),
  );

  server.registerTool(
    'table_duplicate_row',
    {
      title: 'Duplicate a table row',
      description:
        'Copy one row of a table directly below itself: fresh block ids, the same cell text, the same column bindings, and the source row\'s tint. Address it by RENDER-order index or row block id. ' +
        TABLE_POLICY_NOTE,
      inputSchema: {
        pageId: PAGE_ARG,
        tableId: TABLE_ARG,
        rowIndex: ROW_INDEX('The row to duplicate.'),
        rowId: z.string().optional().describe('The row block id (from inspect_table) — an alternative to rowIndex.'),
      },
    },
    async ({pageId, tableId, rowIndex, rowId}) => runTableOp('table_duplicate_row', pageId, {tableId, rowIndex, rowId}),
  );

  server.registerTool(
    'table_insert_column',
    {
      title: 'Insert a table column',
      description:
        'Insert a blank column into a table at a RENDER-order position, adding one cell to every row. Pass the position the new column should OCCUPY: 0 puts it leftmost, and the table\'s current column count appends it on the right. ' +
        TABLE_POLICY_NOTE,
      inputSchema: {
        pageId: PAGE_ARG,
        tableId: TABLE_ARG,
        colIndex: z.number().int().describe('Where the new column should land, 0-based in RENDER order (0…column count; the column count appends).'),
        cellId: z.string().optional().describe('A cell inside the target table — an alternative to tableId for naming the table.'),
      },
    },
    async ({pageId, tableId, colIndex, cellId}) => runTableOp('table_insert_column', pageId, {tableId: tableId ?? cellId, colIndex}),
  );

  server.registerTool(
    'table_delete_column',
    {
      title: 'Delete a table column',
      description:
        'Delete one column of a table: its registry entry, its tint, and its cell in every row. Address it by RENDER-order index or column id. Deleting the LAST remaining column removes the whole table block — the same rule the editor follows. ' +
        TABLE_POLICY_NOTE,
      inputSchema: {
        pageId: PAGE_ARG,
        tableId: TABLE_ARG,
        colIndex: COL_INDEX('The column to delete.'),
        colId: z.string().optional().describe('The column id (from inspect_table) — an alternative to colIndex. Only a migrated table has column ids.'),
      },
    },
    async ({pageId, tableId, colIndex, colId}) => runTableOp('table_delete_column', pageId, {tableId, colIndex, colId}),
  );

  server.registerTool(
    'table_move_row',
    {
      title: 'Move a table row',
      description:
        'Move a row to another RENDER-order position. `toIndex` is the position it should end up at counted WITH THE MOVED ROW REMOVED (so moving row 0 down by one is toIndex 1). Only the row\'s order key changes — its cells are untouched, so concurrent edits inside it merge cleanly. Moving a row to position 0 makes it the header row when the table has one. ' +
        TABLE_POLICY_NOTE,
      inputSchema: {
        pageId: PAGE_ARG,
        tableId: TABLE_ARG,
        rowIndex: ROW_INDEX('The row to move.'),
        rowId: z.string().optional().describe('The row block id (from inspect_table) — an alternative to rowIndex, and the safer choice.'),
        toIndex: z.number().int().describe('Target position, 0-based, counted with the moved row removed.'),
      },
    },
    async ({pageId, tableId, rowIndex, rowId, toIndex}) => runTableOp('table_move_row', pageId, {tableId, rowIndex, rowId, toIndex}),
  );

  server.registerTool(
    'table_move_column',
    {
      title: 'Move a table column',
      description:
        'Move a column to another RENDER-order position. `toIndex` is the position it should end up at counted WITH THE MOVED COLUMN REMOVED. Only the column\'s order key changes — no cell is touched, so concurrent edits in that column merge cleanly and its tint follows it. ' +
        TABLE_POLICY_NOTE,
      inputSchema: {
        pageId: PAGE_ARG,
        tableId: TABLE_ARG,
        colIndex: COL_INDEX('The column to move.'),
        colId: z.string().optional().describe('The column id (from inspect_table) — an alternative to colIndex.'),
        toIndex: z.number().int().describe('Target position, 0-based, counted with the moved column removed.'),
      },
    },
    async ({pageId, tableId, colIndex, colId, toIndex}) => runTableOp('table_move_column', pageId, {tableId, colIndex, colId, toIndex}),
  );

  server.registerTool(
    'table_set_cell',
    {
      title: 'Set a table cell',
      description:
        'Replace the text of one table cell. Address it by RENDER-order row + column index, or by its cell block id (which identifies the table on its own). Use this rather than update_block when you are working in grid coordinates; update_block by cell id does the same thing. ' +
        TABLE_POLICY_NOTE,
      inputSchema: {
        pageId: PAGE_ARG,
        tableId: TABLE_ARG,
        rowIndex: ROW_INDEX('The cell\'s row.'),
        colIndex: COL_INDEX('The cell\'s column.'),
        cellId: z.string().optional().describe('The cell block id (from inspect_table) — resolves BOTH indices and names the table.'),
        text: z.string().describe('The new plain text for the cell (empty string clears it).'),
      },
    },
    async ({pageId, tableId, rowIndex, colIndex, cellId, text: cellText}) =>
      runTableOp('table_set_cell', pageId, {tableId, rowIndex, colIndex, cellId, text: cellText}),
  );

  server.registerTool(
    'table_set_row_color',
    {
      title: 'Tint a table row',
      description:
        'Set (or clear) a row\'s background tint — the row block\'s `bg` prop. A row tint wins over a column tint where both apply. ' +
        TABLE_POLICY_NOTE,
      inputSchema: {
        pageId: PAGE_ARG,
        tableId: TABLE_ARG,
        rowIndex: ROW_INDEX('The row to tint.'),
        rowId: z.string().optional().describe('The row block id (from inspect_table) — an alternative to rowIndex.'),
        color: COLOR_ARG,
      },
    },
    async ({pageId, tableId, rowIndex, rowId, color}) => runTableOp('table_set_row_color', pageId, {tableId, rowIndex, rowId, color}),
  );

  server.registerTool(
    'table_set_column_color',
    {
      title: 'Tint a table column',
      description:
        'Set (or clear) a column\'s background tint — the table-level `colbg:<colId>` prop, keyed on the column\'s stable id, so the tint follows the column through reorders. A row tint wins over a column tint where both apply. ' +
        TABLE_POLICY_NOTE,
      inputSchema: {
        pageId: PAGE_ARG,
        tableId: TABLE_ARG,
        colIndex: COL_INDEX('The column to tint.'),
        colId: z.string().optional().describe('The column id (from inspect_table) — an alternative to colIndex.'),
        color: COLOR_ARG,
      },
    },
    async ({pageId, tableId, colIndex, colId, color}) => runTableOp('table_set_column_color', pageId, {tableId, colIndex, colId, color}),
  );

  return server;
}
