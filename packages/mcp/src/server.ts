import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {
  appendBlocksToSnapshot,
  appendTextToSnapshot,
  snapshotText,
  textSnapshot,
  type DataClient,
  type PageSnapshot,
} from '@open-book/sdk';

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
 * The OpenBook MCP server: exposes a workspace to any MCP client (Claude
 * Desktop, Claude Code, …) as a set of tools over the same `@open-book/sdk`
 * contract the apps use. Read tools degrade gracefully (search is lexical
 * BM25 even with the AI engine off); write tools share the SDK's content
 * helpers with the in-app agent, so both honour the same rules (e.g. pages
 * owned by the collaborative editor are never appended to blindly).
 */

const clip = (s: string, n = 4000): string => (s.length > n ? `${s.slice(0, n)}…` : s);

const text = (value: string) => ({content: [{type: 'text' as const, text: value}]});
const failure = (value: string) => ({content: [{type: 'text' as const, text: value}], isError: true});

export function createOpenBookMcpServer(client: DataClient, version = '0.1.0'): McpServer {
  const server = new McpServer({name: 'openbook', version});

  server.registerTool(
    'list_pages',
    {
      title: 'List pages',
      description: 'List workspace pages (id and title), most recently updated first.',
      inputSchema: {},
    },
    async () => {
      const pages = await client.listPages();
      if (pages.length === 0) return text('The workspace has no pages yet.');
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
        'Search every note/page in the workspace; returns ranked matches with snippets. Works without an AI model (keyword ranking) and upgrades to semantic ranking when the server has one.',
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
      description: 'Create a new page with a title and optional text content (one paragraph per line).',
      inputSchema: {
        title: z.string().describe('The page title (must be unique in the workspace).'),
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
        'Create an interactive page from blocks: named inputs (number stepper, slider, radio, checklist, toggle, text field) publish values onto a shared scope, and live blocks compute over it (kitchart, statuslight, formula — JavaScript expressions over the input names). Use this to BUILD calculators, dashboards, and pickers instead of writing HTML.',
      inputSchema: {
        title: z.string().describe('The page title (must be unique in the workspace).'),
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
      description: 'Append text to the end of an existing page (one paragraph per line).',
      inputSchema: {
        pageId: z.string().describe('The page id.'),
        content: z.string().describe('Plain-text to append; each line becomes a paragraph.'),
      },
    },
    async ({pageId, content}) => {
      const page = await client.getPage(pageId);
      if (!page) return failure('Page not found.');
      const data = appendTextToSnapshot(page.data, content, `mcp-${Date.now().toString(36)}`);
      if (!data) {
        return failure('This page uses the collaborative editor and cannot be appended to from here — create a new page instead.');
      }
      if (data === page.data) return failure('Nothing to append.');
      await client.savePage({id: page.id, name: page.name, data});
      return text(`Appended to "${page.name ?? 'Untitled'}".`);
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
      description: 'Add a row to the database hosted on a page, optionally with a title and property values.',
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
  // The MCP server has no live editor, so writes go straight through the SDK
  // content helpers / row APIs (the same fallback the in-app confirm gate uses
  // when no editor bridge is present). The in-app agent gates these behind
  // approval; an MCP client is an external automation and applies directly.

  server.registerTool(
    'append_blocks',
    {
      title: 'Append blocks',
      description: 'Append typed blocks (paragraph/heading/todo/quote/callout/code/divider) to the end of a block-editor page.',
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
      const data = appendBlocksToSnapshot(page.data, blocks, `mcp-${Date.now().toString(36)}`);
      if (!data) return failure('That page is a legacy editor page — use append_to_page instead.');
      await client.savePage({id: page.id, name: page.name, data});
      return text(`Appended ${blocks.length} block(s) to "${page.name ?? 'Untitled'}".`);
    },
  );

  server.registerTool(
    'update_block',
    {
      title: 'Update a block',
      description: 'Replace the text of one block on a block-editor page (find the block id via inspect_page_structure).',
      inputSchema: {
        pageId: z.string().describe('The page id.'),
        blockId: z.string().describe('The block id from inspect_page_structure.'),
        text: z.string().describe('The new plain text for the block.'),
      },
    },
    async ({pageId, blockId, text: newText}) => {
      const page = await client.getPage(pageId);
      if (!page) return failure('Page not found.');
      const data = setBlockTextInSnapshot(page.data, blockId, newText);
      if (!data) return failure(`No block "${blockId}" on that block-editor page — use inspect_page_structure.`);
      await client.savePage({id: page.id, name: page.name, data});
      return text(`Updated block ${blockId} on "${page.name ?? 'Untitled'}".`);
    },
  );

  server.registerTool(
    'set_kit_value',
    {
      title: 'Set a kit value',
      description: 'Set a named reactive input on a page (slider/number/toggle/textfield/radio/dropdown/checklist). Find names via get_kit_values.',
      inputSchema: {
        pageId: z.string().describe('The page id.'),
        name: z.string().describe('The published input name (from get_kit_values).'),
        value: z.unknown().describe('The new value (number/string/boolean/array).'),
      },
    },
    async ({pageId, name, value}) => {
      const page = await client.getPage(pageId);
      if (!page) return failure('Page not found.');
      const data = setKitValueInSnapshot(page.data, name, value);
      if (!data) return failure(`No input named "${name}" on that page — use get_kit_values.`);
      await client.savePage({id: page.id, name: page.name, data});
      return text(`Set "${name}" = ${JSON.stringify(value)} on "${page.name ?? 'Untitled'}".`);
    },
  );

  server.registerTool(
    'set_db_cell',
    {
      title: 'Set a database cell',
      description: 'Set a manual property value on a database row (by property id).',
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
      try {
        await client.updateRow(database.id, rowId, {properties: {[propertyId]: value}});
      } catch (err) {
        return failure(`Could not set the cell: ${err instanceof Error ? err.message : String(err)}`);
      }
      return text(`Set ${prop.name} = ${JSON.stringify(value)} on row ${rowId}.`);
    },
  );

  return server;
}
