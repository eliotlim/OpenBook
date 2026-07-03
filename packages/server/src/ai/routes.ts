import {Hono, type Context} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {streamSSE} from 'hono/streaming';
import {API, isPaidProvider, snapshotText, type AgentChatMessage, type AiConfig, type AiEffort, type AiProvider, type AiSkill, type PluginAgentTool} from '@book.dev/sdk';
import type {PageStore} from '../store';
import type {AppEnv} from '../appEnv';
import {requireCreate} from '../access';
import {AgentRunner, type AgentMessage} from './agent';
import type {AiService} from './service';

/**
 * The `/api/ai/*` surface. Generation endpoints stream tokens as SSE
 * (`data: {"token": "..."}` frames, closed by `data: {"done": true}`);
 * everything else is plain JSON. Engine failures return 503 with a
 * human-readable `error` so the UI can guide the user to Settings → AI.
 */
export function mountAiRoutes(app: Hono<AppEnv>, ai: AiService, store: PageStore, onPagesChanged?: () => Promise<void>): void {
  app.get(API.aiStatus, async (c) => c.json(await ai.status()));

  app.put(API.aiConfig, async (c) => {
    // Instance-wide engine config (provider, API keys, model choice) — an
    // instance-writer action, not something a viewer/guest may flip.
    await requireCreate(c, store);
    const body = (await c.req.json()) as AiConfig;
    if (!['off', 'mock', 'llama', 'mlx', 'openai', 'claude'].includes(body.provider)) {
      return c.json({error: `Unknown provider: ${String(body.provider)}`}, 400);
    }
    return c.json(await ai.setConfig(body));
  });

  app.post(API.aiIndex, async (c) => {
    // Rebuilding the whole-workspace index is an instance-wide maintenance action
    // (it reads every page), so gate it to an instance writer (owner/admin/loopback)
    // — a viewer/guest can't trigger a global re-index.
    await requireCreate(c, store);
    const index = await ai.ensureIndex(true);
    return c.json({pages: new Set(index.docs.map((d) => d.pageId)).size, chunks: index.docs.length});
  });

  app.post(API.aiSearch, async (c) => {
    const {query, limit} = (await c.req.json()) as {query?: string; limit?: number};
    if (!query?.trim()) return c.json({results: [], mode: 'lexical'});
    // Paid-inference gate (N6): hybrid search EMBEDS the query (+ lexical candidates)
    // on a paid engine — openai's `/v1/embeddings`, billed per call — so an anonymous
    // guest on a claimed instance could otherwise drive paid embeddings (the same
    // billing-abuse class the generation routes close). Require a verified principal
    // when the configured provider is paid. This is ADDITIVE to the per-principal read
    // filtering below (cost control), not a replacement for it.
    await requirePaidInferenceAccess(c, store, (await ai.getConfig()).provider);
    // The index spans every page; filter ranked hits to the ones THIS principal may
    // read so search can't surface restricted/members snippets on a shared instance.
    // The access base is resolved once and amortised across the per-page checks.
    const principal = c.get('principal');
    const base = await store.accessBase(principal);
    return c.json(
      await ai.search(query, Math.min(Math.max(limit ?? 8, 1), 25), (pageId) => store.canReadPage(principal, pageId, base)),
    );
  });

  app.post(API.aiTasks, async (c) => {
    const {goal, context} = (await c.req.json()) as {goal?: string; context?: string};
    if (!goal?.trim()) return c.json({error: 'goal is required'}, 400);
    await requirePaidInferenceAccess(c, store, (await ai.getConfig()).provider);
    try {
      return c.json(await ai.tasks(goal, context));
    } catch (err) {
      return c.json({error: err instanceof Error ? err.message : String(err)}, 503);
    }
  });

  app.post(API.aiGenerate, async (c) => {
    const {prompt, system, maxTokens} = (await c.req.json()) as {prompt?: string; system?: string; maxTokens?: number};
    if (!prompt?.trim()) return c.json({error: 'prompt is required'}, 400);
    await requirePaidInferenceAccess(c, store, (await ai.getConfig()).provider);
    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      try {
        await ai.generate(prompt, {
          system,
          maxTokens,
          signal: abort.signal,
          onToken: (token) => void stream.writeSSE({data: JSON.stringify({token})}),
        });
        await stream.writeSSE({data: JSON.stringify({done: true})});
      } catch (err) {
        await stream.writeSSE({data: JSON.stringify({error: err instanceof Error ? err.message : String(err)})});
      }
    });
  });

  app.post(API.aiComplete, async (c) => {
    const {text, instruction} = (await c.req.json()) as {text?: string; instruction?: string};
    await requirePaidInferenceAccess(c, store, (await ai.getConfig()).provider);
    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      try {
        await ai.complete(text ?? '', instruction, {
          signal: abort.signal,
          maxTokens: 400,
          onToken: (token) => void stream.writeSSE({data: JSON.stringify({token})}),
        });
        await stream.writeSSE({data: JSON.stringify({done: true})});
      } catch (err) {
        await stream.writeSSE({data: JSON.stringify({error: err instanceof Error ? err.message : String(err)})});
      }
    });
  });

  app.post(API.aiModelDownload, async (c) => {
    // Fetches a caller-supplied URL onto the server's disk (SSRF + disk-fill
    // surface) — instance-writer only.
    await requireCreate(c, store);
    const {url} = (await c.req.json().catch(() => ({}))) as {url?: string};
    return c.json(await ai.startDownload(url));
  });

  // The agent harness: runs the tool loop against the workspace and streams
  // each step (tool call, tool result, reasoning, proposals, final answer) as
  // its own SSE frame.
  app.post(API.agentChat, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      messages?: AgentChatMessage[];
      provider?: AiProvider;
      model?: string;
      effort?: AiEffort;
      thinking?: boolean;
      skills?: string[];
      pageId?: string;
      selection?: string;
      allowDirectEdits?: boolean;
    };
    const turns = (body.messages ?? []).filter(
      (m): m is AgentMessage => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string',
    );
    if (turns.length === 0) return c.json({error: 'messages are required'}, 400);

    // Fall back to the configured defaults when the request omits them.
    const config = await ai.getConfig();
    // Paid-inference gate (N6): an anonymous guest must not drive a paid/hosted
    // engine on a claimed instance. Check the EFFECTIVE provider — the
    // per-conversation override if present, else the configured default — so an
    // override to openai/claude is fenced too, while a free override stays open.
    await requirePaidInferenceAccess(c, store, body.provider ?? config.provider);
    const effort = body.effort ?? config.effort ?? 'med';
    const thinking = body.thinking ?? config.thinking ?? true;
    const skills = await ai.skills.resolve(body.skills ?? []);
    const pluginTools = await collectPluginTools(store);

    // Ambient context: the page the user is viewing (fetched here so we don't
    // ship its body over the wire twice) + their current selection.
    const selection = body.selection?.trim() || undefined;
    let context: {pageTitle?: string; pageId?: string; pageText?: string; selection?: string} | undefined;
    if (body.pageId || selection) {
      // Access-gate the ambient page so the agent can't be handed a page this
      // caller can't read (getPageFor → null for a non-member on a restricted/
      // members page); a non-reader just gets no page context.
      const page = body.pageId ? await store.getPageFor(c.get('principal'), body.pageId).catch(() => null) : null;
      const pageText = page ? snapshotText(page.data).slice(0, 4000) || undefined : undefined;
      if (pageText || selection) {
        context = {pageTitle: page?.name ?? undefined, pageId: body.pageId, pageText, selection};
      }
    }

    // Per-conversation engine override (the agent drawer's provider/model pickers).
    const engineOverride = body.provider || body.model ? {provider: body.provider, model: body.model} : undefined;
    // Thread the request principal so the agent's autonomous read/write tools are
    // bounded by the SAME per-page/ACL decisions the content routes enforce — the
    // runner can't be driven to read/edit pages this caller can't (OB-190 follow-up).
    const runner = new AgentRunner(ai, store, {effort, thinking, engineOverride, skills, pluginTools, context, allowDirectEdits: body.allowDirectEdits === true, onPagesChanged, principal: c.get('principal')});
    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      await runner.run(turns, async (event) => {
        if (abort.signal.aborted) return;
        await stream.writeSSE({data: JSON.stringify(event)});
      });
      await stream.writeSSE({data: JSON.stringify({done: true})});
    });
  });

  // ── Prompt/recipe skills (per-workspace, user-authored markdown) ─────────────
  app.get(API.aiSkills, async (c) => c.json(await ai.skills.list()));

  app.put(API.aiSkills, async (c) => {
    // Skills are workspace-shared prompt/recipe definitions injected into every
    // user's agent runs — mutations are instance-writer only.
    await requireCreate(c, store);
    const {skill} = (await c.req.json().catch(() => ({}))) as {skill?: AiSkill};
    if (!skill?.name?.trim()) return c.json({error: 'skill.name is required'}, 400);
    try {
      return c.json(await ai.skills.upsert(skill));
    } catch (err) {
      return c.json({error: err instanceof Error ? err.message : String(err)}, 400);
    }
  });

  // NOTE: registered as a template (`:name` param), NOT via `API.aiSkill(':name')`
  // — that helper percent-encodes the colon, which registers the literal path
  // `/api/ai/skills/%3Aname` and never matches a real skill name.
  app.delete(`${API.aiSkills}/:name`, async (c) => {
    await requireCreate(c, store);
    const removed = await ai.skills.remove(c.req.param('name') ?? '');
    return c.json({removed});
  });
}

/**
 * Paid-inference gate (N6). The generation routes (`agent/chat`, `tasks`,
 * `generate`, `complete`) all run the inference engine. When that engine is a
 * PAID / hosted provider ({@link isPaidProvider} — openai/claude bill per token
 * and send content off-box, unlike the free in-process off/mock/llama/mlx), an
 * anonymous guest must not be able to drive it: on a CLAIMED (multi-user,
 * network-exposable) instance a `guestAccess='write'` guest otherwise passes the
 * request gate and could rack up inference cost (a billing-abuse / DoS vector).
 * So for a paid engine we require a verified principal — a `jws` user or the
 * loopback owner (`local`).
 *
 * Deliberately left open (no regression):
 *  - free / local providers (off/mock/llama/mlx) — anyone, as today;
 *  - a legacy single-user (UNCLAIMED) instance — loopback-only by the §2.6
 *    exposure invariant, so there is no remote guest to fence out;
 *  - any authenticated user (jws/local).
 */
async function requirePaidInferenceAccess(c: Context<AppEnv>, store: PageStore, provider: AiProvider): Promise<void> {
  if (!isPaidProvider(provider)) return;
  const principal = c.get('principal');
  if (principal.verifiedVia === 'jws' || principal.verifiedVia === 'local') return;
  // An unauthenticated (guest / unverified) caller may use paid inference only on
  // a legacy unclaimed instance; once claimed, sign-in is required.
  const {ownerSubject} = await store.getInstanceConfig();
  if (ownerSubject === undefined) return;
  throw new HTTPException(403, {message: 'sign in to use the hosted AI provider on this instance'});
}

/** Read agent tools declared by enabled plugins (from the stored manifests). */
async function collectPluginTools(store: PageStore): Promise<PluginAgentTool[]> {
  try {
    const plugins = await store.listPlugins();
    const out: PluginAgentTool[] = [];
    for (const p of plugins) {
      if (!p.enabled) continue;
      for (const tool of p.manifest.agentTools ?? []) {
        if (tool?.name && tool?.description && (tool.action === 'append_blocks' || tool.action === 'prompt')) {
          out.push(tool);
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}
