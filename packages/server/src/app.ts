import {Hono} from 'hono';
import {cors} from 'hono/cors';
import {API, type PageInput} from '@open-book/sdk';
import {PageStore} from './store';

/**
 * Build the Hono app over a page store. Routes implement the shared
 * `@open-book/sdk` contract, so the server and `HttpDataClient` are guaranteed
 * to agree on paths and payload shapes.
 */
export function createApp(store: PageStore): Hono {
  const app = new Hono();

  // Permissive CORS so a browser (web shell, or another device) can reach a
  // headless or desktop-hosted server directly.
  app.use('*', cors());

  app.get(API.health, (c) => c.text('ok'));

  app.get(API.pages, async (c) => c.json(await store.listPages()));

  app.post(API.pages, async (c) => {
    const input = await c.req.json<PageInput>();
    return c.json(await store.upsertPage(input), 201);
  });

  app.get(`${API.pages}/:id`, async (c) => {
    const page = await store.getPage(c.req.param('id'));
    return page ? c.json(page) : c.json({error: 'page not found'}, 404);
  });

  app.put(`${API.pages}/:id`, async (c) => {
    const input = await c.req.json<PageInput>();
    // The path id is authoritative for PUT.
    input.id = c.req.param('id');
    return c.json(await store.upsertPage(input));
  });

  app.patch(`${API.pages}/:id`, async (c) => {
    const body = await c.req.json<{name?: string | null}>();
    const page = await store.renamePage(c.req.param('id'), body.name ?? null);
    return page ? c.json(page) : c.json({error: 'page not found'}, 404);
  });

  app.delete(`${API.pages}/:id`, async (c) => {
    const deleted = await store.deletePage(c.req.param('id'));
    return deleted ? c.body(null, 204) : c.json({error: 'page not found'}, 404);
  });

  app.onError((err, c) => {
    if (isUniqueViolation(err)) {
      return c.json({error: 'a page with that name already exists'}, 409);
    }
    console.error('OpenBook server error:', err);
    return c.json({error: 'internal server error'}, 500);
  });

  return app;
}

/** Postgres unique-violation (SQLSTATE 23505), across both DB backends. */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {code?: string; message?: string};
  if (e.code === '23505') return true;
  // PGlite surfaces the violation in the message rather than a code field.
  return typeof e.message === 'string' && /duplicate key|unique constraint|pages_name_key/i.test(e.message);
}
