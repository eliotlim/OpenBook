import {Hono} from 'hono';
import {API, validateManifest, type PluginPackage} from '@book.dev/sdk';
import type {PageStore} from './store';

/** Max total source size per plugin (sources are stored inline as JSONB). */
const MAX_PLUGIN_BYTES = 2 * 1024 * 1024;

/**
 * The `/api/plugins` surface: installed extensions, stored per workspace so
 * every connected client runs the same set. The server validates SHAPE only
 * — signature verification happens client-side against the user's trusted
 * registry keys (the server never decides what the user trusts).
 */
export function mountPluginRoutes(app: Hono, store: PageStore): void {
  app.get(API.plugins, async (c) => c.json(await store.listPlugins()));

  app.post(API.plugins, async (c) => {
    const pkg = (await c.req.json().catch(() => null)) as PluginPackage | null;
    const problem = validateManifest(pkg?.manifest);
    if (problem) return c.json({error: problem}, 400);
    if (!pkg!.files || typeof pkg!.files !== 'object' || Object.keys(pkg!.files).length === 0) {
      return c.json({error: 'the package has no files'}, 400);
    }
    const entries = Object.entries(pkg!.files);
    if (entries.some(([p, s]) => typeof p !== 'string' || typeof s !== 'string')) {
      return c.json({error: 'files must map path → source text'}, 400);
    }
    const total = entries.reduce((n, [p, s]) => n + p.length + (s as string).length, 0);
    if (total > MAX_PLUGIN_BYTES) return c.json({error: 'plugin exceeds the 2 MB source limit'}, 413);
    if (!(pkg!.manifest.main in pkg!.files)) {
      return c.json({error: `entry file "${pkg!.manifest.main}" is not in the package`}, 400);
    }
    return c.json(await store.upsertPlugin({manifest: pkg!.manifest, files: pkg!.files, signature: pkg!.signature}), 201);
  });

  app.patch(`${API.plugins}/:id`, async (c) => {
    const {enabled} = (await c.req.json()) as {enabled?: boolean};
    if (typeof enabled !== 'boolean') return c.json({error: 'enabled (boolean) is required'}, 400);
    const plugin = await store.setPluginEnabled(c.req.param('id'), enabled);
    return plugin ? c.json(plugin) : c.json({error: 'plugin not found'}, 404);
  });

  app.delete(`${API.plugins}/:id`, async (c) => {
    const removed = await store.removePlugin(c.req.param('id'));
    return removed ? c.body(null, 204) : c.json({error: 'plugin not found'}, 404);
  });
}
