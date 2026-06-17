import {randomUUID} from 'node:crypto';
import {
  snapshotText,
  textSnapshot,
  type AgentProposal,
  type AiEffort,
  type AiProvider,
  type AiSkill,
  type DatabaseProperty,
  type DatabasePropertyType,
  type DatabaseSchema,
  type DatabaseSelectOption,
  type InterviewStep,
  type PluginAgentTool,
  type StoredSuggestion,
  type SuggestionKind,
} from '@open-book/sdk';
import type {PageStore} from '../store';
import {effortProfile} from './effort';
import type {AiEngine, NativeTool, NativeToolCall} from './providers';
import type {AiService} from './service';
import {ReasoningSplitter, SCRATCHPAD_INSTRUCTION, splitReasoning} from './thinking';

/**
 * A small agent harness over the configured AI engine.
 *
 * Two protocols, one loop. By default the model answers with ONE JSON object
 * per turn — `{"tool": "...", "args": {...}}` or `{"final": "..."}` — which is
 * reliable on every local model (small GGUF/MLX included). When the endpoint
 * advertises native (OpenAI-style) function-calling we use that instead and
 * fall back to JSON on any hiccup. Both feed the same tool executors.
 *
 * Reasoning ("thinking") is split out of the model's text and streamed on a
 * separate channel so the UI shows it as a collapsible block — never document
 * content. Effort (low/med/high) drives the step cap and sampling.
 *
 * Write safety: write tools never mutate. They persist SUGGESTIONS (proposed,
 * reviewable changes) and surface a "review" event linking to the Review side
 * pane. A human accepts a suggestion later (the client replays its payload
 * through the editor bridge in one CRDT transaction, undoable) — the agent
 * never applies anything itself. AI and human suggestions share one model.
 */

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type AgentEvent =
  | {type: 'tool'; name: string; args: Record<string, unknown>}
  | {type: 'tool_result'; name: string; result: string}
  /** A chunk of the answer, streamed live (native tool-calling engines only). */
  | {type: 'token'; text: string}
  | {type: 'reasoning'; text: string}
  /**
   * The write tools persisted these suggestions for review (NOT applied). The
   * UI shows a "proposed N suggestions — Review" card linking to the Review
   * side pane, where a human accepts/rejects each.
   */
  | {type: 'suggestions'; suggestions: StoredSuggestion[]}
  /** The agent is asking the user to grant direct (review-free) edit access. */
  | {type: 'permission_request'; summary: string}
  /** The agent is asking the user a multi-step interview (answers come back as
   *  the user's next message). */
  | {type: 'interview'; title?: string; steps: InterviewStep[]}
  /** Edits applied DIRECTLY (the user granted edit access); the client replays
   *  them through the editor bridge. */
  | {type: 'apply'; proposals: Array<AgentProposal>}
  | {type: 'final'; text: string}
  | {type: 'error'; error: string};

export interface AgentRunOptions {
  effort?: AiEffort;
  /** Per-conversation provider/model override (else the configured default). */
  engineOverride?: {provider?: AiProvider; model?: string};
  /** Surface reasoning to the UI (default true). */
  thinking?: boolean;
  /** Prompt/recipe skills to inline into the system prompt. */
  skills?: AiSkill[];
  /** Plugin-contributed agent tools (read from manifests). */
  pluginTools?: PluginAgentTool[];
  /** Ambient context: the page the user is viewing + their current selection,
   *  injected into the system prompt so replies are grounded without a tool call. */
  context?: {pageTitle?: string; pageId?: string; pageText?: string; selection?: string};
  /** The user granted direct edit access (via request_edit_access): the write
   *  tools apply changes immediately (an `apply` event) instead of proposing
   *  review suggestions. Sticky for the conversation. */
  allowDirectEdits?: boolean;
  /** Called once after a run that created, moved, or otherwise restructured pages
   *  — so the host can re-broadcast the page list (the sidebar stays live). */
  onPagesChanged?: () => void | Promise<void>;
}

interface ToolDef {
  name: string;
  description: string;
  /** Human-readable args spec for the JSON protocol catalogue. */
  args: string;
  /** JSON-Schema for native tool-calling. */
  schema: Record<string, unknown>;
  /** True for tools that change the workspace (gated behind proposals). */
  write?: boolean;
  run: (args: Record<string, unknown>) => Promise<string>;
}

const clip = (s: string, n = 1500): string => (s.length > n ? `${s.slice(0, n)}…` : s);

const obj = (props: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties: props,
  ...(required.length ? {required} : {}),
});
const str = (description: string) => ({type: 'string', description});

/** Display name for AI-authored suggestions. */
const AI_AUTHOR_NAME = 'Assistant';

/** Map an agent write-tool kind to the SDK suggestion kind (for the diff card). */
const SUGGESTION_KIND: Record<AgentProposal['kind'], SuggestionKind> = {
  update_block: 'replace-text',
  append_blocks: 'insert',
  set_kit_value: 'replace-text',
  set_db_cell: 'set-cell',
  set_page_theme: 'set-theme',
  delete_block: 'delete',
  set_block_props: 'replace-text',
};

export class AgentRunner {
  private readonly tools: ToolDef[];
  /** Suggestions persisted across this run's write-tool calls (reviewed later). */
  private suggestions: StoredSuggestion[] = [];
  /** Whether the user has granted direct (review-free) edit access this run. */
  private readonly directEdits: boolean;
  /** Set when a tool changed the page tree (create/move) → broadcast on finish. */
  private pagesTouched = false;
  /** Proposals to apply DIRECTLY this run (when {@link directEdits}). */
  private pendingApply: AgentProposal[] = [];
  /** A pending interactive request (permission / interview) that pauses the run
   *  until the user responds (via their next message). */
  private interactive: {type: 'permission_request'; summary: string} | {type: 'interview'; title?: string; steps: InterviewStep[]} | null = null;

  constructor(
    private readonly ai: AiService,
    private readonly store: PageStore,
    private readonly options: AgentRunOptions = {},
  ) {
    this.directEdits = options.allowDirectEdits === true;
    this.tools = [
      ...this.readTools(),
      ...this.writeTools(),
      ...this.databaseTools(),
      ...this.pageTools(),
      ...this.layoutTools(),
      ...this.interactiveTools(),
      ...this.pluginToolDefs(),
    ];
  }

  // ── Read tools ──────────────────────────────────────────────────────────────

  private readTools(): ToolDef[] {
    return [
      {
        name: 'search_notes',
        description: 'Search every note/page in the workspace; returns ranked matches with snippets.',
        args: '{"query": string}',
        schema: obj({query: str('What to look for.')}, ['query']),
        run: async (args) => {
          const res = await this.ai.search(String(args.query ?? ''), 5);
          if (res.results.length === 0) return 'No matching notes.';
          return res.results.map((r) => `- [${r.pageId}] ${r.title}: ${r.snippet}`).join('\n');
        },
      },
      {
        name: 'list_pages',
        description: 'List workspace pages (id and title), most recently updated first.',
        args: '{}',
        schema: obj({}),
        run: async () => {
          const pages = await this.store.listPages();
          return pages.slice(0, 40).map((p) => `- [${p.id}] ${p.name ?? 'Untitled'}`).join('\n');
        },
      },
      {
        name: 'read_page',
        description: 'Read the full text of one page by id.',
        args: '{"pageId": string}',
        schema: obj({pageId: str('The page id.')}, ['pageId']),
        run: async (args) => {
          const page = await this.store.getPage(String(args.pageId ?? ''));
          if (!page) return 'Page not found.';
          return `Title: ${page.name ?? 'Untitled'}\n\n${clip(snapshotText(page.data) || '(empty page)', 3000)}`;
        },
      },
      {
        name: 'inspect_page_structure',
        description: 'Show a page\'s BLOCK TREE (types, ids, short text, props) — not just its flat text. Use before editing blocks.',
        args: '{"pageId": string}',
        schema: obj({pageId: str('The page id.')}, ['pageId']),
        run: async (args) => {
          const page = await this.store.getPage(String(args.pageId ?? ''));
          if (!page) return 'Page not found.';
          const lines = blockTree(page.data);
          return lines.length ? lines.join('\n') : '(empty document)';
        },
      },
      {
        name: 'get_kit_values',
        description: 'Read the named reactive input values (the inputScope) published by a page\'s artifact-kit blocks.',
        args: '{"pageId": string}',
        schema: obj({pageId: str('The page id.')}, ['pageId']),
        run: async (args) => {
          const page = await this.store.getPage(String(args.pageId ?? ''));
          if (!page) return 'Page not found.';
          const scope = kitValues(page.data);
          const keys = Object.keys(scope);
          if (keys.length === 0) return 'This page publishes no named kit values.';
          return keys.map((k) => `- ${k} = ${JSON.stringify(scope[k])}`).join('\n');
        },
      },
      {
        name: 'list_db_views',
        description: 'List the views of the database hosted on a page (id, name, type, group-by).',
        args: '{"pageId": string}',
        schema: obj({pageId: str('The page hosting the database.')}, ['pageId']),
        run: async (args) => {
          const db = await this.store.getDatabaseByPage(String(args.pageId ?? ''));
          if (!db) return 'That page hosts no database.';
          const views = db.schema.views ?? [];
          if (views.length === 0) return `Database "${db.name ?? 'Untitled'}" has no views.`;
          return views
            .map((v) => `- [${v.id}] ${v.name} (${v.type}${v.groupByPropertyId ? `, grouped by ${v.groupByPropertyId}` : ''})`)
            .join('\n');
        },
      },
      {
        name: 'get_db_row',
        description: 'Read one database row by id: its title, manual property values, and exported cell values.',
        args: '{"pageId": string, "rowId": string}',
        schema: obj({pageId: str('The page hosting the database.'), rowId: str('The row (page) id.')}, ['pageId', 'rowId']),
        run: async (args) => {
          const db = await this.store.getDatabaseByPage(String(args.pageId ?? ''));
          if (!db) return 'That page hosts no database.';
          const rows = await this.store.listRows(db.id);
          const row = rows.find((r) => r.id === String(args.rowId ?? ''));
          if (!row) return 'Row not found in this database.';
          return [
            `Title: ${row.name ?? 'Untitled'}`,
            `Properties: ${JSON.stringify(row.properties)}`,
            `Exports: ${JSON.stringify(row.exports)}`,
          ].join('\n');
        },
      },
      {
        name: 'describe_database',
        description:
          'Describe the database hosted on a page: every column (id, name, type, and select options) plus its rows (id + title). Call this before creating or updating rows/columns so you use the right ids.',
        args: '{"pageId": string}',
        schema: obj({pageId: str('The page hosting the database.')}, ['pageId']),
        run: async (args) => {
          const db = await this.store.getDatabaseByPage(String(args.pageId ?? ''));
          if (!db) return 'That page hosts no database.';
          const props = (db.schema.properties ?? []).map((p) => {
            const opts = p.options?.length ? ` options=[${p.options.map((o) => `${o.id}:${o.label}`).join(', ')}]` : '';
            return `  - [${p.id}] ${p.name} (${p.type})${opts}`;
          });
          const rows = await this.store.listRows(db.id);
          const rowLines = rows.slice(0, 40).map((r) => `  - [${r.id}] ${r.name ?? 'Untitled'}`);
          return [
            `Database "${db.name ?? 'Untitled'}" (database id ${db.id}).`,
            'Columns:',
            ...(props.length ? props : ['  (none)']),
            `Rows (${rows.length}):`,
            ...(rowLines.length ? rowLines : ['  (none)']),
          ].join('\n');
        },
      },
    ];
  }

  // ── Database tools (structural CRUD — applied directly, like create_page) ─────

  /**
   * Tools that create and edit databases, their columns, and their rows. Unlike
   * the document write tools (which persist reviewable suggestions), these are
   * structural store operations with no inline-suggestion representation, so —
   * like `create_page` — they apply immediately. Rows/columns are always
   * addressed by their host **page id** (the same handle the read tools use), and
   * cell values may be given by column id or name (and select values by option
   * label) — they are resolved against the live schema before writing.
   */
  private databaseTools(): ToolDef[] {
    /** Resolve the database hosted on a page, or null with a message. */
    const dbForPage = async (pageId: string): Promise<{db: Awaited<ReturnType<PageStore['getDatabaseByPage']>>; err?: string}> => {
      const db = await this.store.getDatabaseByPage(pageId);
      return db ? {db} : {db: null, err: 'That page hosts no database.'};
    };
    return [
      {
        name: 'create_database',
        description:
          'Create a new database on a brand-new page, optionally seeding its columns. Applied immediately. Returns the new page id — pass it to create_row / describe_database. Add rows with create_row afterwards.',
        args: '{"title": string, "properties"?: [{"name": string, "type": string, "options"?: string[]}]}',
        schema: obj(
          {
            title: str('The database title (also the host page name; must be unique).'),
            properties: {
              type: 'array',
              description: 'Optional initial columns.',
              items: obj(
                {
                  name: str('Column name.'),
                  type: {type: 'string', enum: [...CREATABLE_PROP_TYPES], description: 'Column type.'},
                  options: {type: 'array', items: {type: 'string'}, description: 'Choices, for select / multi_select / status columns.'},
                },
                ['name', 'type'],
              ),
            },
          },
          ['title'],
        ),
        run: async (args) => {
          const title = String(args.title ?? '').trim();
          if (!title) return 'A title is required.';
          const specs = Array.isArray(args.properties) ? args.properties : [];
          const properties = specs.map((s) => buildProperty(s as Record<string, unknown>)).filter((p): p is DatabaseProperty => p !== null);
          const schema: DatabaseSchema = {
            properties,
            views: [{id: shortId('v'), name: 'Table', type: 'table', filters: [], sorts: []}],
          };
          try {
            const page = await this.store.upsertPage({name: title, data: textSnapshot('', 'agent')});
            await this.store.createDatabase({pageId: page.id, name: title, schema});
            this.pagesTouched = true;
            const cols = properties.length ? ` Columns: ${properties.map((p) => `${p.name} [${p.id}]`).join(', ')}.` : '';
            return `Created database "${title}" on page ${page.id}.${cols} Use pageId ${page.id} to add rows (create_row) or columns (create_property).`;
          } catch (err) {
            return `Could not create the database: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
      {
        name: 'update_database',
        description: 'Rename an existing database (found by its host page id). Applied immediately.',
        args: '{"pageId": string, "name": string}',
        schema: obj({pageId: str('The page hosting the database.'), name: str('The new database name.')}, ['pageId', 'name']),
        run: async (args) => {
          const {db, err} = await dbForPage(String(args.pageId ?? ''));
          if (!db) return err!;
          const name = String(args.name ?? '').trim();
          if (!name) return 'A name is required.';
          await this.store.updateDatabase(db.id, {name});
          return `Renamed the database to "${name}".`;
        },
      },
      {
        name: 'create_property',
        description: 'Add a column to a database. Applied immediately. Returns the new column id.',
        args: '{"pageId": string, "name": string, "type": string, "options"?: string[]}',
        schema: obj(
          {
            pageId: str('The page hosting the database.'),
            name: str('Column name.'),
            type: {type: 'string', enum: [...CREATABLE_PROP_TYPES], description: 'Column type.'},
            options: {type: 'array', items: {type: 'string'}, description: 'Choices, for select / multi_select / status columns.'},
          },
          ['pageId', 'name', 'type'],
        ),
        run: async (args) => {
          const {db, err} = await dbForPage(String(args.pageId ?? ''));
          if (!db) return err!;
          const prop = buildProperty(args);
          if (!prop) return `Unsupported column type "${String(args.type)}". Use one of: ${[...CREATABLE_PROP_TYPES].join(', ')}.`;
          const schema: DatabaseSchema = {...db.schema, properties: [...(db.schema.properties ?? []), prop]};
          await this.store.updateDatabase(db.id, {schema});
          return `Added column "${prop.name}" [${prop.id}] (${prop.type}) to "${db.name ?? 'Untitled'}".`;
        },
      },
      {
        name: 'update_property',
        description: 'Rename a column and/or replace its choices (select / multi_select / status). Applied immediately. Find the column id via describe_database.',
        args: '{"pageId": string, "propertyId": string, "name"?: string, "options"?: string[]}',
        schema: obj(
          {
            pageId: str('The page hosting the database.'),
            propertyId: str('The column id (from describe_database).'),
            name: str('A new name for the column.'),
            options: {type: 'array', items: {type: 'string'}, description: 'Replacement choices (existing option ids are kept where labels match).'},
          },
          ['pageId', 'propertyId'],
        ),
        run: async (args) => {
          const {db, err} = await dbForPage(String(args.pageId ?? ''));
          if (!db) return err!;
          const propId = String(args.propertyId ?? '');
          const props = db.schema.properties ?? [];
          const idx = props.findIndex((p) => p.id === propId);
          if (idx === -1) return `No column "${propId}" on this database — use describe_database.`;
          const next: DatabaseProperty = {...props[idx]};
          const name = args.name === undefined ? '' : String(args.name).trim();
          if (name) next.name = name;
          if (Array.isArray(args.options)) next.options = buildOptions(args.options, next.options ?? []);
          if (!name && !Array.isArray(args.options)) return 'Nothing to update — pass a new name and/or options.';
          const schema: DatabaseSchema = {...db.schema, properties: props.map((p, i) => (i === idx ? next : p))};
          await this.store.updateDatabase(db.id, {schema});
          return `Updated column "${next.name}" [${next.id}].`;
        },
      },
      {
        name: 'create_row',
        description:
          'Add a row to a database. Cell values may be keyed by column id or name, and select/status values may be the option label. Applied immediately. Returns the new row id.',
        args: '{"pageId": string, "name"?: string, "properties"?: object}',
        schema: obj(
          {
            pageId: str('The page hosting the database.'),
            name: str('The row title.'),
            properties: {type: 'object', description: 'Cell values keyed by column id or name.'},
          },
          ['pageId'],
        ),
        run: async (args) => {
          const {db, err} = await dbForPage(String(args.pageId ?? ''));
          if (!db) return err!;
          const name = args.name === undefined ? null : String(args.name);
          const input = args.properties && typeof args.properties === 'object' ? (args.properties as Record<string, unknown>) : {};
          const {values, unknown} = resolveRowValues(db.schema, input);
          try {
            const row = await this.store.createRow(db.id, {name, properties: values});
            const warn = unknown.length ? ` (ignored unknown column(s): ${unknown.join(', ')})` : '';
            return `Added row "${name ?? 'Untitled'}" [${row.id}] to "${db.name ?? 'Untitled'}".${warn}`;
          } catch (e) {
            return `Could not add the row: ${e instanceof Error ? e.message : String(e)}`;
          }
        },
      },
      {
        name: 'update_row',
        description:
          'Update a row\'s title and/or cell values (keyed by column id or name; select values may be option labels). Other cells are left untouched. Applied immediately. Find row ids via describe_database.',
        args: '{"pageId": string, "rowId": string, "name"?: string, "properties"?: object}',
        schema: obj(
          {
            pageId: str('The page hosting the database.'),
            rowId: str('The row (page) id, from describe_database.'),
            name: str('A new title for the row.'),
            properties: {type: 'object', description: 'Cell values to set, keyed by column id or name.'},
          },
          ['pageId', 'rowId'],
        ),
        run: async (args) => {
          const {db, err} = await dbForPage(String(args.pageId ?? ''));
          if (!db) return err!;
          const rowId = String(args.rowId ?? '');
          const rows = await this.store.listRows(db.id);
          const existing = rows.find((r) => r.id === rowId);
          if (!existing) return 'Row not found in this database.';
          const patch: {name?: string | null; properties?: Record<string, unknown>} = {};
          if (args.name !== undefined) patch.name = String(args.name);
          let warn = '';
          if (args.properties && typeof args.properties === 'object') {
            const {values, unknown} = resolveRowValues(db.schema, args.properties as Record<string, unknown>);
            patch.properties = {...existing.properties, ...values};
            if (unknown.length) warn = ` (ignored unknown column(s): ${unknown.join(', ')})`;
          }
          if (patch.name === undefined && patch.properties === undefined) return 'Nothing to update — pass a name and/or properties.';
          const updated = await this.store.updateRow(db.id, rowId, patch);
          return updated ? `Updated row "${updated.name ?? 'Untitled'}".${warn}` : 'Could not update the row.';
        },
      },
    ];
  }

  // ── Write tools (all enqueue proposals — never mutate directly) ───────────────

  private writeTools(): ToolDef[] {
    return [
      {
        name: 'create_page',
        description: 'Create a new page with a title and optional text content (one paragraph per line). Applied immediately (creation is low-risk).',
        args: '{"title": string, "content"?: string}',
        schema: obj({title: str('The page title (must be unique).'), content: str('Optional plain-text body.')}, ['title']),
        write: false, // creation is non-destructive — keep it immediate like before
        run: async (args) => {
          const title = String(args.title ?? '').trim();
          if (!title) return 'A title is required.';
          try {
            const page = await this.store.upsertPage({name: title, data: textSnapshot(String(args.content ?? ''), 'agent')});
            this.pagesTouched = true;
            return `Created page "${title}" with id ${page.id}.`;
          } catch (err) {
            return `Could not create the page: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
      {
        name: 'append_to_page',
        description: 'Propose appending text to an existing page (one paragraph per line). The user approves before it is applied.',
        args: '{"pageId": string, "content": string}',
        schema: obj({pageId: str('The page id.'), content: str('Plain text to append.')}, ['pageId', 'content']),
        write: true,
        run: async (args) => {
          const pageId = String(args.pageId ?? '');
          const content = String(args.content ?? '');
          const page = await this.store.getPage(pageId);
          if (!page) return 'Page not found.';
          if (!content.trim()) return 'Nothing to append.';
          return this.propose({
            kind: 'append_blocks',
            summary: `Append ${content.split('\n').filter(Boolean).length} paragraph(s) to "${page.name ?? 'Untitled'}"`,
            pageId,
            after: clip(content, 200),
            payload: {pageId, blocks: content.split('\n').map((l) => l.trim()).filter(Boolean).map((t) => ({type: 'paragraph', text: t}))},
          });
        },
      },
      {
        name: 'update_block',
        description: 'Propose replacing the text of one block on a page (find the block id via inspect_page_structure). User approves first.',
        args: '{"pageId": string, "blockId": string, "text": string}',
        schema: obj({pageId: str('The page id.'), blockId: str('The block id from inspect_page_structure.'), text: str('The new plain text for the block.')}, ['pageId', 'blockId', 'text']),
        write: true,
        run: async (args) => {
          const pageId = String(args.pageId ?? '');
          const blockId = String(args.blockId ?? '');
          const text = String(args.text ?? '');
          const page = await this.store.getPage(pageId);
          if (!page) return 'Page not found.';
          const before = blockTextById(page.data, blockId);
          if (before === null) return `No block "${blockId}" on that page — use inspect_page_structure.`;
          return this.propose({
            kind: 'update_block',
            summary: `Edit block ${blockId} on "${page.name ?? 'Untitled'}"`,
            pageId,
            before: clip(before, 200),
            after: clip(text, 200),
            // The full prior text (not the clipped diff `before`) is the merge
            // base, so accepting this alongside another edit to the same block
            // combines them instead of clobbering. See the bridge's update_block.
            payload: {pageId, blockId, text, before},
          });
        },
      },
      {
        name: 'update_block_props',
        description:
          'Propose changing a block\'s TYPE and/or its props — e.g. heading level, list kind, todo checked, callout variant, code language, or an input\'s value/min/max/options. Use update_block for the TEXT, this for the format/type. Find the block id, current type, and props via inspect_page_structure. User approves first.',
        args: '{"pageId": string, "blockId": string, "type"?: string, "props"?: object}',
        schema: obj(
          {
            pageId: str('The page id.'),
            blockId: str('The block id from inspect_page_structure.'),
            type: {type: 'string', description: 'Optional new block type (e.g. heading, list, todo, callout). Omit to keep the current type.'},
            props: {
              type: 'object',
              description: 'Props to merge, e.g. {"level":2} / {"kind":"number"} / {"checked":true} / {"variant":"warn"} / {"language":"python"} / {"min":0,"max":100,"value":40}.',
            },
          },
          ['pageId', 'blockId'],
        ),
        write: true,
        run: async (args) => {
          const pageId = String(args.pageId ?? '');
          const blockId = String(args.blockId ?? '');
          const page = await this.store.getPage(pageId);
          if (!page) return 'Page not found.';
          const info = blockInfoById(page.data, blockId);
          if (!info) return `No block "${blockId}" on that page — use inspect_page_structure.`;
          const type = typeof args.type === 'string' && args.type.trim() ? args.type.trim() : undefined;
          if (type && !KNOWN_BLOCK_TYPES.has(type)) return `Unsupported block type "${type}". Allowed: ${[...KNOWN_BLOCK_TYPES].join(', ')}.`;
          const props = args.props && typeof args.props === 'object' && !Array.isArray(args.props) ? (args.props as Record<string, unknown>) : undefined;
          if (!type && !props) return 'Provide a new type and/or props to change.';
          const describe = (t: string, p: Record<string, unknown>): string =>
            `${t}${Object.keys(p).length ? ` ${JSON.stringify(p)}` : ''}`;
          return this.propose({
            kind: 'set_block_props',
            summary: `Update block ${blockId} on "${page.name ?? 'Untitled'}"${type ? ` → ${type}` : ''}`,
            pageId,
            before: clip(describe(info.type, info.props), 200),
            after: clip(describe(type ?? info.type, {...info.props, ...(props ?? {})}), 200),
            payload: {pageId, blockId, ...(type ? {type} : {}), ...(props ? {props} : {})},
          });
        },
      },
      {
        name: 'delete_block',
        description: 'Propose removing one block from a page (find its id via inspect_page_structure). The user approves first.',
        args: '{"pageId": string, "blockId": string}',
        schema: obj({pageId: str('The page id.'), blockId: str('The block id from inspect_page_structure.')}, ['pageId', 'blockId']),
        write: true,
        run: async (args) => {
          const pageId = String(args.pageId ?? '');
          const blockId = String(args.blockId ?? '');
          const page = await this.store.getPage(pageId);
          if (!page) return 'Page not found.';
          const before = blockTextById(page.data, blockId);
          if (before === null) return `No block "${blockId}" on that page — use inspect_page_structure.`;
          return this.propose({
            kind: 'delete_block',
            summary: `Delete block ${blockId} on "${page.name ?? 'Untitled'}"`,
            pageId,
            before: clip(before || '(non-text block)', 200),
            after: '',
            payload: {pageId, blockId},
          });
        },
      },
      {
        name: 'set_kit_value',
        description: 'Propose setting a named reactive input on a page (slider/number/toggle/textfield/radio/dropdown/checklist). Find names via get_kit_values. User approves first.',
        args: '{"pageId": string, "name": string, "value": any}',
        schema: obj({pageId: str('The page id.'), name: str('The published input name (from get_kit_values).'), value: {description: 'The new value (number/string/boolean/array).'}}, ['pageId', 'name', 'value']),
        write: true,
        run: async (args) => {
          const pageId = String(args.pageId ?? '');
          const name = String(args.name ?? '');
          const value = args.value;
          const page = await this.store.getPage(pageId);
          if (!page) return 'Page not found.';
          const scope = kitValues(page.data);
          if (!(name in scope)) return `No input named "${name}" on that page — use get_kit_values.`;
          return this.propose({
            kind: 'set_kit_value',
            summary: `Set "${name}" = ${JSON.stringify(value)}`,
            pageId,
            before: JSON.stringify(scope[name]),
            after: JSON.stringify(value),
            payload: {pageId, name, value},
          });
        },
      },
      {
        name: 'set_db_cell',
        description: 'Propose setting a manual property value on a database row (by property id). User approves first.',
        args: '{"pageId": string, "rowId": string, "propertyId": string, "value": any}',
        schema: obj(
          {
            pageId: str('The page hosting the database.'),
            rowId: str('The row (page) id.'),
            propertyId: str('The property id to set.'),
            value: {description: 'The new cell value.'},
          },
          ['pageId', 'rowId', 'propertyId', 'value'],
        ),
        write: true,
        run: async (args) => {
          const pageId = String(args.pageId ?? '');
          const rowId = String(args.rowId ?? '');
          const propertyId = String(args.propertyId ?? '');
          const value = args.value;
          const db = await this.store.getDatabaseByPage(pageId);
          if (!db) return 'That page hosts no database.';
          const rows = await this.store.listRows(db.id);
          const row = rows.find((r) => r.id === rowId);
          if (!row) return 'Row not found in this database.';
          const prop = (db.schema.properties ?? []).find((p) => p.id === propertyId);
          if (!prop) return `No property "${propertyId}" on this database — use list_db_views/get_db_row.`;
          return this.propose({
            kind: 'set_db_cell',
            summary: `Set ${prop.name} = ${JSON.stringify(value)} on "${row.name ?? 'Untitled'}"`,
            pageId,
            before: JSON.stringify(row.properties[propertyId] ?? null),
            after: JSON.stringify(value),
            payload: {databaseId: db.id, rowId, propertyId, value},
          });
        },
      },
    ];
  }

  // ── Layout / rich-block + appearance tools ───────────────────────────────────

  /**
   * Tools for building rich pages: `add_blocks` proposes interactive kit inputs,
   * layout containers, charts, and headings (any block the editor supports), and
   * `set_page_appearance` proposes a per-page theme. Both go through review like
   * the other document write tools — the rich blocks are appended to the page
   * (the bridge builds them, nested children and all) when the user accepts.
   */
  private layoutTools(): ToolDef[] {
    const blockSchema = obj(
      {
        type: {type: 'string', description: 'Block type — see the catalogue in this tool\'s description.'},
        text: {description: 'For text blocks: a plain string, or rich runs like [{"t":"bold","a":{"b":true}}].'},
        props: {type: 'object', description: 'Type-specific props (level, value, min/max, opts, source, …).'},
        children: {type: 'array', items: {type: 'object'}, description: 'Child blocks, for containers (columns/column/group/accordion/tabs).'},
      },
      ['type'],
    );
    return [
      {
        name: 'add_blocks',
        description: BLOCK_CATALOGUE,
        args: '{"pageId": string, "blocks": Block[]}',
        schema: obj(
          {
            pageId: str('The page to add the blocks to.'),
            blocks: {type: 'array', items: blockSchema, description: 'The blocks to append, in order.'},
          },
          ['pageId', 'blocks'],
        ),
        write: true,
        run: async (args) => {
          const pageId = String(args.pageId ?? '');
          const page = await this.store.getPage(pageId);
          if (!page) return 'Page not found.';
          const blocks = Array.isArray(args.blocks) ? (args.blocks as unknown[]) : [];
          if (blocks.length === 0) return 'No blocks to add.';
          const bad = invalidBlockType(blocks);
          if (bad) return `Unsupported block type "${bad}". Allowed: ${[...KNOWN_BLOCK_TYPES].join(', ')}.`;
          return this.propose({
            kind: 'append_blocks',
            summary: `Add ${blocks.length} block(s) to "${page.name ?? 'Untitled'}": ${summarizeBlocks(blocks)}`,
            pageId,
            after: summarizeBlocks(blocks),
            payload: {pageId, blocks},
          });
        },
      },
      {
        name: 'set_page_appearance',
        description:
          'Propose a per-page theme: accent palette, canvas tint, control/interface intensity, tinted sidebar, and an optional gradient cover banner. User approves first.',
        args: '{"pageId": string, "themeId"?: string, "background"?: string, "controlIntensity"?: 0-3, "interfaceIntensity"?: 0-3, "tintedSidebar"?: boolean, "cover"?: string}',
        schema: obj(
          {
            pageId: str('The page to restyle.'),
            themeId: {type: 'string', enum: [...THEME_IDS], description: 'Accent palette.'},
            background: {type: 'string', enum: [...BACKGROUND_TOKENS], description: 'Page canvas tint.'},
            controlIntensity: {type: 'integer', minimum: 0, maximum: 3, description: 'How colourful controls are (0–3).'},
            interfaceIntensity: {type: 'integer', minimum: 0, maximum: 3, description: 'How saturated neutral surfaces are (0–3).'},
            tintedSidebar: {type: 'boolean', description: 'Whether the sidebar adopts the accent hue.'},
            cover: {type: 'string', enum: [...COVER_GRADIENT_IDS], description: 'A gradient cover banner.'},
          },
          ['pageId'],
        ),
        write: true,
        run: async (args) => {
          const pageId = String(args.pageId ?? '');
          const page = await this.store.getPage(pageId);
          if (!page) return 'Page not found.';
          const theme: Record<string, unknown> = {};
          if (typeof args.themeId === 'string' && THEME_IDS.has(args.themeId)) theme.themeId = args.themeId;
          if (typeof args.background === 'string' && BACKGROUND_TOKENS.has(args.background)) theme.background = args.background;
          if (typeof args.tintedSidebar === 'boolean') theme.tintedSidebar = args.tintedSidebar;
          const level = (v: unknown): number | undefined => {
            const n = Math.round(Number(v));
            return Number.isFinite(n) && n >= 0 && n <= 3 ? n : undefined;
          };
          if (level(args.controlIntensity) !== undefined) theme.controlIntensity = level(args.controlIntensity);
          if (level(args.interfaceIntensity) !== undefined) theme.interfaceIntensity = level(args.interfaceIntensity);
          const coverGradientId =
            typeof args.cover === 'string' && COVER_GRADIENT_IDS.has(args.cover) ? args.cover : undefined;
          if (Object.keys(theme).length === 0 && !coverGradientId) {
            return `Nothing to set. Themes: ${[...THEME_IDS].join(', ')}. Backgrounds: ${[...BACKGROUND_TOKENS].join(', ')}. Covers: ${[...COVER_GRADIENT_IDS].join(', ')}.`;
          }
          const parts = [
            ...Object.entries(theme).map(([k, v]) => `${k}=${v}`),
            ...(coverGradientId ? [`cover=${coverGradientId}`] : []),
          ];
          return this.propose({
            kind: 'set_page_theme',
            summary: `Restyle "${page.name ?? 'Untitled'}": ${parts.join(', ')}`,
            pageId,
            after: parts.join(', '),
            payload: {pageId, ...(Object.keys(theme).length ? {theme} : {}), ...(coverGradientId ? {coverGradientId} : {})},
          });
        },
      },
    ];
  }

  // ── Page tools (workspace tree rearrangement) ────────────────────────────────

  /**
   * Rearrange pages in the sidebar tree: `move_page` reparents a page and/or
   * positions it among its siblings. A structural store operation (like
   * create_page / the database tools), so it applies immediately.
   */
  private pageTools(): ToolDef[] {
    return [
      {
        name: 'move_page',
        description:
          'Rearrange a page in the workspace tree: nest it under another page (or move it to the top level with parentId null), and/or position it among its siblings. Applied immediately. Use list_pages for ids.',
        args: '{"pageId": string, "parentId"?: string|null, "beforePageId"?: string}',
        schema: obj(
          {
            pageId: str('The page to move.'),
            parentId: {type: ['string', 'null'], description: 'New parent page id, or null for the top level. Omit to keep the current parent.'},
            beforePageId: str('Position it just before this sibling; omit to place it last among its siblings.'),
          },
          ['pageId'],
        ),
        run: async (args) => {
          const pageId = String(args.pageId ?? '');
          const page = await this.store.getPage(pageId);
          if (!page) return 'Page not found.';
          const pages = await this.store.listPages();
          if (!pages.some((p) => p.id === pageId)) return 'move_page handles workspace pages, not database rows.';
          const parentId = args.parentId === undefined ? page.parentId ?? null : args.parentId === null ? null : String(args.parentId);
          if (parentId === pageId) return 'A page cannot be its own parent.';
          if (parentId && !pages.some((p) => p.id === parentId)) return `Parent page "${parentId}" not found.`;
          // The target parent's children, in order, with the moved page inserted.
          const siblings = pages.filter((p) => (p.parentId ?? null) === parentId && p.id !== pageId).map((p) => p.id);
          const before = typeof args.beforePageId === 'string' ? args.beforePageId : '';
          const at = before ? siblings.indexOf(before) : -1;
          if (at >= 0) siblings.splice(at, 0, pageId);
          else siblings.push(pageId);
          const moved = await this.store.movePage(pageId, parentId, siblings);
          if (!moved) return 'Could not move the page (it would create a cycle — a page cannot nest under its own descendant).';
          this.pagesTouched = true;
          const where = parentId ? `under "${pages.find((p) => p.id === parentId)?.name ?? parentId}"` : 'to the top level';
          return `Moved "${page.name ?? 'Untitled'}" ${where}${before ? `, before ${before}` : ''}.`;
        },
      },
    ];
  }

  // ── Interactive tools (pause the run and wait for the user) ──────────────────

  /**
   * Tools that ask the user something and PAUSE the run: `request_edit_access`
   * (ask to apply edits directly, without the review pane) and `ask_user` (a
   * short multi-step interview). They set {@link interactive}; the run loop then
   * emits the request and stops — the user's reply arrives as their next message
   * (and, for permission, flips the sticky direct-edit flag).
   */
  private interactiveTools(): ToolDef[] {
    return [
      {
        name: 'request_edit_access',
        description:
          'Ask the user for permission to apply your edits DIRECTLY, without the review pane. Call this ONCE, before editing, when the user wants changes made for them. After they grant it, your write tools apply immediately. Skip it to keep proposing changes for review.',
        args: '{"summary"?: string}',
        schema: obj({summary: str('One line on what you want to edit (shown to the user).')}),
        write: false,
        run: async (args) => {
          if (this.directEdits) return 'You already have direct edit access — go ahead and edit.';
          if (this.interactive) return 'Already waiting on the user.';
          this.interactive = {type: 'permission_request', summary: String(args.summary ?? '').trim() || 'apply changes directly'};
          return 'Asked the user for direct edit access. Stop now and wait for their answer.';
        },
      },
      {
        name: 'ask_user',
        description:
          'Ask the user a short multi-step interview to gather the input you need before acting — each step is one question, with options to choose from and/or a typed answer. Their answers arrive as their next message. Prefer this over guessing when a request is underspecified.',
        args: '{"title"?: string, "steps": [{"question": string, "options"?: [{"label": string, "value"?: string}], "multiple"?: boolean, "freeText"?: boolean}]}',
        schema: obj(
          {
            title: str('Optional heading for the interview.'),
            steps: {
              type: 'array',
              description: 'The questions, asked one per step (1–8).',
              items: obj(
                {
                  question: str('The question to ask.'),
                  options: {
                    type: 'array',
                    description: 'Choices to pick from. Omit for a typed-only answer.',
                    items: obj({label: str('The option shown to the user.'), value: str('Optional value (defaults to the label).')}, ['label']),
                  },
                  multiple: {type: 'boolean', description: 'Allow selecting more than one option.'},
                  freeText: {type: 'boolean', description: 'Allow a typed answer too.'},
                },
                ['question'],
              ),
            },
          },
          ['steps'],
        ),
        write: false,
        run: async (args) => {
          if (this.interactive) return 'Already waiting on the user.';
          const steps = buildInterviewSteps(args.steps);
          if (steps.length === 0) return 'An interview needs at least one step with a question.';
          this.interactive = {type: 'interview', title: typeof args.title === 'string' && args.title.trim() ? args.title.trim() : undefined, steps};
          return 'Posed the interview. Stop now and wait for the user\'s answers.';
        },
      },
    ];
  }

  // ── Plugin-contributed tools ──────────────────────────────────────────────────

  private pluginToolDefs(): ToolDef[] {
    const tools = this.options.pluginTools ?? [];
    return tools.map((tool) => ({
      name: tool.name,
      description: `${tool.description} (plugin tool)`,
      args: JSON.stringify(tool.parameters?.properties ?? {}),
      schema: tool.parameters ?? obj({}),
      write: tool.action === 'append_blocks',
      run: async (args) => {
        if (tool.action === 'prompt') {
          return tool.instructions ?? '(this plugin tool contributes no instructions)';
        }
        // append_blocks: enqueue a proposal from the plugin's blocks/args.
        const pageId = String(args.pageId ?? '');
        const blocks = Array.isArray(args.blocks) ? args.blocks : [];
        const page = await this.store.getPage(pageId);
        if (!page) return 'Page not found (the plugin tool needs a valid pageId).';
        if (blocks.length === 0) return 'The plugin tool produced no blocks.';
        return this.propose({
          kind: 'append_blocks',
          summary: `${tool.name}: add ${blocks.length} block(s) to "${page.name ?? 'Untitled'}"`,
          pageId,
          payload: {pageId, blocks},
        });
      },
    }));
  }

  /**
   * Route a write tool's change. With direct edit access granted
   * (request_edit_access), collect it to apply immediately at the end of the run
   * (an `apply` event the client replays through the editor bridge); otherwise
   * persist it as a reviewable suggestion — the default, nothing applied without
   * the user's approval.
   */
  private async propose(proposal: Omit<AgentProposal, 'id'>): Promise<string> {
    if (this.directEdits) {
      const pageId = proposal.pageId ?? String(proposal.payload.pageId ?? '');
      if (!pageId) return 'No target page for the edit.';
      this.pendingApply.push({...proposal, id: shortId('chg')});
      return `Applying directly (you granted edit access): ${proposal.summary}. Do not repeat it; continue or answer.`;
    }
    return this.enqueue(proposal);
  }

  /**
   * Persist a write tool's change as a SUGGESTION (proposed, not applied) and
   * return the message the model sees as the tool result. The suggestion's
   * `payload` carries the original write-tool kind as `applyKind` so the editor
   * bridge replays it unchanged when a human accepts it.
   */
  private async enqueue(proposal: Omit<AgentProposal, 'id'>): Promise<string> {
    const pageId = proposal.pageId ?? String(proposal.payload.pageId ?? '');
    if (!pageId) return 'Could not record the suggestion: no target page.';
    try {
      const suggestion = await this.store.createSuggestion({
        pageId,
        authorKind: 'ai',
        authorName: AI_AUTHOR_NAME,
        kind: SUGGESTION_KIND[proposal.kind],
        target: this.suggestionTarget(proposal),
        before: proposal.before ?? '',
        after: proposal.after ?? '',
        payload: {...proposal.payload, applyKind: proposal.kind, summary: proposal.summary},
      });
      this.suggestions.push(suggestion);
      return `SUGGESTED for review (not applied): ${proposal.summary}. Do not call it again; continue or answer.`;
    } catch (err) {
      return `Could not record the suggestion: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Derive a suggestion's structured target from a write-tool proposal. */
  private suggestionTarget(proposal: Omit<AgentProposal, 'id'>): StoredSuggestion['target'] {
    const p = proposal.payload;
    if (proposal.kind === 'update_block' || proposal.kind === 'delete_block' || proposal.kind === 'set_block_props') {
      return {blockId: String(p.blockId ?? '')};
    }
    if (proposal.kind === 'set_db_cell') {
      return {databaseId: String(p.databaseId ?? ''), rowId: String(p.rowId ?? ''), propertyId: String(p.propertyId ?? '')};
    }
    if (proposal.kind === 'set_kit_value') return {blockId: undefined};
    return {}; // append_blocks: appended at the document end
  }

  // ── Prompt ────────────────────────────────────────────────────────────────────

  private systemPrompt(useNative: boolean): string {
    const catalogue = this.tools
      .map((t) => `- ${t.name}${t.args === '{}' ? '' : ` args ${t.args}`}: ${t.description}`)
      .join('\n');
    const lines = [
      'You are the OpenBook assistant. You work inside the user\'s private note workspace and help them find, read, edit, and organise their notes and databases.',
      'You have TOOLS to search and read pages, to propose edits, and to build databases. Use a tool to get facts from the workspace — never invent note contents, page titles, database columns, or ids.',
      'Two kinds of change: edits to existing note text, inputs, blocks, and cells (update_block for text, update_block_props for a block\'s type/format, delete_block, append_to_page, add_blocks, set_kit_value, set_db_cell) are PROPOSED for the user to review and approve. Structural actions — creating pages, rearranging pages in the tree (move_page), creating databases, adding rows, and adding or editing database columns — APPLY IMMEDIATELY, so do them deliberately and only when asked.',
      this.directEdits
        ? 'The user has GRANTED you DIRECT EDIT ACCESS this conversation, so those edit tools now apply IMMEDIATELY (no review) — make changes confidently, and remove blocks with delete_block when asked.'
        : 'If the user wants you to make edits FOR them (rather than just suggestions to review), call request_edit_access ONCE to ask permission to apply edits directly; otherwise your edits are queued for their review.',
      'When a request is underspecified — missing details, or with several reasonable directions — call ask_user to run a short multi-step interview (questions with options and/or typed answers) instead of guessing. Their answers come back as their next message.',
      'When building a database, work in order: create_database → describe_database (to learn the column ids) → create_property for any extra columns → create_row for each row. Reference rows and columns by the ids the tools return.',
      'To build rich, interactive pages, use add_blocks: it appends headings, interactive inputs (sliders, toggles, dropdowns, choice cards…), charts, and layout containers (columns/groups/accordions/tabs with nested children). Give each input a name or label, and have charts/status lights reference those names in their source expression. Use set_page_appearance to theme a page (accent, background tint, cover banner).',
      'Format replies in Markdown — use headings, bullet/numbered lists, **bold**, `code`, links, and tables where they make the answer clearer. Keep replies specific and grounded in what the tools return.',
    ];
    // Ambient context: the page the user is viewing + their selection, so replies
    // are grounded in what they're looking at without spending a tool call.
    const ctx = this.options.context;
    if (ctx && (ctx.pageText || ctx.selection)) {
      lines.push('', '── Current context (what the user is looking at) ──');
      if (ctx.pageText) {
        lines.push(`The user is viewing the page "${ctx.pageTitle ?? 'Untitled'}"${ctx.pageId ? ` (id ${ctx.pageId})` : ''}:`, ctx.pageText);
      }
      if (ctx.selection) lines.push('', `The user's current selection:\n${ctx.selection}`);
      lines.push('── End context ──');
    }
    const skills = this.options.skills ?? [];
    if (skills.length > 0) {
      lines.push('', 'Available skills (recipes you may follow):');
      for (const s of skills) lines.push(`### skill: ${s.name} — ${s.description}\n${s.instructions}`);
    }
    if (!useNative) {
      lines.push(
        '',
        'TOOLS YOU CAN CALL:',
        catalogue,
        '',
        'Reply in exactly two sections every turn:',
        SCRATCHPAD_INSTRUCTION,
        'The "### answer" section must contain EXACTLY ONE JSON object and nothing else — one of:',
        '  {"tool": "<tool name>", "args": { ... }}   — to run a tool',
        '  {"final": "<your reply to the user, in Markdown>"}   — when you are finished',
        '',
        'RULES:',
        '- For any question about the notes or workspace, call search_notes (or read_page) BEFORE answering. Do not guess what a note says.',
        '- Use ONE tool per turn. A line starting "TOOL RESULT" gives you what it returned; then write your next reasoning + answer.',
        '- As soon as the results let you answer, reply with {"final": ...} and stop calling tools.',
        '- "args" must be valid JSON using only the argument names listed above. Never wrap the JSON in markdown or code fences.',
        '',
        'EXAMPLE turn (call a tool):',
        '### reasoning',
        'They\'re asking about onboarding notes, so I should search first.',
        '### answer',
        '{"tool": "search_notes", "args": {"query": "onboarding"}}',
        '',
        'EXAMPLE turn (ready to answer):',
        '### reasoning',
        'The search returned the onboarding page and it has what I need.',
        '### answer',
        '{"final": "Your onboarding note lists three steps: invite the user, set up SSO, and book a welcome call."}',
      );
    } else {
      lines.push(
        '',
        'Use the provided tools to ground your work: search or read the workspace before answering questions about the notes, use the document write tools to PROPOSE edits (the user approves those), and use the database tools to build/edit databases (those apply directly).',
        'Call one tool at a time. When you have enough information, stop and reply with a clear, well-structured answer in Markdown.',
      );
    }
    return lines.join('\n');
  }

  /** Serialize the conversation for single-prompt engines. */
  private transcript(messages: AgentMessage[], toolTrace: string[]): string {
    const turns = messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`);
    return [...turns, ...toolTrace].join('\n');
  }

  private nativeTools(): NativeTool[] {
    return this.tools.map((t) => ({name: t.name, description: t.description, parameters: t.schema}));
  }

  /** Extract the first JSON object from a (possibly chatty/fenced) reply. */
  static parseAction(raw: string): {tool?: string; args?: Record<string, unknown>; final?: string} | null {
    const start = raw.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    for (let i = start; i < raw.length; i += 1) {
      const ch = raw[i];
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(raw.slice(start, i + 1)) as never;
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  // ── Run loop ────────────────────────────────────────────────────────────────

  async run(messages: AgentMessage[], emit: (event: AgentEvent) => void | Promise<void>): Promise<void> {
    const {maxSteps, maxTokens, temperature, thinkingBudget} = effortProfile(this.options.effort);
    const showThinking = this.options.thinking !== false;
    const toolTrace: string[] = [];
    this.suggestions = [];
    this.pendingApply = [];
    this.interactive = null;
    this.pagesTouched = false;

    // Resolve the engine for this run — the configured default, or a transient
    // engine for a per-conversation provider/model override. A bad key / off
    // provider surfaces as an error event (not a thrown rejection).
    let engine: AiEngine;
    let transient = false;
    try {
      const resolved = await this.ai.engineForRequest(this.options.engineOverride);
      engine = resolved.engine;
      transient = resolved.transient;
    } catch (err) {
      await emit({type: 'error', error: err instanceof Error ? err.message : String(err)});
      return;
    }

    // Prefer native tool-calling when the endpoint advertises it; fall back to
    // the JSON protocol on any failure. Streaming the answer live only makes
    // sense on the native path — there the final answer is plain text/Markdown,
    // whereas the JSON-protocol answer is a `{"final": …}` object surfaced once.
    let useNative = false;
    try {
      useNative = engine.supportsTools ? await engine.supportsTools() : false;
    } catch {
      useNative = false;
    }
    const streaming = useNative;

    // Serialize emissions: token writes are fired (not awaited) from the engine's
    // synchronous onToken, so chain every emit to preserve SSE frame order.
    let emitChain: Promise<void> = Promise.resolve();
    const emitSeq = (event: AgentEvent): Promise<void> => {
      emitChain = emitChain.then(() => emit(event)).catch(() => undefined);
      return emitChain;
    };

    const runTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const tool = this.tools.find((t) => t.name === name);
      if (!tool) return `unknown tool "${name}". Use one of: ${this.tools.map((t) => t.name).join(', ')}.`;
      await emitSeq({type: 'tool', name: tool.name, args});
      let result: string;
      try {
        result = await tool.run(args);
      } catch (err) {
        result = `Tool failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      await emitSeq({type: 'tool_result', name: tool.name, result: clip(result, 400)});
      return result;
    };

    // Flush whatever changes the write tools produced this run: directly-applied
    // edits (the user granted access) as one `apply`, reviewable ones as `suggestions`.
    const flushChanges = async (): Promise<void> => {
      if (this.pendingApply.length > 0) await emitSeq({type: 'apply', proposals: this.pendingApply});
      if (this.suggestions.length > 0) await emitSeq({type: 'suggestions', suggestions: this.suggestions});
    };

    const finish = async (text: string): Promise<void> => {
      await flushChanges();
      await emitSeq({type: 'final', text: text.trim()});
    };

    // An interactive tool asked the user something — flush any changes so far,
    // emit the request, and end the turn (the user replies via their next message).
    const pause = async (): Promise<void> => {
      await flushChanges();
      if (this.interactive) await emitSeq(this.interactive);
    };

    try {
      for (let step = 0; step < maxSteps; step += 1) {
        const calls: NativeToolCall[] = [];
        // When streaming, route tokens live: answer text → `token` events,
        // reasoning (think tags / scratchpad) → `reasoning` events. The splitter
        // is a streaming state machine, so split markers spanning chunks are safe.
        const splitter = streaming
          ? new ReasoningSplitter(
            (text) => {
              if (text) void emitSeq({type: 'token', text});
            },
            (text) => {
              if (showThinking && text) void emitSeq({type: 'reasoning', text});
            },
          )
          : null;
        const genOpts = {
          system: this.systemPrompt(useNative),
          maxTokens,
          temperature,
          thinkingBudget,
          effort: this.options.effort,
          ...(useNative ? {tools: this.nativeTools(), onToolCalls: (c: NativeToolCall[]) => calls.push(...c)} : {}),
          onToken: splitter ? (token: string) => splitter.push(token) : () => undefined,
        };
        const raw = await engine.generate(this.transcript(messages, toolTrace), genOpts);
        splitter?.flush();
        const {answer, reasoning} = splitReasoning(raw);
        // Non-streaming path surfaces reasoning once, after the turn (the
        // streaming path already emitted it incrementally above).
        if (!streaming && showThinking && reasoning) await emitSeq({type: 'reasoning', text: reasoning});

        // Native path: the model emitted structured tool calls.
        if (useNative && calls.length > 0) {
          for (const call of calls) {
            const result = await runTool(call.name, call.args);
            toolTrace.push(`Assistant: ${JSON.stringify({tool: call.name, args: call.args})}`);
            toolTrace.push(`TOOL RESULT (${call.name}):\n${clip(result)}`);
          }
          // An interactive tool paused the run to ask the user something.
          if (this.interactive) {
            await pause();
            return;
          }
          continue;
        }

        const action = AgentRunner.parseAction(answer);
        if (!action || (action.tool === undefined && action.final === undefined)) {
          // Not a tool/JSON reply — treat the answer as the final answer.
          await finish(answer || raw.trim());
          return;
        }
        if (action.final !== undefined) {
          await finish(String(action.final));
          return;
        }
        const args = action.args ?? {};
        const result = await runTool(String(action.tool), args);
        toolTrace.push(`Assistant: ${JSON.stringify({tool: action.tool, args})}`);
        toolTrace.push(`TOOL RESULT (${String(action.tool)}):\n${clip(result)}`);
        if (this.interactive) {
          await pause();
          return;
        }
      }
      await finish('I ran out of steps before finishing — try a more specific request.');
    } catch (err) {
      await emitSeq({type: 'error', error: err instanceof Error ? err.message : String(err)});
    } finally {
      // Flush any fire-and-forget token writes before the route sends `done`.
      await emitChain.catch(() => undefined);
      // Re-broadcast the page list when the run restructured the tree (create /
      // move), so the sidebar reflects it live rather than on the next refresh.
      if (this.pagesTouched) await Promise.resolve(this.options.onPagesChanged?.()).catch(() => undefined);
      // A per-conversation override built a transient engine — release it.
      if (transient) await engine.dispose().catch(() => undefined);
    }
  }
}

// ── Database tool helpers (build/coerce schema + cell values) ────────────────────

/** Column types the agent may create — the manual (per-row) types, excluding the
 *  computed/relational ones (relation/rollup/formula/expr…) that need extra wiring. */
const CREATABLE_PROP_TYPES = new Set<DatabasePropertyType>([
  'text',
  'number',
  'rating',
  'select',
  'multi_select',
  'status',
  'checkbox',
  'date',
  'url',
  'email',
  'phone',
]);

/** A short, collision-safe id with a readable prefix (e.g. `p_3f2a9c1b`). */
const shortId = (prefix: string): string => `${prefix}_${randomUUID().slice(0, 8)}`;

/** Build select/status options from labels, keeping ids/colours of existing
 *  options whose label still matches (so editing choices doesn't orphan cells). */
function buildOptions(labels: unknown[], existing: DatabaseSelectOption[]): DatabaseSelectOption[] {
  return labels
    .map((raw) => String(raw).trim())
    .filter(Boolean)
    .map((label) => {
      const prev = existing.find((o) => o.label.toLowerCase() === label.toLowerCase());
      return {id: prev?.id ?? shortId('opt'), label, ...(prev?.color ? {color: prev.color} : {})};
    });
}

/** Build a new column from a `{name, type, options?}` spec, or null if invalid. */
function buildProperty(spec: Record<string, unknown>): DatabaseProperty | null {
  const name = String(spec.name ?? '').trim();
  const type = String(spec.type ?? '').trim() as DatabasePropertyType;
  if (!name || !CREATABLE_PROP_TYPES.has(type)) return null;
  const prop: DatabaseProperty = {id: shortId('p'), name, type};
  if ((type === 'select' || type === 'multi_select' || type === 'status') && Array.isArray(spec.options)) {
    prop.options = buildOptions(spec.options, []);
  }
  return prop;
}

/** Resolve a select/status value (an option id OR label) to its option id. */
function resolveOptionId(prop: DatabaseProperty, value: unknown): string {
  const s = String(value);
  const opts = prop.options ?? [];
  return (opts.find((o) => o.id === s) ?? opts.find((o) => o.label.toLowerCase() === s.toLowerCase()))?.id ?? s;
}

/** Coerce a raw cell value to the column's stored shape (numbers, booleans,
 *  option ids), so values the model gives loosely still land correctly. */
function coerceCell(prop: DatabaseProperty, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (prop.type) {
  case 'number':
  case 'rating': {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  case 'checkbox':
    return Boolean(value);
  case 'select':
  case 'status':
    return resolveOptionId(prop, value);
  case 'multi_select':
    return (Array.isArray(value) ? value : [value]).map((v) => resolveOptionId(prop, v));
  default:
    return typeof value === 'string' ? value : String(value);
  }
}

/**
 * Resolve a loose `{column: value}` map (keys may be column ids OR names) into
 * `{propertyId: coercedValue}` for the store, collecting any keys that match no
 * column so the tool can report them.
 */
function resolveRowValues(schema: DatabaseSchema, input: Record<string, unknown>): {values: Record<string, unknown>; unknown: string[]} {
  const props = schema.properties ?? [];
  const values: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [key, val] of Object.entries(input)) {
    const prop = props.find((p) => p.id === key) ?? props.find((p) => p.name.toLowerCase() === String(key).toLowerCase());
    if (!prop) {
      unknown.push(key);
      continue;
    }
    values[prop.id] = coerceCell(prop, val);
  }
  return {values, unknown};
}

// ── Layout / rich-block + appearance helpers ─────────────────────────────────────

/** Block types `add_blocks` may create — mirrors the editor's registry (core +
 *  kit). Kept here so the agent can reject unknown types with a clear list. */
const KNOWN_BLOCK_TYPES = new Set<string>([
  // Text + structure.
  'paragraph', 'heading', 'list', 'todo', 'quote', 'callout', 'code', 'divider',
  // Layout containers.
  'columns', 'column', 'group', 'accordion', 'accordionsection', 'tabs', 'tab',
  // Interactive kit inputs.
  'slider', 'number', 'textfield', 'longtext', 'toggle', 'radio', 'checklist',
  'dropdown', 'choicecards', 'searchselect', 'tagfield', 'location',
  // Reactive display.
  'kitchart', 'statuslight', 'progressbar', 'formula', 'linkcard',
]);

/** Per-page theme values the agent may set (mirror `lib/themes`, `lib/pageCover`). */
const THEME_IDS = new Set<string>([
  'default', 'amber', 'bold', 'cool', 'forest', 'graphite', 'gray', 'neutral', 'ocean', 'pastel', 'rose', 'sunset', 'teal', 'violet', 'warm',
]);
const BACKGROUND_TOKENS = new Set<string>(['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink']);
const COVER_GRADIENT_IDS = new Set<string>(['dawn', 'ocean', 'dusk', 'forest', 'ember', 'slate', 'citrus', 'mint', 'grape', 'sand', 'rose', 'night']);

/** The first block type (anywhere in the tree) that isn't creatable, or null. */
function invalidBlockType(blocks: unknown[]): string | null {
  for (const raw of blocks) {
    if (!raw || typeof raw !== 'object') return '(not a block)';
    const b = raw as {type?: unknown; children?: unknown};
    const type = String(b.type ?? '');
    if (!KNOWN_BLOCK_TYPES.has(type)) return type || '(missing type)';
    if (Array.isArray(b.children)) {
      const nested = invalidBlockType(b.children);
      if (nested) return nested;
    }
  }
  return null;
}

/** A short "type ×n" summary of a block list (for the review card). */
function summarizeBlocks(blocks: unknown[]): string {
  const counts = new Map<string, number>();
  for (const raw of blocks) {
    const type = raw && typeof raw === 'object' ? String((raw as {type?: unknown}).type ?? '?') : '?';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts].map(([type, n]) => (n > 1 ? `${type} ×${n}` : type)).join(', ');
}

/** Normalize the agent's `ask_user` step args into validated interview steps
 *  (capped at 8; a step with no options becomes free-text so it's answerable). */
function buildInterviewSteps(raw: unknown): InterviewStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: InterviewStep[] = [];
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const question = String(s.question ?? '').trim();
    if (!question) continue;
    const options = (Array.isArray(s.options) ? s.options : [])
      .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
      .map((o) => {
        const label = String(o.label ?? '').trim();
        return label ? {label, value: String(o.value ?? label)} : null;
      })
      .filter((o): o is {label: string; value: string} => o !== null);
    const hasOptions = options.length > 0;
    const freeText = s.freeText === true || !hasOptions;
    steps.push({
      id: shortId('q'),
      question,
      ...(hasOptions ? {options} : {}),
      ...(hasOptions && s.multiple === true ? {multiple: true} : {}),
      ...(freeText ? {freeText: true} : {}),
    });
  }
  return steps;
}

/** The `add_blocks` tool description: the full block catalogue the model builds against. */
const BLOCK_CATALOGUE = [
  'Append rich blocks to a page — interactive inputs, layouts, charts, and headings. User approves before they are added.',
  'Each block is {type, text?, props?, children?}. `text` is a plain string (or rich runs [{"t","a":{b,i,u,s,c,a}}]); `children` nests blocks inside containers.',
  'TEXT/STRUCTURE: paragraph; heading {level:1|2|3}; list {kind:"bullet"|"number"}; todo {checked?}; quote; callout {variant:"info"|"warn"|"success"}; code {language?,live?,name?,collapsed?}; divider.',
  'LAYOUT (use children): columns → column {span:1-12} → blocks (side-by-side, spans sum to 12); group {name?,locked?}; accordion {name?,gated?} → accordionsection {label,collapsed?} → blocks; tabs → tab {label} → blocks.',
  'INPUTS (give each a props.name OR props.label so charts/formulas can reference it): slider/number {name,label,value,min,max,step}; textfield/longtext {name,label,value,placeholder}; toggle {name,label,value:boolean}; dropdown/radio {name,label,value,opts:[{label,value}]}; checklist {name,label,selected:[],opts}; choicecards {name,label,value,opts:[{label,value,icon?}],multi?}; searchselect {name,label,value,opts,multi?}; tagfield {name,label,selected:[],freeEntry?}; location {name,label}.',
  'REACTIVE DISPLAY (props.source is a JS expression over input names): kitchart {kind:"line"|"area"|"bar"|"pie"|"donut"|"scatter"|"funnel",title?,labels?,source}; statuslight {label?,source,okAt,warnAt}; progressbar {label?,source,max?,format?}; formula {source}; linkcard {title,url,description?}.',
  'Example: a budget widget → [{"type":"heading","text":"Budget","props":{"level":2}},{"type":"columns","children":[{"type":"column","props":{"span":5},"children":[{"type":"slider","props":{"name":"spent","label":"Spent","value":80,"min":0,"max":200}},{"type":"number","props":{"name":"budget","label":"Budget","value":120}}]},{"type":"column","props":{"span":7},"children":[{"type":"kitchart","props":{"kind":"bar","title":"Spent vs budget","labels":"Spent, Budget","source":"[spent, budget]"}},{"type":"statuslight","props":{"label":"On track","source":"budget - spent","okAt":0,"warnAt":-20}}]}]}].',
].join('\n');

// ── Snapshot helpers (read-only inspection over the JSON projection) ─────────────

interface AnyJsonBlock {
  id?: string;
  type?: string;
  text?: Array<{t: string}>;
  props?: Record<string, unknown>;
  data?: Record<string, unknown>;
  children?: AnyJsonBlock[];
}

const runText = (b: AnyJsonBlock): string => (Array.isArray(b.text) ? b.text.map((r) => r.t).join('') : '');

/** Block-editor pages expose a `blockdoc.blocks` JSON projection. */
function blockdocBlocks(data: {editor?: string; blockdoc?: unknown} | null | undefined): AnyJsonBlock[] | null {
  if (!data || data.editor !== 'blocks') return null;
  const bd = data.blockdoc as {blocks?: AnyJsonBlock[]} | undefined;
  return bd?.blocks ?? [];
}

/** A compact, indented block tree for `inspect_page_structure`. */
function blockTree(data: {editor?: string; blockdoc?: unknown; editorjs?: unknown} | null | undefined): string[] {
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
  // Legacy EditorJS page.
  const ejs = (data?.editorjs as {blocks?: AnyJsonBlock[]} | undefined)?.blocks ?? [];
  for (const b of ejs) {
    const text = typeof b.data?.text === 'string' ? String(b.data.text).replace(/<[^>]+>/g, '').slice(0, 60) : '';
    out.push(`- [${b.id ?? '?'}] ${b.type ?? '?'}${text ? `: ${text}` : ''}`);
  }
  return out;
}

/** The current plain text of a block by id (block-editor pages only); null if absent. */
function blockTextById(data: {editor?: string; blockdoc?: unknown} | null | undefined, id: string): string | null {
  const blocks = blockdocBlocks(data);
  if (!blocks) return null;
  let found: string | null = null;
  const walk = (list: AnyJsonBlock[]): void => {
    for (const b of list) {
      if (found !== null) return;
      if (b.id === id) {
        found = runText(b);
        return;
      }
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  return found;
}

/** A block's current type + props (block-editor pages only), or null if absent. */
function blockInfoById(
  data: {editor?: string; blockdoc?: unknown} | null | undefined,
  id: string,
): {type: string; props: Record<string, unknown>} | null {
  const blocks = blockdocBlocks(data);
  if (!blocks) return null;
  let found: {type: string; props: Record<string, unknown>} | null = null;
  const walk = (list: AnyJsonBlock[]): void => {
    for (const b of list) {
      if (found) return;
      if (b.id === id) {
        found = {type: b.type ?? '?', props: b.props ?? {}};
        return;
      }
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  return found;
}

/**
 * The named kit input values published by a block-editor page, read from the
 * JSON projection. Mirrors `kit/scope.ts` inputValue/publishedName on the
 * server side (no Yjs needed for a read). Returns {} for non-block pages.
 */
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
  case 'location':
    return {lat: p.lat ?? null, lng: p.lng ?? null, label: p.label ?? ''};
  default:
    return undefined;
  }
}

function kitValues(data: {editor?: string; blockdoc?: unknown} | null | undefined): Record<string, unknown> {
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
