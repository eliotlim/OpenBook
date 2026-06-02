import {Hono} from 'hono';
import {cors} from 'hono/cors';
import {streamSSE} from 'hono/streaming';
import {API, type PageInput} from '@open-book/sdk';
import {PageStore} from './store';
import {PageHub} from './hub';

/**
 * Build the Hono app over a page store. Routes implement the shared
 * `@open-book/sdk` contract. Every write publishes to an in-memory {@link PageHub},
 * and the SSE endpoints relay those events to connected clients — the
 * server-driven refresh loop that powers real-time collaboration.
 */
export function createApp(store: PageStore): Hono {
  const app = new Hono();
  const hub = new PageHub();

  // Push the latest page list to list subscribers (nav stays live).
  const broadcastList = async (): Promise<void> => {
    hub.publishList(await store.listPages());
  };

  app.use('*', cors());

  app.get(API.health, (c) => c.text('ok'));

  app.get(API.pages, async (c) => c.json(await store.listPages()));

  app.post(API.pages, async (c) => {
    const input = await c.req.json<PageInput>();
    const page = await store.upsertPage(input);
    hub.publishPage(page);
    await broadcastList();
    return c.json(page, 201);
  });

  app.get(`${API.pages}/:id`, async (c) => {
    const page = await store.getPage(c.req.param('id'));
    return page ? c.json(page) : c.json({error: 'page not found'}, 404);
  });

  app.put(`${API.pages}/:id`, async (c) => {
    const input = await c.req.json<PageInput>();
    input.id = c.req.param('id');
    const page = await store.upsertPage(input);
    hub.publishPage(page);
    await broadcastList();
    return c.json(page);
  });

  app.patch(`${API.pages}/:id`, async (c) => {
    const body = await c.req.json<{name?: string | null}>();
    const page = await store.renamePage(c.req.param('id'), body.name ?? null);
    if (!page) return c.json({error: 'page not found'}, 404);
    hub.publishPage(page);
    await broadcastList();
    return c.json(page);
  });

  app.delete(`${API.pages}/:id`, async (c) => {
    const id = c.req.param('id');
    const deleted = await store.deletePage(id);
    if (!deleted) return c.json({error: 'page not found'}, 404);
    hub.publishDeleted(id);
    await broadcastList();
    return c.body(null, 204);
  });

  // ── Live update streams (Server-Sent Events) ──────────────────────────────

  app.get(API.stream, (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({event: 'list', data: JSON.stringify(await store.listPages())});
      const unsubscribe = hub.subscribeList((event) => {
        void stream.writeSSE({event: 'list', data: JSON.stringify(event.pages)}).catch(() => undefined);
      });
      stream.onAbort(unsubscribe);
      try {
        while (!stream.aborted) {
          await stream.sleep(25_000);
          await stream.writeSSE({event: 'ping', data: ''});
        }
      } finally {
        unsubscribe();
      }
    }),
  );

  app.get(`${API.pages}/:id/stream`, (c) => {
    const id = c.req.param('id');
    return streamSSE(c, async (stream) => {
      const initial = await store.getPage(id);
      if (initial) await stream.writeSSE({event: 'page', data: JSON.stringify(initial)});
      const unsubscribe = hub.subscribePage(id, (event) => {
        if (event.type === 'page') {
          void stream.writeSSE({event: 'page', data: JSON.stringify(event.page)}).catch(() => undefined);
        } else {
          void stream.writeSSE({event: 'deleted', data: JSON.stringify({id: event.id})}).catch(() => undefined);
        }
      });
      stream.onAbort(unsubscribe);
      try {
        while (!stream.aborted) {
          await stream.sleep(25_000);
          await stream.writeSSE({event: 'ping', data: ''});
        }
      } finally {
        unsubscribe();
      }
    });
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
