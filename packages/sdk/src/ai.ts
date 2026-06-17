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
 *  - `claude` — Anthropic's hosted Claude API (cloud; needs an API key). The
 *               only provider that sends content off the machine.
 */

import type {StoredSuggestion} from './suggestions';

export type AiProvider = 'off' | 'mock' | 'llama' | 'mlx' | 'openai' | 'claude';

/**
 * How hard the agent works on a turn. One knob maps (server-side, in one
 * place — `ai/effort.ts`) to a thinking-token budget, sampling temperature,
 * answer-token cap, and the agent's max tool-call steps.
 */
export type AiEffort = 'low' | 'med' | 'high';

/** Per-provider connection settings. Every provider is configured independently
 *  (in `AiConfig.providers`), so a workspace can have llama, mlx, openai and
 *  claude all set up at once and switch between them per agent run. */
export interface AiProviderSettings {
  /** Model identifier: a GGUF filename (llama), an MLX model id (mlx), a served
   *  model name (openai), or a Claude model id (e.g. `claude-sonnet-4-6`). */
  model?: string;
  /** Base URL for `mlx` / `openai` / `claude`. Defaults: mlx
   *  http://127.0.0.1:8080, openai http://127.0.0.1:11434, claude
   *  https://api.anthropic.com (override for a proxy/gateway). */
  baseUrl?: string;
  /** `claude` only: the Anthropic API key. */
  apiKey?: string;
  /** `mlx` only: spawn `mlx_lm.server` automatically when possible. */
  autoStart?: boolean;
}

export interface AiConfig {
  /** The default provider — used unless an agent run overrides it. */
  provider: AiProvider;
  /** Per-provider settings, so every provider can be configured at once. */
  providers?: Partial<Record<AiProvider, AiProviderSettings>>;
  /** Default agent effort (low/med/high). Falls back to 'med'. */
  effort?: AiEffort;
  /** Whether the agent surfaces its reasoning (collapsible). Default true. */
  thinking?: boolean;
  // ── Legacy single-provider fields (pre-`providers`) ──────────────────────────
  // Read only for migration: they belonged to whatever provider was active when
  // they were saved. New code reads/writes `providers` via {@link providerSettings}.
  /** @deprecated use `providers[provider].model` */ model?: string;
  /** @deprecated use `providers[provider].baseUrl` */ baseUrl?: string;
  /** @deprecated use `providers[provider].apiKey` */ apiKey?: string;
  /** @deprecated use `providers[provider].autoStart` */ autoStart?: boolean;
}

/**
 * The effective settings for one provider: its `providers` entry, or — for a
 * legacy config saved before per-provider settings existed — the flat top-level
 * fields (which belonged to the then-active provider). Server engine creation
 * and both UIs read settings through this, so old configs keep working.
 */
export function providerSettings(config: AiConfig, provider: AiProvider): AiProviderSettings {
  const entry = config.providers?.[provider];
  if (entry) return entry;
  if (provider === config.provider) {
    return {model: config.model, baseUrl: config.baseUrl, apiKey: config.apiKey, autoStart: config.autoStart};
  }
  return {};
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
 * A single change the agent's write tools describe. Internal to the agent
 * harness: a write tool builds one of these, the runner persists it as a
 * {@link StoredSuggestion} (see `./suggestions`), and the suggestion — not this
 * proposal — is what reaches the UI. Retained because the persisted
 * suggestion's `payload` carries this `kind` (as `applyKind`), which the editor
 * bridge replays to apply the change when a human accepts it.
 */
export interface AgentProposal {
  /** Stable id within the turn's change set. */
  id: string;
  /** Which write tool produced it (drives how the bridge applies it). */
  kind: 'set_kit_value' | 'set_db_cell' | 'update_block' | 'append_blocks' | 'set_page_theme';
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
  /**
   * A chunk of the assistant's answer, streamed live as the model writes it
   * (engines that support native tool-calling only; the JSON-protocol fallback
   * surfaces the answer once, via {@link final}). The UI appends these to the
   * in-progress answer bubble; the matching {@link final} carries the complete,
   * authoritative text.
   */
  | {type: 'token'; text: string}
  | {type: 'reasoning'; text: string}
  /**
   * The agent's write tools persisted these suggestions for review (NOT
   * applied). The UI shows a "proposed N suggestions — Review" card linking to
   * the Review side pane; a human accepts/rejects each there.
   */
  | {type: 'suggestions'; suggestions: StoredSuggestion[]}
  | {type: 'final'; text: string}
  | {type: 'error'; error: string};

/** Options for one agent run. */
export interface AgentChatOptions {
  signal?: AbortSignal;
  /** Override the default provider for this run (else the configured default). */
  provider?: AiProvider;
  /** Override the model for this run (else the provider's configured model). */
  model?: string;
  /** Override the configured default effort for this run. */
  effort?: AiEffort;
  /** Override whether reasoning is surfaced for this run. */
  thinking?: boolean;
  /** Names of prompt/recipe skills to inline into the system prompt. */
  skills?: string[];
  /** The page the user is currently viewing — its content is added as context. */
  pageId?: string;
  /** The user's current text selection — added as context on top of the message. */
  selection?: string;
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
