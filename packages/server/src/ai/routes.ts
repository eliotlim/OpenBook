import {Hono} from 'hono';
import {streamSSE} from 'hono/streaming';
import {API, snapshotText, type AgentChatMessage, type AiConfig, type AiEffort, type AiProvider, type AiSkill, type PluginAgentTool} from '@open-book/sdk';
import type {PageStore} from '../store';
import {AgentRunner, type AgentMessage} from './agent';
import type {AiService} from './service';

/**
 * The `/api/ai/*` surface. Generation endpoints stream tokens as SSE
 * (`data: {"token": "..."}` frames, closed by `data: {"done": true}`);
 * everything else is plain JSON. Engine failures return 503 with a
 * human-readable `error` so the UI can guide the user to Settings → AI.
 */
export function mountAiRoutes(app: Hono, ai: AiService, store: PageStore, onPagesChanged?: () => Promise<void>): void {
  app.get(API.aiStatus, async (c) => c.json(await ai.status()));

  app.put(API.aiConfig, async (c) => {
    const body = (await c.req.json()) as AiConfig;
    if (!['off', 'mock', 'llama', 'mlx', 'openai', 'claude'].includes(body.provider)) {
      return c.json({error: `Unknown provider: ${String(body.provider)}`}, 400);
    }
    return c.json(await ai.setConfig(body));
  });

  app.post(API.aiIndex, async (c) => {
    const index = await ai.ensureIndex(true);
    return c.json({pages: new Set(index.docs.map((d) => d.pageId)).size, chunks: index.docs.length});
  });

  app.post(API.aiSearch, async (c) => {
    const {query, limit} = (await c.req.json()) as {query?: string; limit?: number};
    if (!query?.trim()) return c.json({results: [], mode: 'lexical'});
    return c.json(await ai.search(query, Math.min(Math.max(limit ?? 8, 1), 25)));
  });

  app.post(API.aiTasks, async (c) => {
    const {goal, context} = (await c.req.json()) as {goal?: string; context?: string};
    if (!goal?.trim()) return c.json({error: 'goal is required'}, 400);
    try {
      return c.json(await ai.tasks(goal, context));
    } catch (err) {
      return c.json({error: err instanceof Error ? err.message : String(err)}, 503);
    }
  });

  app.post(API.aiGenerate, async (c) => {
    const {prompt, system, maxTokens} = (await c.req.json()) as {prompt?: string; system?: string; maxTokens?: number};
    if (!prompt?.trim()) return c.json({error: 'prompt is required'}, 400);
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
    const effort = body.effort ?? config.effort ?? 'med';
    const thinking = body.thinking ?? config.thinking ?? true;
    const skills = await ai.skills.resolve(body.skills ?? []);
    const pluginTools = await collectPluginTools(store);

    // Ambient context: the page the user is viewing (fetched here so we don't
    // ship its body over the wire twice) + their current selection.
    const selection = body.selection?.trim() || undefined;
    let context: {pageTitle?: string; pageId?: string; pageText?: string; selection?: string} | undefined;
    if (body.pageId || selection) {
      const page = body.pageId ? await store.getPage(body.pageId).catch(() => null) : null;
      const pageText = page ? snapshotText(page.data).slice(0, 4000) || undefined : undefined;
      if (pageText || selection) {
        context = {pageTitle: page?.name ?? undefined, pageId: body.pageId, pageText, selection};
      }
    }

    // Per-conversation engine override (the agent drawer's provider/model pickers).
    const engineOverride = body.provider || body.model ? {provider: body.provider, model: body.model} : undefined;
    const runner = new AgentRunner(ai, store, {effort, thinking, engineOverride, skills, pluginTools, context, allowDirectEdits: body.allowDirectEdits === true, onPagesChanged});
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
    const {skill} = (await c.req.json().catch(() => ({}))) as {skill?: AiSkill};
    if (!skill?.name?.trim()) return c.json({error: 'skill.name is required'}, 400);
    try {
      return c.json(await ai.skills.upsert(skill));
    } catch (err) {
      return c.json({error: err instanceof Error ? err.message : String(err)}, 400);
    }
  });

  app.delete(API.aiSkill(':name'), async (c) => {
    const removed = await ai.skills.remove(c.req.param('name') ?? '');
    return c.json({removed});
  });
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
