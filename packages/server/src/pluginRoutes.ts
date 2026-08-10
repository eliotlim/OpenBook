import {Hono} from 'hono';
import {API, validateManifest, type PluginPackage} from '@book.dev/sdk';
import {PluginDowngradeError, type PageStore} from './store';
import type {AppEnv} from './appEnv';
import {requireCreate, requireInstanceOwner} from './access';

/** Max total source size per plugin (sources are stored inline as JSONB). */
const MAX_PLUGIN_BYTES = 2 * 1024 * 1024;

/**
 * The `/api/plugins` surface: installed extensions, stored per library so
 * every connected client runs the same set. The server validates SHAPE only
 * — signature verification happens client-side against the user's trusted
 * registry keys (the server never decides what the user trusts).
 *
 * Access: the source-bearing LIST is instance-writer-only (`requireCreate`,
 * GATE-7). Mutations are stricter: only the real instance owner may install,
 * enable, disable, or remove code that every connected client executes. The
 * owner gate never treats an unclaimed anonymous webview caller as trusted; the
 * desktop owner retains access through the local-owner transport signal.
 */
export function mountPluginRoutes(app: Hono<AppEnv>, store: PageStore): void {
  app.get(API.plugins, async (c) => {
    await requireCreate(c, store);
    return c.json(await store.listPlugins());
  });

  app.post(API.plugins, async (c) => {
    await requireInstanceOwner(c, store);
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
    // Downgrades are refused unless the caller says so explicitly (OB-641):
    // an older version can silently reopen holes a newer one fixed.
    const allowDowngrade = c.req.query('allowDowngrade') === '1';
    try {
      return c.json(await store.upsertPlugin({manifest: pkg!.manifest, files: pkg!.files, signature: pkg!.signature}, {allowDowngrade}), 201);
    } catch (err) {
      if (err instanceof PluginDowngradeError) return c.json({error: err.message}, 409);
      throw err;
    }
  });

  app.patch(`${API.plugins}/:id`, async (c) => {
    await requireInstanceOwner(c, store);
    const {enabled} = (await c.req.json()) as {enabled?: boolean};
    if (typeof enabled !== 'boolean') return c.json({error: 'enabled (boolean) is required'}, 400);
    const plugin = await store.setPluginEnabled(c.req.param('id'), enabled);
    return plugin ? c.json(plugin) : c.json({error: 'plugin not found'}, 404);
  });

  app.delete(`${API.plugins}/:id`, async (c) => {
    await requireInstanceOwner(c, store);
    const removed = await store.removePlugin(c.req.param('id'));
    return removed ? c.body(null, 204) : c.json({error: 'plugin not found'}, 404);
  });
}
