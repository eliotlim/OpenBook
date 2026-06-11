import {appendTextToSnapshot, snapshotText, textSnapshot} from '@open-book/sdk';
import type {PageStore} from '../store';
import type {AiService} from './service';

/**
 * A small agent harness over the configured AI engine: the model is given a
 * tool catalogue and must answer with ONE JSON object per turn — either
 * `{"tool": "...", "args": {...}}` or `{"final": "..."}`. The loop executes
 * tools against the workspace and feeds results back, for at most
 * {@link MAX_STEPS} rounds. The JSON protocol (rather than native function
 * calling) keeps every provider on equal footing — small local GGUF/MLX
 * models included.
 */

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type AgentEvent =
  | {type: 'tool'; name: string; args: Record<string, unknown>}
  | {type: 'tool_result'; name: string; result: string}
  | {type: 'final'; text: string}
  | {type: 'error'; error: string};

const MAX_STEPS = 6;

interface ToolDef {
  name: string;
  description: string;
  args: string;
  run: (args: Record<string, unknown>) => Promise<string>;
}

const clip = (s: string, n = 1500): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export class AgentRunner {
  private readonly tools: ToolDef[];

  constructor(
    private readonly ai: AiService,
    private readonly store: PageStore,
  ) {
    this.tools = [
      {
        name: 'search_notes',
        description: 'Search every note/page in the workspace; returns ranked matches with snippets.',
        args: '{"query": string}',
        run: async (args) => {
          const res = await this.ai.search(String(args.query ?? ''), 5);
          if (res.results.length === 0) return 'No matching notes.';
          return res.results.map((r) => `- [${r.pageId}] ${r.title}: ${r.snippet}`).join('\n');
        },
      },
      {
        name: 'read_page',
        description: 'Read the full text of one page by id.',
        args: '{"pageId": string}',
        run: async (args) => {
          const page = await this.store.getPage(String(args.pageId ?? ''));
          if (!page) return 'Page not found.';
          return `Title: ${page.name ?? 'Untitled'}\n\n${clip(snapshotText(page.data) || '(empty page)', 3000)}`;
        },
      },
      {
        name: 'list_pages',
        description: 'List workspace pages (id and title), most recently updated first.',
        args: '{}',
        run: async () => {
          const pages = await this.store.listPages();
          return pages
            .slice(0, 40)
            .map((p) => `- [${p.id}] ${p.name ?? 'Untitled'}`)
            .join('\n');
        },
      },
      {
        name: 'create_page',
        description: 'Create a new page with a title and optional text content (one paragraph per line).',
        args: '{"title": string, "content"?: string}',
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
        description: 'Append text to the end of an existing page (one paragraph per line).',
        args: '{"pageId": string, "content": string}',
        run: async (args) => {
          const page = await this.store.getPage(String(args.pageId ?? ''));
          if (!page) return 'Page not found.';
          const content = String(args.content ?? '');
          const data = appendTextToSnapshot(page.data, content, `agent-${Date.now().toString(36)}`);
          if (!data) {
            return 'This page uses the collaborative editor and cannot be appended to from here — create a new page instead.';
          }
          if (data === page.data) return 'Nothing to append.';
          await this.store.upsertPage({id: page.id, name: page.name, data});
          return `Appended to "${page.name ?? 'Untitled'}".`;
        },
      },
    ];
  }

  private systemPrompt(): string {
    const catalogue = this.tools.map((t) => `- ${t.name}${t.args === '{}' ? '' : ` args ${t.args}`}: ${t.description}`).join('\n');
    return [
      'You are the OpenBook assistant: you help the user work with their local note workspace using TOOLS.',
      'Available tools:',
      catalogue,
      '',
      'Respond with EXACTLY ONE JSON object and nothing else:',
      '- To use a tool: {"tool": "<name>", "args": {...}}',
      '- To answer the user: {"final": "<your answer>"}',
      'Use tools to ground your answers in the workspace. Prefer searching before answering questions about notes.',
    ].join('\n');
  }

  /** Serialize the conversation for single-prompt engines. */
  private transcript(messages: AgentMessage[], toolTrace: string[]): string {
    const turns = messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`);
    return [...turns, ...toolTrace].join('\n');
  }

  /** Extract the first JSON object from a (possibly chatty/fenced) reply. */
  static parseAction(raw: string): {tool?: string; args?: Record<string, unknown>; final?: string} | null {
    const start = raw.indexOf('{');
    if (start === -1) return null;
    // Walk to the matching close brace (strings respected).
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

  async run(messages: AgentMessage[], emit: (event: AgentEvent) => void | Promise<void>): Promise<void> {
    const toolTrace: string[] = [];
    try {
      for (let step = 0; step < MAX_STEPS; step += 1) {
        const raw = await this.ai.generate(this.transcript(messages, toolTrace), {
          system: this.systemPrompt(),
          maxTokens: 700,
          temperature: 0.2,
          onToken: () => undefined,
        });
        const action = AgentRunner.parseAction(raw);
        if (!action) {
          // Not JSON — treat the whole reply as the final answer.
          await emit({type: 'final', text: raw.trim()});
          return;
        }
        if (action.final !== undefined) {
          await emit({type: 'final', text: String(action.final)});
          return;
        }
        const tool = this.tools.find((t) => t.name === action.tool);
        if (!tool) {
          toolTrace.push(`TOOL ERROR: unknown tool "${String(action.tool)}". Use one of: ${this.tools.map((t) => t.name).join(', ')}.`);
          continue;
        }
        const args = action.args ?? {};
        await emit({type: 'tool', name: tool.name, args});
        let result: string;
        try {
          result = await tool.run(args);
        } catch (err) {
          result = `Tool failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        await emit({type: 'tool_result', name: tool.name, result: clip(result, 400)});
        toolTrace.push(`Assistant: ${JSON.stringify({tool: tool.name, args})}`);
        toolTrace.push(`TOOL RESULT (${tool.name}):\n${clip(result)}`);
      }
      await emit({type: 'final', text: 'I ran out of steps before finishing — try a more specific request.'});
    } catch (err) {
      await emit({type: 'error', error: err instanceof Error ? err.message : String(err)});
    }
  }
}
