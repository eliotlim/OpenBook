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

export interface AiConfig {
  provider: AiProvider;
  /** Model identifier: a GGUF filename (llama), an MLX model id (mlx), or a
   *  served model name (openai). */
  model?: string;
  /** Base URL for `mlx` / `openai` providers (e.g. http://127.0.0.1:8080). */
  baseUrl?: string;
  /** mlx only: spawn `mlx_lm.server` automatically when possible. */
  autoStart?: boolean;
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

/** Server-sent chunk of a streaming generation. */
export interface AiStreamEvent {
  token?: string;
  done?: boolean;
  error?: string;
}
