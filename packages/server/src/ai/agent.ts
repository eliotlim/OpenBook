import {
  snapshotText,
  textSnapshot,
  type AgentProposal,
  type AiEffort,
  type AiSkill,
  type PluginAgentTool,
} from '@open-book/sdk';
import type {PageStore} from '../store';
import {effortProfile} from './effort';
import type {NativeTool, NativeToolCall} from './providers';
import type {AiService} from './service';
import {SCRATCHPAD_INSTRUCTION, splitReasoning} from './thinking';

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
 * Write safety: write tools never mutate. They enqueue a PROPOSED change set
 * the UI shows for approval; on approve the client applies it through the
 * editor bridge in one CRDT transaction (undoable). The runner only describes
 * the change.
 */

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type AgentEvent =
  | {type: 'tool'; name: string; args: Record<string, unknown>}
  | {type: 'tool_result'; name: string; result: string}
  | {type: 'reasoning'; text: string}
  | {type: 'proposals'; proposals: AgentProposal[]}
  | {type: 'final'; text: string}
  | {type: 'error'; error: string};

export interface AgentRunOptions {
  effort?: AiEffort;
  /** Surface reasoning to the UI (default true). */
  thinking?: boolean;
  /** Prompt/recipe skills to inline into the system prompt. */
  skills?: AiSkill[];
  /** Plugin-contributed agent tools (read from manifests). */
  pluginTools?: PluginAgentTool[];
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

export class AgentRunner {
  private readonly tools: ToolDef[];
  /** Proposals accumulated across this run's write-tool calls (one approval). */
  private proposals: AgentProposal[] = [];
  private proposalSeq = 0;

  constructor(
    private readonly ai: AiService,
    private readonly store: PageStore,
    private readonly options: AgentRunOptions = {},
  ) {
    this.tools = [...this.readTools(), ...this.writeTools(), ...this.pluginToolDefs()];
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
          return this.enqueue({
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
          return this.enqueue({
            kind: 'update_block',
            summary: `Edit block ${blockId} on "${page.name ?? 'Untitled'}"`,
            pageId,
            before: clip(before, 200),
            after: clip(text, 200),
            payload: {pageId, blockId, text},
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
          return this.enqueue({
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
          return this.enqueue({
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
        return this.enqueue({
          kind: 'append_blocks',
          summary: `${tool.name}: add ${blocks.length} block(s) to "${page.name ?? 'Untitled'}"`,
          pageId,
          payload: {pageId, blocks},
        });
      },
    }));
  }

  /** Record a proposal and return the message the model sees as the tool result. */
  private enqueue(proposal: Omit<AgentProposal, 'id'>): string {
    const id = `prop-${(this.proposalSeq += 1)}`;
    this.proposals.push({id, ...proposal});
    return `PROPOSED (pending your approval): ${proposal.summary}. Do not call it again; continue or answer.`;
  }

  // ── Prompt ────────────────────────────────────────────────────────────────────

  private systemPrompt(useNative: boolean): string {
    const catalogue = this.tools
      .map((t) => `- ${t.name}${t.args === '{}' ? '' : ` args ${t.args}`}: ${t.description}`)
      .join('\n');
    const lines = [
      'You are the OpenBook assistant: you help the user work with their local note workspace using TOOLS.',
      'Tools that change the workspace only PROPOSE a change — the user approves before anything is applied.',
    ];
    const skills = this.options.skills ?? [];
    if (skills.length > 0) {
      lines.push('', 'Available skills (recipes you may follow):');
      for (const s of skills) lines.push(`### skill: ${s.name} — ${s.description}\n${s.instructions}`);
    }
    if (!useNative) {
      lines.push(
        '',
        'Available tools:',
        catalogue,
        '',
        'Respond with EXACTLY ONE JSON object and nothing else:',
        '- To use a tool: {"tool": "<name>", "args": {...}}',
        '- To answer the user: {"final": "<your answer>"}',
        'Use tools to ground your answers in the workspace. Search before answering questions about notes.',
        SCRATCHPAD_INSTRUCTION,
      );
    } else {
      lines.push(
        '',
        'Call the provided tools to ground your work. When you are done, reply with your final answer as plain text.',
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
    this.proposals = [];

    // Prefer native tool-calling when the endpoint advertises it; fall back to
    // the JSON protocol on any failure.
    let useNative = false;
    try {
      useNative = await this.ai.supportsTools();
    } catch {
      useNative = false;
    }

    const runTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const tool = this.tools.find((t) => t.name === name);
      if (!tool) return `unknown tool "${name}". Use one of: ${this.tools.map((t) => t.name).join(', ')}.`;
      await emit({type: 'tool', name: tool.name, args});
      let result: string;
      try {
        result = await tool.run(args);
      } catch (err) {
        result = `Tool failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      await emit({type: 'tool_result', name: tool.name, result: clip(result, 400)});
      return result;
    };

    const finish = async (text: string): Promise<void> => {
      if (this.proposals.length > 0) await emit({type: 'proposals', proposals: this.proposals});
      await emit({type: 'final', text: text.trim()});
    };

    try {
      for (let step = 0; step < maxSteps; step += 1) {
        const calls: NativeToolCall[] = [];
        const genOpts = {
          system: this.systemPrompt(useNative),
          maxTokens,
          temperature,
          thinkingBudget,
          effort: this.options.effort,
          ...(useNative ? {tools: this.nativeTools(), onToolCalls: (c: NativeToolCall[]) => calls.push(...c)} : {}),
          onToken: () => undefined,
        };
        const raw = await this.ai.generate(this.transcript(messages, toolTrace), genOpts);
        const {answer, reasoning} = splitReasoning(raw);
        if (showThinking && reasoning) await emit({type: 'reasoning', text: reasoning});

        // Native path: the model emitted structured tool calls.
        if (useNative && calls.length > 0) {
          for (const call of calls) {
            const result = await runTool(call.name, call.args);
            toolTrace.push(`Assistant: ${JSON.stringify({tool: call.name, args: call.args})}`);
            toolTrace.push(`TOOL RESULT (${call.name}):\n${clip(result)}`);
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
      }
      await finish('I ran out of steps before finishing — try a more specific request.');
    } catch (err) {
      await emit({type: 'error', error: err instanceof Error ? err.message : String(err)});
    }
  }
}

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
