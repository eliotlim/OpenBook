import {rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {HttpDataClient, type FetchLike, type LiveSourceLike} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';

/**
 * Collab T0 spike — end-to-end proof of the incremental Y-update relay.
 *
 * Drives TWO `HttpDataClient`s off ONE real Hono app (one shared `PageHub`), so
 * the bytes travel the genuine path: `POST /api/pages/:id/updates` → write gate →
 * `hub.publishPageUpdate` → firehose → per-subscriber read gate → `yupdate` SSE
 * frame → `LiveStream` dispatch. The relay carries OPAQUE bytes (the server never
 * touches Yjs), so the payload here is an arbitrary base64 blob — exactly what the
 * server sees. Yjs merge convergence is Yjs's own guarantee (and is exercised by
 * the UI's `connectPageRelay`); this test pins the transport contract the spike
 * adds.
 */

let seq = 0;
const dirs: string[] = [];
const stores: PageStore[] = [];

async function freshApp(): Promise<ReturnType<typeof createApp>> {
  seq += 1;
  const dir = join(tmpdir(), `ob-relay-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  dirs.push(dir);
  const store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  stores.push(store);
  // No identity provider ⇒ legacy single-user: every caller is a full-access
  // guest, so the relay's write/read gates pass once the page exists.
  return createApp(store, undefined, new PageHub());
}

afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true});
});

/** A `fetchImpl` that routes a client's requests into the in-process Hono app. */
const appFetch = (app: ReturnType<typeof createApp>): FetchLike => (input, init) => app.request(input, init);

/**
 * A {@link LiveSourceLike} that opens the app's real `/api/live` SSE stream and
 * parses its `event:`/`data:` frames, firing handlers by event name — a faithful
 * stand-in for the browser `EventSource`, reading the genuine streamed body.
 */
function appLiveSource(app: ReturnType<typeof createApp>): (url: string) => LiveSourceLike {
  return (url) => {
    const handlers = new Map<string, Array<(e: {data?: string}) => void>>();
    const fire = (type: string, data?: string): void => {
      for (const h of handlers.get(type) ?? []) h({data});
    };
    let cancelled = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    void (async () => {
      const res = await app.request(url);
      fire('open');
      if (!res.body) return;
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let event = 'message';
      let data = '';
      for (;;) {
        const {done, value} = await reader.read();
        if (done || cancelled) break;
        buf += decoder.decode(value, {stream: true});
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data = line.slice(5).trim();
          else if (line === '') {
            // Frame boundary: dispatch and reset.
            if (data.length > 0 || event !== 'message') fire(event, data);
            event = 'message';
            data = '';
          }
        }
      }
    })();

    return {
      addEventListener(type, handler) {
        const list = handlers.get(type) ?? [];
        list.push(handler);
        handlers.set(type, list);
      },
      close() {
        cancelled = true;
        void reader?.cancel().catch(() => undefined);
      },
    };
  };
}

const makeClient = (app: ReturnType<typeof createApp>): HttpDataClient =>
  new HttpDataClient('', undefined, {fetchImpl: appFetch(app), createLiveSource: appLiveSource(app)});

const waitFor = async (predicate: () => boolean, ms = 2000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for relay frame');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('Collab T0 — incremental update relay', () => {
  it('relays an opaque update from one client to another (and echoes to the author)', async () => {
    const app = await freshApp();
    const author = makeClient(app);
    const peer = makeClient(app);

    // The page must exist for the write gate to pass (a missing page 404s).
    const page = await author.savePage({name: 'Shared', data: {editorjs: {blocks: []}, values: [], names: []}});

    const peerSeen: Array<{update: string; clientId: number}> = [];
    const authorSeen: Array<{update: string; clientId: number}> = [];
    peer.subscribePageUpdates(page.id, (update, clientId) => peerSeen.push({update, clientId}));
    author.subscribePageUpdates(page.id, (update, clientId) => authorSeen.push({update, clientId}));

    // Let both /api/live streams establish before publishing.
    await new Promise((r) => setTimeout(r, 100));

    const AUTHOR_CLIENT_ID = 4242;
    const payload = Buffer.from('an-opaque-y-update-blob').toString('base64');
    await author.postPageUpdate(page.id, payload, AUTHOR_CLIENT_ID);

    await waitFor(() => peerSeen.length >= 1 && authorSeen.length >= 1);

    // The peer receives the exact opaque bytes + the author's clientId — enough to
    // apply via Y.applyUpdate and to know it isn't its own echo.
    expect(peerSeen).toEqual([{update: payload, clientId: AUTHOR_CLIENT_ID}]);
    // The firehose ALSO echoes to the author; suppression is the clientId match
    // the UI relay performs (proving why echo-to-author suppression is needed).
    expect(authorSeen).toEqual([{update: payload, clientId: AUTHOR_CLIENT_ID}]);
  });

  it('preserves order across a burst of updates', async () => {
    const app = await freshApp();
    const author = makeClient(app);
    const peer = makeClient(app);
    const page = await author.savePage({name: 'Burst', data: {editorjs: {blocks: []}, values: [], names: []}});

    const seen: string[] = [];
    peer.subscribePageUpdates(page.id, (update) => seen.push(update));
    await new Promise((r) => setTimeout(r, 100));

    const payloads = ['one', 'two', 'three'].map((s) => Buffer.from(s).toString('base64'));
    for (const p of payloads) await author.postPageUpdate(page.id, p, 1);

    await waitFor(() => seen.length >= payloads.length);
    expect(seen).toEqual(payloads);
  });

  it('rejects a malformed update body with 400', async () => {
    const app = await freshApp();
    const author = makeClient(app);
    const page = await author.savePage({name: 'Bad', data: {editorjs: {blocks: []}, values: [], names: []}});

    const res = await app.request(`/api/pages/${page.id}/updates`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({clientId: 1}), // no `update`
    });
    expect(res.status).toBe(400);
  });

  it('404s an update to a non-existent page (write gate hides existence)', async () => {
    const app = await freshApp();
    const res = await app.request(`/api/pages/${randomUUID()}/updates`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({update: Buffer.from('x').toString('base64'), clientId: 1}),
    });
    expect(res.status).toBe(404);
  });
});
