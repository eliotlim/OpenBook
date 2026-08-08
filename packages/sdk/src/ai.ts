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
import type {TableOpKind} from './tableSnapshot';

export type AiProvider = 'off' | 'mock' | 'llama' | 'mlx' | 'openai' | 'claude';

/**
 * How hard the agent works on a turn. One knob maps (server-side, in one
 * place — `ai/effort.ts`) to a thinking-token budget, sampling temperature,
 * answer-token cap, and the agent's max tool-call steps.
 */
export type AiEffort = 'low' | 'med' | 'high';

/** Per-provider connection settings. Every provider is configured independently
 *  (in `AiConfig.providers`), so a library can have llama, mlx, openai and
 *  claude all set up at once and switch between them per agent run. */
export interface AiProviderSettings {
  /** Model identifier: a GGUF filename (llama), an MLX model id (mlx), a served
   *  model name (openai), or a Claude model id (e.g. `claude-opus-4-8`). */
  model?: string;
  /** Base URL for `mlx` / `openai` / `claude`. Defaults: mlx
   *  http://127.0.0.1:8080, openai http://127.0.0.1:11434, claude
   *  https://api.anthropic.com (override for a proxy/gateway). */
  baseUrl?: string;
  /**
   * `claude` only: the Anthropic API key. **Write-only across the wire** — the
   * server NEVER returns the stored key to any client (inference runs entirely
   * server-side; no client needs it). Status responses carry {@link apiKeySet}
   * instead. On save (`PUT /api/ai/config`) the value is interpreted three ways:
   *   • omitted / empty string → PRESERVE the stored key (blank-on-save is a no-op);
   *   • a non-empty string     → set a new key;
   *   • explicit `null`        → CLEAR the stored key.
   */
  apiKey?: string | null;
  /**
   * Response-only signal: the server holds a non-empty key for this provider.
   * Set by `GET /api/ai/status` (in place of the redacted {@link apiKey}) so the
   * settings form can show a "key set" state and offer to replace/clear it
   * without ever receiving the secret. Never persisted; never carries the value.
   */
  apiKeySet?: boolean;
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
  /** @deprecated use `providers[provider].apiKey` — same write-only/preserve/clear
   *  semantics (the flat key belonged to the then-active provider). */ apiKey?: string | null;
  /** Response-only mirror of {@link AiProviderSettings.apiKeySet} for a legacy flat
   *  config (the stored key belonged to the then-active provider). */ apiKeySet?: boolean;
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
    return {model: config.model, baseUrl: config.baseUrl, apiKey: config.apiKey, apiKeySet: config.apiKeySet, autoStart: config.autoStart};
  }
  return {};
}

/**
 * Whether a provider is a **paid / hosted** engine — `openai` (an OpenAI-style
 * endpoint that may be `api.openai.com`) or `claude` (Anthropic's hosted API).
 * Both can bill per token and send content off the machine, so paid inference is
 * fenced behind sign-in on a claimed multi-user instance (a guest must not be
 * able to rack up inference cost). The rest — `off`/`mock`/`llama`/`mlx` — run
 * locally and free, and stay open. The single source of truth for "is this
 * inference paid"; routes and UI both classify the configured provider through it.
 */
export function isPaidProvider(provider: AiProvider): boolean {
  return provider === 'openai' || provider === 'claude';
}

// ── Usage attribution pricing (admin-editable) ─────────────────────────────────

/**
 * Per-model list price, in US dollars per MILLION tokens. `input`/`output` are
 * required; the optional `cache*` prices apply to prompt-cache read/write tokens
 * (Claude) and are folded into cost only when the engine actually reports cache
 * tokens. Local providers (llama/mlx/mock) are priced at 0.
 */
export interface AiModelPrice {
  inputPerMtok: number;
  outputPerMtok: number;
  /** Prompt-cache READ price ($/Mtok). Defaults to the input price's cache tier. */
  cacheReadPerMtok?: number;
  /** Prompt-cache WRITE/creation price ($/Mtok). */
  cacheWritePerMtok?: number;
}

/** Pricing keyed by provider → model id → {@link AiModelPrice}. Used for the
 *  shipped default table and the admin override alike. */
export type AiPricingTable = Partial<Record<AiProvider, Record<string, AiModelPrice>>>;

/**
 * The pricing view returned by `GET /api/ai/pricing` (admin only): the shipped
 * `default` table, the admin `override`, and the `effective` merge
 * (override → default → null) used to snapshot `cost_usd` at log time.
 */
export interface AiPricingResponse {
  default: AiPricingTable;
  override: AiPricingTable;
  effective: AiPricingTable;
}

/**
 * One attribution row projected out of the admin-only usage database (the raw
 * property ids `p_*` are resolved to these named fields server-side, so the
 * admin viewer never depends on the internal schema). `cost` is `null` for a
 * model whose price is unknown (tokens are still counted); `time` is the ISO
 * timestamp of the call.
 */
export interface AiUsageRow {
  id: string;
  time: string | null;
  user: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  kind: string;
}

/**
 * Aggregate totals across ALL usage rows in the database — NOT just the page of
 * rows returned in {@link AiUsageResponse.rows} (which is capped). So `rows` here
 * is the true total call count and can exceed `AiUsageResponse.rows.length`.
 */
export interface AiUsageTotals {
  /** Total number of usage rows (calls) in the database, across all pages. */
  rows: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of the known (non-null) row costs, in US dollars. */
  cost: number;
}

/**
 * The admin-only usage view returned by `GET /api/ai/usage`. The usage database
 * is created LAZILY on first AI use, so `exists` is `false` (and `rows`/`totals`
 * absent) until then — the viewer renders a graceful empty state. `retentionDays`
 * is the usage DB's current auto-expiry window when known, else `null`.
 */
export interface AiUsageResponse {
  exists: boolean;
  databaseId: string | null;
  hostPageId: string | null;
  retentionDays: number | null;
  rows?: AiUsageRow[];
  totals?: AiUsageTotals;
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
  /** The block the best-matching chunk came from, so a pick can land on it (the
   *  `?block=` scroll-to anchor). Absent for legacy pages and title-only hits. */
  blockId?: string;
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
  /**
   * Which write tool produced it (drives how the bridge applies it). The
   * `table_*` kinds (API-3) are the TABLE STRUCTURE ops — the bridge replays each
   * by calling the editor's own `model.ts` op inside the proposal's single CRDT
   * transaction, so an accepted table suggestion is one undo step and behaves
   * exactly like the context-menu item. Their payloads carry SORTED (render-order)
   * coordinates — `{tableId, rowIndex}` / `{tableId, colIndex}` / `{tableId,
   * rowIndex, toIndex}` / `{tableId, rowIndex, colIndex, text}` — or a `cellId`
   * (which resolves both indices), matching `cellPosition`.
   */
  kind:
    | 'set_kit_value'
    | 'set_db_cell'
    | 'update_block'
    | 'append_blocks'
    | 'set_page_theme'
    | 'delete_block'
    | 'set_block_props'
    | TableOpKind;
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

/**
 * One step of a multi-step interview the agent asks the user (the `ask_user`
 * tool). Each step is one question; the user answers all steps, and the answers
 * return to the agent as their next message.
 */
export interface InterviewStep {
  id: string;
  /** The question text. */
  question: string;
  /** Choices to pick from. Omit (or set `freeText`) for a typed answer. */
  options?: Array<{label: string; value: string}>;
  /** Allow selecting more than one option. */
  multiple?: boolean;
  /** Allow a typed answer (on its own, or in addition to the options). */
  freeText?: boolean;
}

/** One streamed step of an agent run. */
export type AgentChatEvent =
  | {type: 'tool'; name: string; args: Record<string, unknown>}
  | {type: 'tool_result'; name: string; result: string}
  /**
   * The agent is asking for a sticky, per-conversation permission. `kind`
   * distinguishes them (default `direct_edits` for back-compat):
   *  - `direct_edits` — apply its edits DIRECTLY (without the review pane);
   *    granting makes subsequent edits apply immediately (see {@link apply}).
   *  - `external_tools` — call EXTERNAL MCP tools (`mcp__*`), which send inputs
   *    off the library; granting lets the agent use them for this conversation.
   * The UI shows an allow / keep-reviewing prompt either way.
   */
  | {type: 'permission_request'; summary: string; kind?: 'direct_edits' | 'external_tools'}
  /** The agent is asking the user a multi-step interview; answers return as the
   *  user's next message. */
  | {type: 'interview'; title?: string; steps: InterviewStep[]}
  /**
   * Edits the agent applied DIRECTLY (the user granted edit access). The UI
   * replays them through the editor bridge — the same path an accepted
   * suggestion takes — and shows a short "applied" summary instead of a review
   * card.
   */
  | {type: 'apply'; proposals: AgentProposal[]}
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
  /** When true (the user granted edit access), the agent's edits apply directly
   *  via an {@link AgentChatEvent.apply} event instead of becoming review
   *  suggestions. Sticky for the conversation once granted. */
  allowDirectEdits?: boolean;
  /** When true (the user consented), the agent may call EXTERNAL MCP tools
   *  (`mcp__*`) without pausing. Sticky for the conversation; the first external
   *  call otherwise emits a `permission_request` with `kind:'external_tools'`. */
  allowExternalTools?: boolean;
  /** When true, an external MCP tool was already used earlier in this conversation
   *  — the client re-sends it (set once it sees any `mcp__*` tool event) so taint
   *  (edits routed through review) stays sticky for the rest of the conversation,
   *  not just the run that made the external call. */
  externalToolsUsed?: boolean;
}

// ── External tools: MCP client (AGENT-3) ────────────────────────────────────────

/**
 * How the in-app agent reaches an external MCP server:
 *  - `stdio` — spawn a local child process and speak MCP over its stdio. This is
 *    host **command execution** (the child runs as the server user and can reach
 *    loopback services the identity layer trusts as the machine owner), so it is
 *    permitted ONLY on a desktop / UNCLAIMED instance. On a claimed multi-user
 *    instance the server rejects a `stdio` registration and the UI hides it.
 *  - `http` — a remote (or loopback) Streamable-HTTP MCP endpoint, authed with a
 *    static bearer token. The only transport offered on a claimed instance.
 */
export type McpTransport = 'stdio' | 'http';

/**
 * One registered external MCP server. Admin-managed (see {@link McpClientConfig});
 * connections are pooled server-side and its tools are merged into an agent run
 * namespaced `mcp__<id>__<tool>` (so `id` forbids underscores — the delimiter).
 */
export interface McpServerConfig {
  /** Stable slug, `^[a-z0-9][a-z0-9-]{0,31}$` (NO underscores — the namespace
   *  delimiter). Unique within {@link McpClientConfig.servers}. */
  id: string;
  /** Optional display name (defaults to {@link id}). */
  name?: string;
  /** Per-server enable. Default false — a registered server does nothing until
   *  explicitly enabled (and the global {@link McpClientConfig.enabled} is on). */
  enabled: boolean;
  transport: McpTransport;
  // ── stdio transport ──
  /** The executable to spawn (stdio). */
  command?: string;
  /** Arguments for {@link command} (stdio). NEVER carries the auth token. */
  args?: string[];
  /** Extra environment for the child (stdio). Overlaid on a MINIMAL default env
   *  (never the server's own `process.env`); the auth token is injected under
   *  {@link authEnvVar}, not here. */
  env?: Record<string, string>;
  /** Env var name the auth token is injected under (stdio). Default `MCP_AUTH_TOKEN`. */
  authEnvVar?: string;
  // ── http transport ──
  /** The Streamable-HTTP MCP endpoint (http). */
  url?: string;
  /** Extra request headers (http). The auth token is sent as `Authorization:
   *  Bearer <token>`, NOT here. */
  headers?: Record<string, string>;
  /**
   * The static bearer token (http) or injected secret (stdio). **Write-only
   * across the wire** — the server never returns it. Same three-way contract as
   * {@link AiProviderSettings.apiKey}:
   *   • omitted / empty string → PRESERVE the stored token;
   *   • a non-empty string     → set a new token;
   *   • explicit `null`        → CLEAR the stored token.
   */
  authToken?: string | null;
  /** Response-only signal: the server holds a non-empty token for this server.
   *  Set by `GET /api/ai/mcp` in place of the redacted {@link authToken}. */
  authTokenSet?: boolean;
  /** Per-call timeout for this server's tools, ms. Default 30000, clamped
   *  1000..120000. */
  timeoutMs?: number;
}

/**
 * The library's external-tool (MCP client) configuration, persisted server-side
 * under the `ai.mcp` settings key. Admin-managed. OFF and empty by default —
 * nothing connects until an admin adds a server, enables it, and flips the global
 * switch. A deployment env kill-switch (`OPENBOOK_MCP_CLIENTS=0`) hard-disables
 * the whole subsystem regardless.
 */
export interface McpClientConfig {
  /** Global kill-switch. Default false — with it off no server connects, even an
   *  individually-enabled one. */
  enabled: boolean;
  servers: McpServerConfig[];
}

/**
 * `GET /api/ai/mcp` (admin only): the redacted config (every {@link
 * McpServerConfig.authToken} stripped, {@link McpServerConfig.authTokenSet}
 * flagged) plus `stdioAllowed` — whether this instance's trust level permits the
 * `stdio` transport (true on a desktop / unclaimed instance, false once claimed).
 * The UI hides the stdio option when false; the PUT route enforces the same rule.
 */
export interface McpConfigResponse {
  config: McpClientConfig;
  stdioAllowed: boolean;
}

/** Result of `POST /api/ai/mcp/test` (admin only): a connect + list-tools dry-run
 *  against one server config. Never returns secrets. */
export interface McpTestResult {
  ok: boolean;
  /** Tool names discovered on a successful connect. */
  tools?: string[];
  /** A human-readable failure reason (error class / message), never headers/env. */
  error?: string;
}

// ── Skills (user-authored prompt/recipe skills) ─────────────────────────────────

/**
 * A user-authored prompt/recipe skill: markdown instructions the agent can
 * inline into its system prompt. No code — pure prompt engineering, editable
 * by the user. Stored per-library (in the `settings` table under `ai.skills`;
 * see `ai/skills.ts`).
 */
export interface AiSkill {
  /** Stable slug (lowercase, hyphenated), unique per library. */
  name: string;
  /** Short one-line description shown in the catalogue. */
  description: string;
  /** The instructions inlined when the skill is invoked (markdown). */
  instructions: string;
  updatedAt?: string;
}
