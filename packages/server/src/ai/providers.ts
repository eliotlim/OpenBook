import {spawn, type ChildProcess} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {providerSettings, type AiConfig, type AiProvider} from '@open-book/sdk';

/**
 * Inference engines behind one interface. Generation streams tokens;
 * embedding is optional (engines without it fall back to lexical-only
 * search). Engines are created lazily from config and disposed on switch.
 *
 *  - mock    — deterministic, in-process, instant. Tests and demos.
 *  - openai  — any OpenAI-compatible endpoint (Ollama, LM Studio,
 *              llama-server, vLLM…). Pure fetch; works everywhere.
 *  - mlx     — the openai engine pointed at `mlx_lm.server`, which the
 *              service can auto-start on Apple Silicon.
 *  - llama   — in-process llama.cpp via node-llama-cpp (optional native
 *              dependency, loaded dynamically; GGUF models from disk).
 */

/** A native (OpenAI-style) tool the engine may call. */
export interface NativeTool {
  name: string;
  description: string;
  /** JSON-Schema for the tool's arguments object. */
  parameters: Record<string, unknown>;
}

/** A native tool call the model emitted. */
export interface NativeToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface GenerateOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** Soft cap on reasoning tokens for thinking models (advisory). */
  thinkingBudget?: number;
  /** One knob that, mapped server-side (`effort.ts`), sets the others. */
  effort?: 'low' | 'med' | 'high';
  /**
   * Native tools advertised to the model. When provided AND the engine
   * supports native tool-calling, the model may answer with tool calls
   * (surfaced via {@link onToolCalls}) instead of plain text.
   */
  tools?: NativeTool[];
  /** Called with any native tool calls the model emitted this turn. */
  onToolCalls?: (calls: NativeToolCall[]) => void;
  onToken: (token: string) => void;
  signal?: AbortSignal;
}

export interface AiEngine {
  readonly kind: string;
  /** Throws (with a user-readable message) when the engine can't run. */
  ensureReady(): Promise<void>;
  generate(prompt: string, opts: GenerateOptions): Promise<string>;
  /**
   * Whether this engine can do native (OpenAI-style) function-calling. The
   * agent prefers native tool-calling when true and falls back to its JSON
   * protocol otherwise — so every local endpoint stays usable. Best-effort:
   * probes the endpoint's capabilities; never throws.
   */
  supportsTools?(): Promise<boolean>;
  /** Undefined when the engine cannot embed. */
  embed?(texts: string[]): Promise<number[][]>;
  dispose(): Promise<void>;
}

// ── Mock ─────────────────────────────────────────────────────────────────────

/** Deterministic engine: echoes structured output for each prompt family.
 *  Keeps the whole AI surface testable without any model. */
export class MockEngine implements AiEngine {
  readonly kind = 'mock';

  async ensureReady(): Promise<void> {
    // always ready
  }

  async generate(prompt: string, opts: GenerateOptions): Promise<string> {
    let out: string;
    if (/OpenBook assistant/i.test(opts.system ?? '')) {
      // Scripted agent turn: search first, then answer from the result. The
      // leading <think> block exercises the reasoning-channel splitter.
      if (!prompt.includes('TOOL RESULT')) {
        const lastUser = prompt.split('User:').pop()?.split('\n')[0]?.trim() ?? '';
        out = `<think>The user asked: ${lastUser.slice(0, 40)}. I'll search the notes.</think>${JSON.stringify({tool: 'search_notes', args: {query: lastUser.slice(0, 60)}})}`;
      } else {
        const hits = (prompt.match(/^- \[/gm) ?? []).length;
        out = JSON.stringify({final: `I looked through your notes and found ${hits} relevant ${hits === 1 ? 'page' : 'pages'}.`});
      }
    } else if (/break.*down|task/i.test(opts.system ?? '')) {
      out = '1. Outline the goal\n2. Draft the first version\n3. Review and refine';
    } else if (/continue|complete/i.test(opts.system ?? '')) {
      out = ' This continues the document with a mock completion.';
    } else {
      out = `Mock response to: ${prompt.slice(0, 60)}`;
    }
    for (const token of out.split(/(?<=\s)/)) {
      opts.onToken(token);
      await new Promise((r) => setTimeout(r, 2));
    }
    return out;
  }

  /** Cheap deterministic embedding: hashed bag-of-words (good enough to make
   *  hybrid ranking exercise real code paths in tests). */
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(64).fill(0);
      for (const tok of t.toLowerCase().split(/\W+/)) {
        if (!tok) continue;
        let h = 0;
        for (let i = 0; i < tok.length; i += 1) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
        v[h % 64] += 1;
      }
      return v;
    });
  }

  async dispose(): Promise<void> {
    // nothing to release
  }
}

// ── OpenAI-compatible endpoint ───────────────────────────────────────────────

export class OpenAiCompatEngine implements AiEngine {
  readonly kind: string;
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    kind = 'openai',
  ) {
    this.kind = kind;
  }

  async ensureReady(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/models`, {signal: AbortSignal.timeout(3000)}).catch(() => null);
    if (!res?.ok) {
      throw new Error(`No OpenAI-compatible server at ${this.baseUrl} — is it running?`);
    }
  }

  /**
   * Cached result of the native-tool-calling capability probe (per endpoint).
   * `undefined` until first probed.
   */
  private toolsSupported: boolean | undefined;

  /**
   * Probe whether the endpoint advertises native tool-calling. OpenAI-compatible
   * servers don't expose a uniform capability flag, so we send a one-token
   * request with a trivial tool and see whether the server accepts the `tools`
   * field (a 4xx means "not supported"; a stream means it does). Cached.
   */
  async supportsTools(): Promise<boolean> {
    if (this.toolsSupported !== undefined) return this.toolsSupported;
    try {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          model: this.model || 'default',
          max_tokens: 1,
          stream: false,
          messages: [{role: 'user', content: 'ping'}],
          tools: [{type: 'function', function: {name: 'noop', description: 'noop', parameters: {type: 'object', properties: {}}}}],
        }),
        signal: AbortSignal.timeout(4000),
      });
      // 200 → the server understood `tools`. 4xx (esp. 400) → it rejected them.
      this.toolsSupported = res.ok;
    } catch {
      this.toolsSupported = false;
    }
    return this.toolsSupported;
  }

  async generate(prompt: string, opts: GenerateOptions): Promise<string> {
    const useTools = Boolean(opts.tools && opts.tools.length > 0);
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        model: this.model || 'default',
        stream: true,
        max_tokens: opts.maxTokens ?? 512,
        temperature: opts.temperature ?? 0.7,
        ...(useTools
          ? {
            tools: opts.tools!.map((tool) => ({
              type: 'function',
              function: {name: tool.name, description: tool.description, parameters: tool.parameters},
            })),
            tool_choice: 'auto',
          }
          : {}),
        messages: [
          ...(opts.system ? [{role: 'system', content: opts.system}] : []),
          {role: 'user', content: prompt},
        ],
      }),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Generation failed: HTTP ${res.status}`);

    let full = '';
    // Native tool-call fragments accumulate by index across deltas.
    const toolAcc = new Map<number, {id: string; name: string; args: string}>();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const data = line.replace(/^data:\s*/, '').trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{
              delta?: {
                content?: string;
                /** Some servers stream reasoning out-of-band (vLLM/llama.cpp). */
                reasoning_content?: string;
                tool_calls?: Array<{index?: number; id?: string; function?: {name?: string; arguments?: string}}>;
              };
            }>;
          };
          const delta = parsed.choices?.[0]?.delta;
          // Out-of-band reasoning → wrap so the splitter routes it to the
          // reasoning channel (it's never document content).
          const reasoning = delta?.reasoning_content ?? '';
          if (reasoning) {
            full += `<think>${reasoning}</think>`;
            opts.onToken(`<think>${reasoning}</think>`);
          }
          const token = delta?.content ?? '';
          if (token) {
            full += token;
            opts.onToken(token);
          }
          for (const tc of delta?.tool_calls ?? []) {
            const idx = tc.index ?? 0;
            const acc = toolAcc.get(idx) ?? {id: '', name: '', args: ''};
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
            toolAcc.set(idx, acc);
          }
        } catch {
          // partial frame — wait for more
        }
      }
    }
    if (useTools && toolAcc.size > 0 && opts.onToolCalls) {
      const calls: NativeToolCall[] = [];
      for (const acc of toolAcc.values()) {
        if (!acc.name) continue;
        let args: Record<string, unknown> = {};
        try {
          args = acc.args ? (JSON.parse(acc.args) as Record<string, unknown>) : {};
        } catch {
          // malformed args — pass empty; the tool reports its own error
        }
        calls.push({id: acc.id || `call_${calls.length}`, name: acc.name, args});
      }
      if (calls.length > 0) opts.onToolCalls(calls);
    }
    return full;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({model: this.model || 'default', input: texts}),
    });
    if (!res.ok) throw new Error(`Embeddings failed: HTTP ${res.status}`);
    const body = (await res.json()) as {data: Array<{embedding: number[]}>};
    return body.data.map((d) => d.embedding);
  }

  async dispose(): Promise<void> {
    // stateless
  }
}

// ── MLX (mlx_lm.server, optionally auto-started) ─────────────────────────────

export class MlxEngine extends OpenAiCompatEngine {
  private child: ChildProcess | null = null;
  private startedUrl: string;

  constructor(
    baseUrl: string,
    private readonly mlxModel: string,
    private readonly autoStart: boolean,
  ) {
    super(baseUrl, mlxModel, 'mlx');
    this.startedUrl = baseUrl;
  }

  override async ensureReady(): Promise<void> {
    try {
      await super.ensureReady();
      return;
    } catch (err) {
      if (!this.autoStart || process.platform !== 'darwin' || process.arch !== 'arm64') {
        throw new Error(
          `MLX server not reachable at ${this.startedUrl}. Install it with \`pip install mlx-lm\` and run \`mlx_lm.server --model ${this.mlxModel || '<model>'}\`.`,
        );
      }
      void err;
    }
    await this.spawnServer();
    // Model loading can take a while on first run — poll up to 60s.
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await super.ensureReady();
        return;
      } catch (e) {
        if (Date.now() > deadline || this.child?.exitCode !== null) {
          throw new Error(`mlx_lm.server did not come up: ${e instanceof Error ? e.message : String(e)}`);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private async spawnServer(): Promise<void> {
    if (this.child) return;
    const port = Number(new URL(this.startedUrl).port || 8080);
    // `mlx_lm.server` if on PATH; fall back to `python3 -m mlx_lm server`.
    const attempts: Array<[string, string[]]> = [
      ['mlx_lm.server', ['--model', this.mlxModel, '--port', String(port)]],
      ['python3', ['-m', 'mlx_lm', 'server', '--model', this.mlxModel, '--port', String(port)]],
    ];
    for (const [cmd, args] of attempts) {
      try {
        const child = spawn(cmd, args, {stdio: 'ignore', detached: false});
        const failedFast = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 1500);
          child.once('error', () => {
            clearTimeout(timer);
            resolve(true);
          });
          child.once('exit', () => {
            clearTimeout(timer);
            resolve(true);
          });
        });
        if (!failedFast) {
          this.child = child;
          return;
        }
      } catch {
        // try the next launcher
      }
    }
    throw new Error('Could not start mlx_lm.server (install with `pip install mlx-lm`).');
  }

  override async dispose(): Promise<void> {
    if (this.child && this.child.exitCode === null) this.child.kill();
    this.child = null;
  }
}

// ── llama.cpp in-process (node-llama-cpp, optional dependency) ───────────────

interface EmbeddingContextLike {
  getEmbeddingFor: (t: string) => Promise<{vector: readonly number[]}>;
}

interface LlamaModules {
  getLlama: (opts?: Record<string, unknown>) => Promise<unknown>;
  LlamaChatSession: new (opts: Record<string, unknown>) => {
    prompt: (text: string, opts?: Record<string, unknown>) => Promise<string>;
  };
}

export class LlamaEngine implements AiEngine {
  readonly kind = 'llama';
  private model: unknown | null = null;
  private llama: unknown | null = null;
  private modules: LlamaModules | null = null;
  private embedContext: EmbeddingContextLike | null = null;
  private loadError: string | null = null;

  constructor(
    private readonly modelsDir: string,
    private readonly modelFile: string,
  ) {}

  modelPath(): string {
    return path.join(this.modelsDir, this.modelFile);
  }

  async ensureReady(): Promise<void> {
    if (this.model) return;
    if (this.loadError) throw new Error(this.loadError);
    if (!this.modelFile) throw new Error('No model selected — download one in Settings → AI.');
    if (!existsSync(this.modelPath())) {
      throw new Error(`Model file missing (${this.modelFile}) — download it in Settings → AI.`);
    }
    try {
      // Dynamic import: node-llama-cpp is an optional native dependency. In
      // environments without it (e.g. the compiled desktop sidecar) this
      // throws and the user is pointed at the MLX/OpenAI-compatible providers.
      const mod = (await import('node-llama-cpp')) as unknown as LlamaModules;
      this.modules = mod;
      this.llama = await mod.getLlama();
      const llamaApi = this.llama as {loadModel: (o: Record<string, unknown>) => Promise<unknown>};
      this.model = await llamaApi.loadModel({modelPath: this.modelPath()});
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.loadError = `llama.cpp engine unavailable: ${detail}`;
      throw new Error(this.loadError);
    }
  }

  async generate(prompt: string, opts: GenerateOptions): Promise<string> {
    await this.ensureReady();
    const model = this.model as {createContext: () => Promise<{getSequence: () => unknown; dispose: () => Promise<void>}>};
    const context = await model.createContext();
    try {
      const session = new this.modules!.LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt: opts.system,
      });
      return await session.prompt(prompt, {
        maxTokens: opts.maxTokens ?? 512,
        temperature: opts.temperature ?? 0.7,
        signal: opts.signal,
        onTextChunk: (chunk: string) => opts.onToken(chunk),
      });
    } finally {
      await context.dispose();
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.ensureReady();
    if (!this.embedContext) {
      const model = this.model as {createEmbeddingContext: () => Promise<EmbeddingContextLike>};
      this.embedContext = await model.createEmbeddingContext();
    }
    const out: number[][] = [];
    for (const text of texts) {
      const {vector} = await this.embedContext!.getEmbeddingFor(text);
      out.push([...vector]);
    }
    return out;
  }

  async dispose(): Promise<void> {
    const disposable = this.model as {dispose?: () => Promise<void>} | null;
    await disposable?.dispose?.().catch(() => undefined);
    this.model = null;
    this.embedContext = null;
  }
}

// ── Anthropic (hosted Claude API) ────────────────────────────────────────────

/** The Anthropic Messages API (`/v1/messages`). The only cloud provider —
 *  content leaves the machine. Streams text + (extended) thinking and supports
 *  native tool-calling. No embeddings endpoint, so search falls back to lexical. */
export class AnthropicEngine implements AiEngine {
  readonly kind = 'claude';
  /** Default when the user hasn't pinned a model — a current, balanced Claude. */
  static readonly DEFAULT_MODEL = 'claude-sonnet-4-6';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  constructor(apiKey: string, model: string, baseUrl = 'https://api.anthropic.com') {
    // Trim pasted whitespace/newlines (a stray newline in x-api-key → a 401),
    // and drop any trailing slash so `${baseUrl}/v1/...` doesn't double up.
    this.apiKey = apiKey.trim();
    this.model = model.trim();
    this.baseUrl = (baseUrl.trim() || 'https://api.anthropic.com').replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return {'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01'};
  }

  async ensureReady(): Promise<void> {
    if (!this.apiKey) throw new Error('Set an Anthropic API key in AI settings.');
    // `claude setup-token` mints a Claude Code OAuth token (`sk-ant-oat…`) — it
    // authenticates as Claude Code (Bearer + an OAuth beta), NOT via the Messages
    // API's x-api-key, so it can't be used here. Catch it with a clear message
    // rather than a bare 401.
    if (this.apiKey.startsWith('sk-ant-oat')) {
      throw new Error(
        'That is a Claude Code OAuth token (from `claude setup-token`), not an API key. Create an API key at console.anthropic.com (it starts with “sk-ant-api…”) and paste that instead.',
      );
    }
    // The Models API is a cheap key check — it bills no tokens.
    const res = await fetch(`${this.baseUrl}/v1/models?limit=1`, {headers: this.headers(), signal: AbortSignal.timeout(5000)}).catch(
      () => null,
    );
    if (!res) throw new Error(`Can't reach the Anthropic API at ${this.baseUrl}.`);
    if (res.status === 401) {
      throw new Error('Anthropic API key was rejected (401). Use an API key from console.anthropic.com (“sk-ant-api…”), not a Claude Code/setup-token.');
    }
    if (!res.ok) throw new Error(`Anthropic API error: HTTP ${res.status}.`);
  }

  // Claude supports native tool-calling.
  async supportsTools(): Promise<boolean> {
    return true;
  }

  async generate(prompt: string, opts: GenerateOptions): Promise<string> {
    const useTools = Boolean(opts.tools && opts.tools.length > 0);
    const maxTokens = opts.maxTokens ?? 1024;
    // Extended thinking needs a ≥1024-token budget below max_tokens, and forbids
    // a custom temperature — so enable it only when the budget allows.
    const think = opts.thinkingBudget && opts.thinkingBudget >= 1024 ? Math.min(opts.thinkingBudget, maxTokens + 4096) : 0;
    const body: Record<string, unknown> = {
      model: this.model || AnthropicEngine.DEFAULT_MODEL,
      max_tokens: think ? think + maxTokens : maxTokens,
      stream: true,
      messages: [{role: 'user', content: prompt}],
      ...(opts.system ? {system: opts.system} : {}),
      ...(think
        ? {thinking: {type: 'enabled', budget_tokens: think}}
        : opts.temperature !== undefined
          ? {temperature: opts.temperature}
          : {}),
      ...(useTools ? {tools: opts.tools!.map((tool) => ({name: tool.name, description: tool.description, input_schema: tool.parameters}))} : {}),
    };
    const res = await fetch(`${this.baseUrl}/v1/messages`, {method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: opts.signal});
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Generation failed: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
    }

    let full = '';
    let streamError: string | undefined;
    // Tool-use blocks accumulate their streamed JSON input by block index.
    const toolAcc = new Map<number, {id: string; name: string; args: string}>();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue; // ignore `event:` lines + blanks
        const data = line.slice(5).trim();
        if (!data) continue;
        try {
          const ev = JSON.parse(data) as {
            type?: string;
            index?: number;
            content_block?: {type?: string; id?: string; name?: string};
            delta?: {type?: string; text?: string; thinking?: string; partial_json?: string};
            error?: {message?: string};
          };
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
            toolAcc.set(ev.index ?? 0, {id: ev.content_block.id ?? '', name: ev.content_block.name ?? '', args: ''});
          } else if (ev.type === 'content_block_delta') {
            const d = ev.delta;
            if (d?.type === 'text_delta' && d.text) {
              full += d.text;
              opts.onToken(d.text);
            } else if (d?.type === 'thinking_delta' && d.thinking) {
              // Route reasoning to the <think> channel (never document content).
              full += `<think>${d.thinking}</think>`;
              opts.onToken(`<think>${d.thinking}</think>`);
            } else if (d?.type === 'input_json_delta' && d.partial_json) {
              const acc = toolAcc.get(ev.index ?? 0);
              if (acc) acc.args += d.partial_json;
            }
          } else if (ev.type === 'error') {
            streamError = ev.error?.message ?? 'stream error';
          }
        } catch {
          // partial frame — wait for more
        }
      }
    }
    if (useTools && toolAcc.size > 0 && opts.onToolCalls) {
      const calls: NativeToolCall[] = [];
      for (const acc of toolAcc.values()) {
        if (!acc.name) continue;
        let args: Record<string, unknown> = {};
        try {
          args = acc.args ? (JSON.parse(acc.args) as Record<string, unknown>) : {};
        } catch {
          // malformed args — pass empty; the tool reports its own error
        }
        calls.push({id: acc.id || `call_${calls.length}`, name: acc.name, args});
      }
      if (calls.length > 0) opts.onToolCalls(calls);
    }
    // A mid-stream error with nothing produced is a real failure; surface it.
    if (streamError && !full && toolAcc.size === 0) throw new Error(`Anthropic: ${streamError}`);
    return full;
  }

  async dispose(): Promise<void> {
    // stateless
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build the engine for a provider. With no `override`, builds the configured
 * default; an `override` (from a per-conversation agent choice) selects a
 * different provider/model, reading that provider's stored connection settings.
 */
export function createEngine(
  config: AiConfig,
  modelsDir: string,
  override?: {provider?: AiProvider; model?: string},
): AiEngine | null {
  const provider = override?.provider ?? config.provider;
  const s = providerSettings(config, provider);
  const model = override?.model || s.model || '';
  switch (provider) {
  case 'mock':
    return new MockEngine();
  case 'openai':
    return new OpenAiCompatEngine(s.baseUrl || 'http://127.0.0.1:11434', model || 'default');
  case 'mlx':
    return new MlxEngine(s.baseUrl || 'http://127.0.0.1:8080', model, s.autoStart ?? true);
  case 'llama':
    return new LlamaEngine(modelsDir, model);
  case 'claude':
    return new AnthropicEngine(s.apiKey || '', model, s.baseUrl || 'https://api.anthropic.com');
  default:
    return null;
  }
}
