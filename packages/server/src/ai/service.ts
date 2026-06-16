import {createWriteStream, existsSync, mkdirSync} from 'node:fs';
import {rename, unlink} from 'node:fs/promises';
import path from 'node:path';
import {providerSettings, type AiConfig, type AiProvider, type AiSearchResponse, type AiStatus, type AiTasksResponse} from '@open-book/sdk';
import type {Db} from '../db';
import {createEngine, type AiEngine, type GenerateOptions} from './providers';
import {bm25Scores, buildIndex, chunkText, cosine, parseTaskList, snapshotText, snippetFor, type Bm25Index, type IndexedDoc} from './search';
import {SkillStore} from './skills';

/**
 * The optional local-AI subsystem: holds the configured engine, the note
 * search index, and model downloads. Everything is best-effort and isolated —
 * a broken engine never affects the document APIs, and lexical search works
 * with no engine at all.
 *
 * Config persists in the `settings` table (works for embedded PGlite and
 * external Postgres alike). Models download into `<modelsDir>` (the data
 * directory on desktop, ~/.openbook/models otherwise).
 */

const DEFAULT_CONFIG: AiConfig = {provider: 'off'};

/** A small, capable default for the in-process engine (~0.9 GB Q4). */
export const DEFAULT_MODEL_URL =
  'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf';

interface DownloadState {
  url: string;
  received: number;
  total: number | null;
  done: boolean;
  error?: string;
}

export class AiService {
  private config: AiConfig = DEFAULT_CONFIG;
  private engine: AiEngine | null = null;
  private index: Bm25Index | null = null;
  private indexBuiltAt: Date | null = null;
  private indexVersion = 0; // bumped by page writes → stale index rebuilds
  private indexedVersion = -1;
  private download: DownloadState | null = null;
  private loaded = false;
  /** User-authored prompt/recipe skills (per-workspace markdown). */
  readonly skills: SkillStore;

  constructor(
    private readonly db: Db,
    private readonly modelsDir: string,
  ) {
    this.skills = new SkillStore(db);
  }

  /** Mark the search index stale (call on any page write). */
  invalidateIndex(): void {
    this.indexVersion += 1;
  }

  private async loadConfig(): Promise<void> {
    if (this.loaded) return;
    const rows = await this.db.query<{value: AiConfig}>('SELECT value FROM settings WHERE key = \'ai\'');
    if (rows.length > 0 && rows[0].value && typeof rows[0].value === 'object') {
      this.config = {...DEFAULT_CONFIG, ...rows[0].value};
    }
    this.loaded = true;
    this.engine = createEngine(this.config, this.modelsDir);
  }

  async getConfig(): Promise<AiConfig> {
    await this.loadConfig();
    return this.config;
  }

  async setConfig(next: AiConfig): Promise<AiConfig> {
    await this.loadConfig();
    await this.engine?.dispose().catch(() => undefined);
    this.config = {...DEFAULT_CONFIG, ...next};
    await this.db.query(
      `INSERT INTO settings (key, value) VALUES ('ai', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(this.config)],
    );
    this.engine = createEngine(this.config, this.modelsDir);
    return this.config;
  }

  async status(): Promise<AiStatus> {
    await this.loadConfig();
    let ready = false;
    let detail: string | undefined;
    let embeddings = false;
    if (this.engine) {
      try {
        await this.engine.ensureReady();
        ready = true;
        embeddings = typeof this.engine.embed === 'function';
      } catch (err) {
        detail = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      config: this.config,
      ready,
      embeddings,
      detail,
      index: {
        pages: this.index ? new Set(this.index.docs.map((d) => d.pageId)).size : 0,
        builtAt: this.indexBuiltAt?.toISOString() ?? null,
      },
      download: this.download ?? undefined,
    };
  }

  // ── Note search ────────────────────────────────────────────────────────────

  /** Build (or reuse) the lexical index over every live page. */
  async ensureIndex(force = false): Promise<Bm25Index> {
    await this.loadConfig();
    if (!force && this.index && this.indexedVersion === this.indexVersion) return this.index;
    const version = this.indexVersion;
    // Every live page — including database rows (they're pages too).
    const rows = await this.db.query<{id: string; name: string | null; data: unknown}>(
      'SELECT id, name, data FROM pages WHERE deleted_at IS NULL',
    );
    const docs: IndexedDoc[] = [];
    for (const row of rows) {
      const data = typeof row.data === 'string' ? (JSON.parse(row.data) as never) : (row.data as never);
      const text = snapshotText(data);
      if (!text && !row.name) continue;
      const chunks = chunkText(text);
      if (chunks.length === 0) chunks.push('');
      chunks.forEach((chunk, chunkIndex) => {
        docs.push({pageId: row.id, title: row.name ?? 'Untitled', chunkIndex, text: chunk});
      });
    }
    this.index = buildIndex(docs);
    this.indexBuiltAt = new Date();
    this.indexedVersion = version;
    return this.index;
  }

  async search(query: string, limit = 8): Promise<AiSearchResponse> {
    const index = await this.ensureIndex();
    const lexical = bm25Scores(index, query).slice(0, limit * 4);

    let mode: AiSearchResponse['mode'] = 'lexical';
    let ranked = lexical;

    // Hybrid: embed the query + the lexical candidates and blend the scores.
    if (this.engine?.embed && lexical.length > 0) {
      try {
        await this.engine.ensureReady();
        const texts = [query, ...lexical.map(({i}) => index.docs[i].text)];
        const vectors = await this.engine.embed(texts);
        const queryVec = vectors[0];
        const maxLex = lexical[0]?.score || 1;
        ranked = lexical
          .map(({i, score}, at) => ({
            i,
            score: 0.5 * (score / maxLex) + 0.5 * cosine(queryVec, vectors[at + 1]),
          }))
          .sort((a, b) => b.score - a.score);
        mode = 'hybrid';
      } catch {
        // engine hiccup → lexical results still stand
      }
    }

    // One result per page (best chunk wins).
    const seen = new Set<string>();
    const results = [];
    for (const {i, score} of ranked) {
      const doc = index.docs[i];
      if (seen.has(doc.pageId)) continue;
      seen.add(doc.pageId);
      results.push({
        pageId: doc.pageId,
        title: doc.title,
        snippet: snippetFor(doc.text, query),
        score: Math.round(score * 1000) / 1000,
      });
      if (results.length >= limit) break;
    }
    return {results, mode};
  }

  // ── Generation ─────────────────────────────────────────────────────────────

  private async readyEngine(): Promise<AiEngine> {
    await this.loadConfig();
    if (!this.engine) throw new Error('AI is turned off — pick a provider in Settings → AI.');
    await this.engine.ensureReady();
    return this.engine;
  }

  /**
   * Resolve the engine for an agent run. With no override (or one that matches
   * the configured default) returns the cached default engine. A per-conversation
   * override builds a TRANSIENT engine from that provider's stored settings —
   * the caller must `dispose()` it when `transient` is true. Either way the
   * engine is readied (so a bad key / unreachable endpoint surfaces here).
   */
  async engineForRequest(override?: {provider?: AiProvider; model?: string}): Promise<{engine: AiEngine; transient: boolean}> {
    await this.loadConfig();
    const provider = override?.provider;
    const model = override?.model;
    const defaultModel = providerSettings(this.config, this.config.provider).model ?? '';
    const usesDefault = (!provider || provider === this.config.provider) && (!model || model === defaultModel);
    if (usesDefault) {
      return {engine: await this.readyEngine(), transient: false};
    }
    const engine = createEngine(this.config, this.modelsDir, {provider, model});
    if (!engine) throw new Error('That AI provider is turned off — configure it in Settings → AI.');
    await engine.ensureReady();
    return {engine, transient: true};
  }

  async generate(prompt: string, opts: GenerateOptions): Promise<string> {
    const engine = await this.readyEngine();
    return engine.generate(prompt, opts);
  }

  /** Whether the active engine can do native (OpenAI-style) tool-calling. */
  async supportsTools(): Promise<boolean> {
    try {
      const engine = await this.readyEngine();
      return engine.supportsTools ? await engine.supportsTools() : false;
    } catch {
      return false;
    }
  }

  /** Break a goal into a clean list of actionable tasks. */
  async tasks(goal: string, context?: string): Promise<AiTasksResponse> {
    const engine = await this.readyEngine();
    const raw = await engine.generate(
      `Goal: ${goal}\n${context ? `Context:\n${context.slice(0, 2000)}\n` : ''}Break this goal into its concrete tasks.`,
      {
        system:
          'You turn a goal into a short checklist of concrete, doable tasks.\n' +
          'Reply with ONLY a numbered list of 3–8 tasks — nothing else (no title, no preamble, no explanation, no sub-bullets).\n' +
          'Each task is one short line that starts with an imperative verb and names a specific, independently-doable step.\n' +
          'Example — for the goal "Launch the beta":\n' +
          '1. Finalize the beta feature list\n2. Write the landing page copy\n3. Set up the sign-up form\n4. Email the waitlist',
        maxTokens: 400,
        temperature: 0.4,
        onToken: () => undefined,
      },
    );
    return {tasks: parseTaskList(raw)};
  }

  /** Continue a document from its current text (streamed via onToken). */
  async complete(text: string, instruction: string | undefined, opts: GenerateOptions): Promise<string> {
    const engine = await this.readyEngine();
    return engine.generate(
      `${instruction ? `Instruction: ${instruction}\n\n` : ''}Document so far:\n---\n${text.slice(-4000)}\n---\nContinue the document from exactly where it ends.`,
      {
        ...opts,
        system:
          opts.system ??
          'You continue the user\'s document from where it stops.\n' +
            'Write ONLY the next part of the text — no preamble, no labels, no surrounding quotes, no markdown code fences.\n' +
            'Match the document\'s language, tone, formatting, and point of view, and pick up the current sentence or section naturally.',
      },
    );
  }

  // ── Model downloads (llama provider) ───────────────────────────────────────

  async startDownload(url = DEFAULT_MODEL_URL): Promise<DownloadState> {
    await this.loadConfig();
    if (this.download && !this.download.done && !this.download.error) return this.download;
    const fileName = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'model.gguf');
    mkdirSync(this.modelsDir, {recursive: true});
    const dest = path.join(this.modelsDir, fileName);
    const state: DownloadState = {url, received: 0, total: null, done: false};
    this.download = state;

    void (async () => {
      const partial = `${dest}.part`;
      try {
        if (existsSync(dest)) {
          state.done = true;
          state.received = state.total ?? 0;
        } else {
          const res = await fetch(url, {redirect: 'follow'});
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          state.total = Number(res.headers.get('content-length')) || null;
          const out = createWriteStream(partial);
          const reader = res.body.getReader();
          for (;;) {
            const {done, value} = await reader.read();
            if (done) break;
            state.received += value.byteLength;
            await new Promise<void>((resolve, reject) => {
              out.write(value, (err) => (err ? reject(err) : resolve()));
            });
          }
          await new Promise<void>((resolve, reject) => out.end((err: Error | null | undefined) => (err ? reject(err) : resolve())));
          await rename(partial, dest);
          state.done = true;
        }
        // Auto-select the downloaded model for the llama provider.
        if (this.config.provider === 'llama' && !this.config.model) {
          await this.setConfig({...this.config, model: fileName});
        }
      } catch (err) {
        state.error = err instanceof Error ? err.message : String(err);
        await unlink(partial).catch(() => undefined);
      }
    })();

    return state;
  }

  async dispose(): Promise<void> {
    await this.engine?.dispose().catch(() => undefined);
  }
}
