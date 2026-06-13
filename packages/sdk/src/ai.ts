/**
 * The optional local-AI subsystem's shared contract. The server hosts a
 * pluggable inference engine; these types describe its configuration,
 * status, and request/response shapes. Everything degrades gracefully:
 * with the engine off, lexical (BM25) note search still works and the AI
 * editor affordances simply hide.
 *
 * Providers:
 *  - `off`    — disabled (default).
 *  - `mock`   — deterministic in-process engine (tests, demos).
 *  - `llama`  — llama.cpp in-process via node-llama-cpp (GGUF models,
 *               cross-platform: Metal/CUDA/Vulkan/CPU). The model file is
 *               downloaded on demand into the server's models directory.
 *  - `mlx`    — Apple-Silicon MLX through `mlx_lm.server`'s OpenAI-compatible
 *               API (optionally auto-started by the server).
 *  - `openai` — any OpenAI-compatible local endpoint (Ollama, LM Studio,
 *               llama-server, vLLM…).
 */

export type AiProvider = 'off' | 'mock' | 'llama' | 'mlx' | 'openai';

/**
 * How hard the agent works on a turn. One knob maps (server-side, in one
 * place — `ai/effort.ts`) to a thinking-token budget, sampling temperature,
 * answer-token cap, and the agent's max tool-call steps.
 */
export type AiEffort = 'low' | 'med' | 'high';

export interface AiConfig {
  provider: AiProvider;
  /** Model identifier: a GGUF filename (llama), an MLX model id (mlx), or a
   *  served model name (openai). */
  model?: string;
  /** Base URL for `mlx` / `openai` providers (e.g. http://127.0.0.1:8080). */
  baseUrl?: string;
  /** mlx only: spawn `mlx_lm.server` automatically when possible. */
  autoStart?: boolean;
  /** Default agent effort (low/med/high). Falls back to 'med'. */
  effort?: AiEffort;
  /** Whether the agent surfaces its reasoning (collapsible). Default true. */
  thinking?: boolean;
}

export interface AiStatus {
  config: AiConfig;
  /** The engine can generate text right now. */
  ready: boolean;
  /** The engine can embed text (semantic search reranking). */
  embeddings: boolean;
  /** Human-readable detail when not ready (missing model, endpoint down…). */
  detail?: string;
  /** Lexical search index state (always available, even with AI off). */
  index: {pages: number; builtAt: string | null};
  /** In-flight model download, when one is running. */
  download?: {url: string; received: number; total: number | null; done: boolean; error?: string};
}

export interface AiSearchResult {
  pageId: string;
  title: string;
  /** Best-matching snippet of the page's text. */
  snippet: string;
  score: number;
}

export interface AiSearchResponse {
  results: AiSearchResult[];
  /** 'lexical' (BM25 only) or 'hybrid' (BM25 + embedding rerank). */
  mode: 'lexical' | 'hybrid';
}

export interface AiTasksResponse {
  tasks: string[];
}

/**
 * Server-sent chunk of a streaming generation. `token` carries answer text;
 * `reasoning` carries a model's thinking (from `<think>…</think>` or a
 * scratchpad) routed to a separate channel so the UI renders it as a
 * collapsible block and never as document content.
 */
export interface AiStreamEvent {
  token?: string;
  /** A reasoning/thinking token (kept out of the document). */
  reasoning?: string;
  done?: boolean;
  error?: string;
}

// ── Agent harness ─────────────────────────────────────────────────────────────

export interface AgentChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * A single proposed change the agent wants to apply to the workspace. Write
 * tools enqueue these instead of mutating immediately; the UI shows a
 * diff/summary card and the user approves (apply in one CRDT transaction) or
 * rejects. `before`/`after` are human-readable for the card; `target` +
 * `payload` are what the UI bridge replays on approval.
 */
export interface AgentProposal {
  /** Stable id within the turn's change set. */
  id: string;
  /** Which write tool produced it (drives how the bridge applies it). */
  kind: 'set_kit_value' | 'set_db_cell' | 'update_block' | 'append_blocks';
  /** One-line human summary, e.g. `Set "budget" = 1200`. */
  summary: string;
  /** The page this change targets (for block/kit writes). */
  pageId?: string;
  /** Prior value, rendered for the diff card (optional). */
  before?: string;
  /** New value, rendered for the diff card. */
  after?: string;
  /** Structured payload the client bridge replays to mutate the CRDT/DB. */
  payload: Record<string, unknown>;
}

/** One streamed step of an agent run. */
export type AgentChatEvent =
  | {type: 'tool'; name: string; args: Record<string, unknown>}
  | {type: 'tool_result'; name: string; result: string}
  | {type: 'reasoning'; text: string}
  | {type: 'proposals'; proposals: AgentProposal[]}
  | {type: 'final'; text: string}
  | {type: 'error'; error: string};

/** Options for one agent run. */
export interface AgentChatOptions {
  signal?: AbortSignal;
  /** Override the configured default effort for this run. */
  effort?: AiEffort;
  /** Override whether reasoning is surfaced for this run. */
  thinking?: boolean;
  /** Names of prompt/recipe skills to inline into the system prompt. */
  skills?: string[];
}

// ── Skills (user-authored prompt/recipe skills) ─────────────────────────────────

/**
 * A user-authored prompt/recipe skill: markdown instructions the agent can
 * inline into its system prompt. No code — pure prompt engineering, editable
 * by the user. Stored per-workspace (in the `settings` table under `ai.skills`;
 * see `ai/skills.ts`).
 */
export interface AiSkill {
  /** Stable slug (lowercase, hyphenated), unique per workspace. */
  name: string;
  /** Short one-line description shown in the catalogue. */
  description: string;
  /** The instructions inlined when the skill is invoked (markdown). */
  instructions: string;
  updatedAt?: string;
}
