import {Hono} from 'hono';
import {streamSSE} from 'hono/streaming';
import {API, type AiConfig} from '@open-book/sdk';
import type {AiService} from './service';

/**
 * The `/api/ai/*` surface. Generation endpoints stream tokens as SSE
 * (`data: {"token": "..."}` frames, closed by `data: {"done": true}`);
 * everything else is plain JSON. Engine failures return 503 with a
 * human-readable `error` so the UI can guide the user to Settings → AI.
 */
export function mountAiRoutes(app: Hono, ai: AiService): void {
  app.get(API.aiStatus, async (c) => c.json(await ai.status()));

  app.put(API.aiConfig, async (c) => {
    const body = (await c.req.json()) as AiConfig;
    if (!['off', 'mock', 'llama', 'mlx', 'openai'].includes(body.provider)) {
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
}
