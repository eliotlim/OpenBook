import {Hono} from 'hono';
import {cors} from 'hono/cors';
import {streamSSE} from 'hono/streaming';
import {
  API,
  type CommentInput,
  type DatabaseInput,
  type DatabaseUpdate,
  type ImportRequest,
  type PageInput,
  type RowInput,
  type SuggestionInput,
  type SuggestionStatus,
  type SuggestionUpdate,
} from '@book.dev/sdk';
import {PageStore} from './store';
import {PageHub} from './hub';
import {mountAiRoutes} from './ai/routes';
import {mountPluginRoutes} from './pluginRoutes';
import type {AiService} from './ai/service';

/**
 * Build the Hono app over a page store. Routes implement the shared
 * `@book.dev/sdk` contract. Every write publishes to an in-memory {@link PageHub},
 * and the SSE endpoints relay those events to connected clients — the
 * server-driven refresh loop that powers real-time collaboration.
 */
/**
 * Constant-time string compare (avoids leaking the token length/contents via
 * timing). Returns false on any length mismatch.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface AppOptions {
  /**
   * When set, every `/api/*` request must present this token — as
   * `Authorization: Bearer <token>` or a `?token=` query param (the latter so
   * the SSE `EventSource`, which can't set headers, can authenticate). Used when
   * the desktop publishes its server on the LAN; unset on loopback (local-only),
   * so the local UX needs no token. `/health` is always open.
   */
  accessToken?: string;
  /**
   * True when the store is embedded PGlite (desktop / web webview), false for an
   * external Postgres. Gates the heavy-compaction route: `VACUUM FULL` only makes
   * sense for the self-maintaining embedded DB; a shared Postgres autovacuums and
   * must not be exclusively locked by a client. See OB-164.
   */
  embedded?: boolean;
}

export function createApp(store: PageStore, ai?: AiService, hub: PageHub = new PageHub(), opts: AppOptions = {}): Hono {
  const app = new Hono();

  // Push the latest page list to list subscribers (nav stays live).
  const broadcastList = async (): Promise<void> => {
    ai?.invalidateIndex(); // any broadcast-worthy write staleness-marks search
    hub.publishList(await store.listPages());
  };

  // Push a database's latest rows to its subscribers (table/list views stay
  // live). Skipped when nobody is watching to avoid a needless row query on
  // every row-page content save.
  const broadcastRows = async (databaseId: string): Promise<void> => {
    if (!hub.hasRowsListeners(databaseId)) return;
    hub.publishRows(databaseId, await store.listRows(databaseId));
  };

  app.use('*', cors());

  // API responses are dynamic; never let a client cache them. The desktop
  // WKWebView shell heuristically caches header-less GETs, which made the Trash
  // dialog keep showing a stale empty `GET /api/trash` even after a page was
  // moved to the trash (the page list still updated, since it also rides the SSE
  // stream — the trash does not). `no-store` keeps every read fresh.
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  // Access-token gate (only when published on the LAN). A missing/wrong token is
  // rejected before any handler runs. The token may ride the Authorization
  // header or a `?token=` query param so `EventSource` (header-less) can connect.
  if (opts.accessToken) {
    const token = opts.accessToken;
    app.use('/api/*', async (c, next) => {
      const auth = c.req.header('Authorization') ?? '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const provided = bearer || c.req.query('token') || '';
      if (!safeEqual(provided, token)) return c.json({error: 'unauthorized'}, 401);
      return next();
    });
  }

  // Optional local-AI subsystem (status/search/generate). Mounted only when
  // the host passed a service; document APIs never depend on it.
  if (ai) mountAiRoutes(app, ai, store, broadcastList);
  mountPluginRoutes(app, store);

  app.get(API.health, (c) => c.text('ok'));

  app.get(API.pages, async (c) => c.json(await store.listPages()));

  app.post(API.pages, async (c) => {
    const input = await c.req.json<PageInput>();
    const page = await store.upsertPage(input);
    hub.publishPage(page);
    await broadcastList();
    // A row page's content changed — refresh its database's expr columns.
    if (page.databaseId) await broadcastRows(page.databaseId);
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
    if (page.databaseId) await broadcastRows(page.databaseId);
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

  // Shallow-merge structured property values (owner, verification, …) onto a
  // page. Publishes the page so an open editor reflects it live, and refreshes
  // the owning database's rows when the page is a row.
  app.patch(`${API.pages}/:id/properties`, async (c) => {
    const body = await c.req.json<{properties?: Record<string, unknown>}>();
    const page = await store.setPageProperties(c.req.param('id'), body.properties ?? {});
    if (!page) return c.json({error: 'page not found'}, 404);
    hub.publishPage(page);
    // The icon shows in the sidebar (it's part of PageMeta), so re-stream the
    // page list when it changes; other properties don't affect the list.
    if (body.properties && 'sys_icon' in body.properties) await broadcastList();
    if (page.databaseId) await broadcastRows(page.databaseId);
    return c.json(page);
  });

  // The backlink graph: pages whose document links to this one.
  app.get(`${API.pages}/:id/backlinks`, async (c) => c.json(await store.listBacklinks(c.req.param('id'))));

  // Reorder / re-nest a page in the sidebar tree: set its parent and the new
  // ordered sibling list under that parent. 404 if the page is gone, 409 if the
  // move would create a cycle (nesting a page under itself or a descendant).
  app.put(`${API.pages}/:id/move`, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<{parentId?: string | null; orderedIds?: string[]}>();
    const existing = await store.getPage(id);
    if (!existing) return c.json({error: 'page not found'}, 404);
    const page = await store.movePage(id, body.parentId ?? null, body.orderedIds ?? []);
    if (!page) return c.json({error: 'invalid move (would create a cycle)'}, 409);
    hub.publishPage(page);
    await broadcastList();
    return c.json(page);
  });

  // Soft delete: move the page (and its nested subtree) to the trash. It stays
  // recoverable via the restore route until the cleanup job purges it.
  app.delete(`${API.pages}/:id`, async (c) => {
    const id = c.req.param('id');
    // Learn the page's database membership before it's gone, so we can refresh
    // the owning database's row list after the delete.
    const existing = await store.getPage(id);
    const deleted = await store.deletePage(id);
    if (!deleted) return c.json({error: 'page not found'}, 404);
    hub.publishDeleted(id);
    await broadcastList();
    if (existing?.databaseId) await broadcastRows(existing.databaseId);
    return c.body(null, 204);
  });

  // ── Whole-space backup ───────────────────────────────────────────────────────

  // Heavy on-demand compaction (VACUUM FULL). Embedded PGlite only — an external
  // Postgres autovacuums and shouldn't be exclusively locked + rewritten by a
  // client, so it answers 409 there (OB-164).
  app.post(API.compact, async (c) => {
    if (!opts.embedded) {
      return c.json({error: 'compaction is only available for the embedded database'}, 409);
    }
    const {before, after} = await store.compact();
    return c.json({before, after, reclaimed: Math.max(0, before - after)});
  });

  app.get(API.exportSpace, async (c) => c.json(await store.exportAll()));

  app.post(API.importSpace, async (c) => {
    const req = await c.req.json<ImportRequest>();
    const result = await store.importBundle(req);
    await broadcastList();
    return c.json(result);
  });

  // ── Trash (soft-deleted pages) ───────────────────────────────────────────────

  app.get(API.trash, async (c) => c.json(await store.listTrash()));

  // Restore a trashed page (and the subtree trashed with it).
  app.post(`${API.pages}/:id/restore`, async (c) => {
    const page = await store.restorePage(c.req.param('id'));
    if (!page) return c.json({error: 'page not found in trash'}, 404);
    hub.publishPage(page);
    await broadcastList();
    if (page.databaseId) await broadcastRows(page.databaseId);
    return c.json(page);
  });

  // Permanently delete a single trashed page (and its subtree, by cascade).
  app.delete(`${API.trash}/:id`, async (c) => {
    const purged = await store.purgePage(c.req.param('id'));
    if (!purged) return c.json({error: 'page not found in trash'}, 404);
    return c.body(null, 204);
  });

  // Permanently empty the whole trash.
  app.delete(API.trash, async (c) => {
    const purged = await store.emptyTrash();
    return c.json({purged});
  });

  // ── Databases ──────────────────────────────────────────────────────────────

  app.post(API.databases, async (c) => {
    const input = await c.req.json<DatabaseInput>();
    const database = await store.createDatabase(input);
    // The host page now hosts a database: refresh its page event + the list so
    // the document area renders the view and the sidebar marks it.
    const host = await store.getPage(database.pageId);
    if (host) hub.publishPage(host);
    await broadcastList();
    return c.json(database, 201);
  });

  app.get(`${API.databases}/:id`, async (c) => {
    const database = await store.getDatabase(c.req.param('id'));
    return database ? c.json(database) : c.json({error: 'database not found'}, 404);
  });

  app.patch(`${API.databases}/:id`, async (c) => {
    const patch = await c.req.json<DatabaseUpdate>();
    const database = await store.updateDatabase(c.req.param('id'), patch);
    if (!database) return c.json({error: 'database not found'}, 404);
    // Schema changes (new/removed columns, filters) affect every row view.
    await broadcastRows(database.id);
    return c.json(database);
  });

  app.delete(`${API.databases}/:id`, async (c) => {
    const id = c.req.param('id');
    const database = await store.getDatabase(id);
    const deleted = await store.deleteDatabase(id);
    if (!deleted) return c.json({error: 'database not found'}, 404);
    // The host page no longer hosts a database; its rows are gone too.
    if (database) {
      const host = await store.getPage(database.pageId);
      if (host) hub.publishPage(host);
    }
    await broadcastList();
    return c.body(null, 204);
  });

  app.get(`${API.pages}/:id/database`, async (c) => {
    const database = await store.getDatabaseByPage(c.req.param('id'));
    return database ? c.json(database) : c.json({error: 'page hosts no database'}, 404);
  });

  app.get(`${API.databases}/:id/rows`, async (c) => {
    return c.json(await store.listRows(c.req.param('id')));
  });

  app.post(`${API.databases}/:id/rows`, async (c) => {
    const id = c.req.param('id');
    const input = await c.req.json<RowInput>().catch(() => ({}) as RowInput);
    const page = await store.createRow(id, input);
    hub.publishPage(page);
    await broadcastRows(id);
    return c.json(page, 201);
  });

  app.put(`${API.databases}/:id/rows/order`, async (c) => {
    const id = c.req.param('id');
    const {orderedIds} = await c.req.json<{orderedIds: string[]}>();
    await store.reorderRows(id, orderedIds ?? []);
    await broadcastRows(id);
    return c.json({ok: true});
  });

  app.patch(`${API.databases}/:id/rows/:rowId`, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<{name?: string | null; properties?: Record<string, unknown>}>();
    const row = await store.updateRow(id, c.req.param('rowId'), body);
    if (!row) return c.json({error: 'row not found'}, 404);
    await broadcastRows(id);
    return c.json(row);
  });

  // ── Suggestions + comments (the review layer) ─────────────────────────────
  // Persisted proposed changes (AI write tools + human "Suggest edit") and a
  // general comment layer. These never auto-apply; accepting a suggestion is a
  // client concern (the editor bridge replays its payload as one CRDT
  // transaction) — the server just records the accepted/rejected status.

  app.get(`${API.pages}/:id/suggestions`, async (c) => {
    const status = c.req.query('status') as SuggestionStatus | undefined;
    return c.json(await store.listSuggestions(c.req.param('id'), status));
  });

  app.post(`${API.pages}/:id/suggestions`, async (c) => {
    const input = await c.req.json<SuggestionInput>();
    const suggestion = await store.createSuggestion({...input, pageId: c.req.param('id')});
    return c.json(suggestion, 201);
  });

  app.patch('/api/suggestions/:id', async (c) => {
    const patch = await c.req.json<SuggestionUpdate>();
    const suggestion = await store.updateSuggestion(c.req.param('id'), patch);
    if (!suggestion) return c.json({error: 'suggestion not found'}, 404);
    return c.json(suggestion);
  });

  app.delete('/api/suggestions/:id', async (c) => {
    const deleted = await store.deleteSuggestion(c.req.param('id'));
    if (!deleted) return c.json({error: 'suggestion not found'}, 404);
    return c.body(null, 204);
  });

  app.get(`${API.pages}/:id/comments`, async (c) => c.json(await store.listComments(c.req.param('id'))));

  app.post(`${API.pages}/:id/comments`, async (c) => {
    const input = await c.req.json<CommentInput>();
    const comment = await store.createComment({...input, pageId: c.req.param('id')});
    return c.json(comment, 201);
  });

  app.delete('/api/comments/:id', async (c) => {
    const deleted = await store.deleteComment(c.req.param('id'));
    if (!deleted) return c.json({error: 'comment not found'}, 404);
    return c.body(null, 204);
  });

  // ── Live update streams (Server-Sent Events) ──────────────────────────────

  // The multiplexed firehose: one connection per client carrying every event.
  // This is what the client uses — it keeps each tab to a single long-lived
  // connection so multiple tabs don't exhaust the browser's per-origin limit.
  app.get(API.live, (c) =>
    streamSSE(c, async (stream) => {
      // Initial snapshot uses the same envelope as live events so the client
      // parses every message uniformly.
      await stream.writeSSE({event: 'list', data: JSON.stringify({type: 'list', pages: await store.listPages()})});
      const unsubscribe = hub.subscribeLive((event) => {
        void stream.writeSSE({event: event.type, data: JSON.stringify(event)}).catch(() => undefined);
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

  app.get(`${API.databases}/:id/stream`, (c) => {
    const id = c.req.param('id');
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({event: 'rows', data: JSON.stringify(await store.listRows(id))});
      const unsubscribe = hub.subscribeRows(id, (event) => {
        void stream.writeSSE({event: 'rows', data: JSON.stringify(event.rows)}).catch(() => undefined);
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
