import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {
  appendBlocksToSnapshot,
  appendTextToSnapshot,
  snapshotText,
  textSnapshot,
  type AgentEditsMode,
  type DataClient,
  type PageSnapshot,
  type StoredSuggestion,
  type SuggestionKind,
  type SuggestionTarget,
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

/**
 * The write-tool kind an MCP mutation maps to (the same identifiers the in-app
 * agent's proposals use, carried into the suggestion payload as `applyKind` so
 * the editor bridge replays an MCP-authored suggestion exactly like an
 * agent-authored one). MCP only ever emits these four; the SDK suggestion
 * `kind` each maps to mirrors `SUGGESTION_KIND` in packages/server/src/ai/agent.ts.
 */
type McpWriteKind = 'append_blocks' | 'update_block' | 'set_kit_value' | 'set_db_cell';

const MCP_SUGGESTION_KIND: Record<McpWriteKind, SuggestionKind> = {
  append_blocks: 'insert',
  update_block: 'replace-text',
  set_kit_value: 'replace-text',
  set_db_cell: 'set-cell',
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
  // of "Unsupported block" placeholders.
  const ARTIFACT_TYPES = new Set([
    'heading', 'paragraph', 'todo', 'quote', 'callout', 'divider', 'code', 'list',
    'slider', 'formula', 'number', 'textfield', 'radio', 'checklist', 'toggle',
    'location', 'actionbutton', 'kitchart', 'statuslight', 'tooltipcard', 'linkcard',
  ]);

  const artifactBlock = z.object({
    type: z.string().describe('Block type, e.g. heading | paragraph | number | slider | radio | checklist | toggle | kitchart | statuslight | actionbutton | formula | linkcard | tooltipcard | location | textfield'),
    text: z.string().optional().describe('Text content (heading/paragraph/todo/quote/callout/code/list).'),
    props: z.record(z.unknown()).optional().describe(
      'Block props. Inputs publish {name} into a shared scope: number {name,value,min,max,step}; slider {name,value,min,max}; radio/checklist {name,options:"A, B",value|selected}; toggle {name,value}. ' +
      'Consumers evaluate expressions over the scope: kitchart {kind:line|area|bar|pie|donut|scatter|funnel, source:"[n, n*2]", title, labels}; statuslight {label, source, okAt, warnAt}; formula {source}. ' +
      'actionbutton {btnlabel, action:increment|set|toggle|link, target, amount, url}; linkcard {title, description, url}; tooltipcard {term, tip}; heading {level}.',
    ),
  });

  server.registerTool(
    'create_artifact_page',
    {
      title: 'Create an artifact page',
      description:
        'Create an interactive page from blocks: named inputs (number stepper, slider, radio, checklist, toggle, text field) publish values onto a shared scope, and live blocks compute over it (kitchart, statuslight, formula — JavaScript expressions over the input names). Use this to BUILD calculators, dashboards, and pickers instead of writing HTML. Creating a page is non-destructive, so it is applied immediately.',
      inputSchema: {
        title: z.string().describe('The page title — a display label; it need not be unique (pages are identified by id).'),
        blocks: z.array(artifactBlock).min(1).describe('The page content, top to bottom.'),
      },
    },
    async ({title, blocks}) => {
      const name = title.trim();
      if (!name) return failure('A title is required.');
      const bad = blocks.find((b) => !ARTIFACT_TYPES.has(b.type));
      if (bad) return failure(`Unknown block type "${bad.type}". Use one of: ${[...ARTIFACT_TYPES].join(', ')}.`);
      const projected = blocks.map((b, i) => ({
        id: `mcp-${i}`,
        type: b.type,
        ...(b.text !== undefined ? {text: [{t: b.text}]} : {}),
        ...(b.props ? {props: b.props} : {}),
      }));
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

  server.registerTool(
    'append_blocks',
    {
      title: 'Append blocks',
      description:
        'Append typed blocks (paragraph/heading/todo/quote/callout/code/divider) to the end of a block-editor page. Whether this applies directly or is queued as a REVIEWABLE SUGGESTION is decided per write by the library/page agent-edits policy (default: suggest — applied only when a human accepts it).',
      inputSchema: {
        pageId: z.string().describe('The page id (a block-editor page).'),
        blocks: z
          .array(z.object({type: z.string(), text: z.string().optional(), props: z.record(z.unknown()).optional()}))
          .min(1)
          .describe('Blocks to append, top to bottom.'),
      },
    },
    async ({pageId, blocks}) => {
      const page = await client.getPage(pageId);
      if (!page) return failure('Page not found.');
      if ((page.data as {editor?: string}).editor !== 'blocks') {
        return failure('That page is a legacy editor page — use append_to_page instead.');
      }
      if ((await resolveWritePolicy(pageId)) !== 'direct') {
        const summary = `Append ${blocks.length} block(s) to "${page.name ?? 'Untitled'}"`;
        const after = clip(blocks.map((b) => (b.text ? `${b.type}: ${b.text}` : b.type)).join('\n'), 200);
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
      return text(`Appended ${blocks.length} block(s) directly to "${page.name ?? 'Untitled'}".`);
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

  return server;
}
