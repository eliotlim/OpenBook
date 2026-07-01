import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  HttpDataClient,
  LIVE_OPEN_GRACE_MS,
  LIVE_POLL_AFTER_ERRORS,
  LIVE_POLL_INTERVAL_MS,
  LIVE_RECONNECT_DEBOUNCE_MS,
} from './client';
import type {LiveSourceLike} from './client';

/**
 * A hand-driven {@link LiveSourceLike} standing in for `EventSource`: tests fire
 * `open`/`error` explicitly, so the live stream's SSE-vs-poll decision is fully
 * deterministic under fake timers.
 */
class FakeSource implements LiveSourceLike {
  readonly handlers = new Map<string, Array<(e: {data?: string}) => void>>();
  closed = false;

  addEventListener(type: string, handler: (e: {data?: string}) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: string): void {
    for (const h of this.handlers.get(type) ?? []) h({data});
  }
}

/**
 * An {@link HttpDataClient} whose live source and fetch transport are both fake.
 * `paths` records every request the client makes, so the number of resyncs (each
 * poll/reconnect issues exactly one `GET /api/pages` when only a page-list
 * listener is open) is observable as `paths.length`.
 */
function makeClient() {
  let source: FakeSource | null = null;
  const paths: string[] = [];
  const client = new HttpDataClient('', undefined, {
    fetchImpl: (input: string): Promise<Response> => {
      paths.push(input);
      return Promise.resolve(new Response('[]', {status: 200, headers: {'content-type': 'application/json'}}));
    },
    createLiveSource: () => {
      source = new FakeSource();
      return source;
    },
  });
  return {client, paths, getSource: (): FakeSource => source as FakeSource};
}

describe('LiveStream poll fallback', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('falls back to polling when the SSE stream never opens', async () => {
    vi.useFakeTimers();
    const {client, paths} = makeClient();
    const unsub = client.subscribePages(() => {});

    // No polling before the grace window elapses — we still trust pure SSE.
    expect(paths.length).toBe(0);

    // Grace expires without an `open` → enter poll mode with an immediate resync.
    await vi.advanceTimersByTimeAsync(LIVE_OPEN_GRACE_MS);
    expect(paths.length).toBe(1);

    // One resync per interval thereafter.
    await vi.advanceTimersByTimeAsync(LIVE_POLL_INTERVAL_MS);
    expect(paths.length).toBe(2);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_INTERVAL_MS);
    expect(paths.length).toBe(3);

    unsub();
  });

  it('starts polling after repeated pre-open errors without waiting the grace window', async () => {
    vi.useFakeTimers();
    const {client, paths, getSource} = makeClient();
    const unsub = client.subscribePages(() => {});
    const source = getSource();

    // Below the threshold: still waiting on SSE, no polling yet.
    for (let i = 0; i < LIVE_POLL_AFTER_ERRORS - 1; i++) source.emit('error');
    await vi.advanceTimersByTimeAsync(0);
    expect(paths.length).toBe(0);

    // The threshold-th pre-open error trips poll mode early (an immediate resync).
    source.emit('error');
    await vi.advanceTimersByTimeAsync(0);
    expect(paths.length).toBe(1);

    unsub();
  });

  it('never polls once the SSE stream opens, and clears the pending grace timer', async () => {
    vi.useFakeTimers();
    const {client, paths, getSource} = makeClient();
    const unsub = client.subscribePages(() => {});

    // `open` lands inside the grace window → pure SSE, grace timer cleared.
    getSource().emit('open');
    await vi.advanceTimersByTimeAsync(LIVE_OPEN_GRACE_MS + 5 * LIVE_POLL_INTERVAL_MS);
    expect(paths.length).toBe(0);

    unsub();
  });

  it('exits poll mode when the SSE stream finally opens', async () => {
    vi.useFakeTimers();
    const {client, paths, getSource} = makeClient();
    const unsub = client.subscribePages(() => {});

    await vi.advanceTimersByTimeAsync(LIVE_OPEN_GRACE_MS); // → poll mode
    await vi.advanceTimersByTimeAsync(LIVE_POLL_INTERVAL_MS);
    expect(paths.length).toBe(2);

    // SSE recovers: the poll timer is cleared and no further polling happens.
    getSource().emit('open');
    const settled = paths.length;
    await vi.advanceTimersByTimeAsync(5 * LIVE_POLL_INTERVAL_MS);
    expect(paths.length).toBe(settled);

    unsub();
  });

  it('cleans up the source and the poll timer on unsubscribe', async () => {
    vi.useFakeTimers();
    const {client, paths, getSource} = makeClient();
    const unsub = client.subscribePages(() => {});

    await vi.advanceTimersByTimeAsync(LIVE_OPEN_GRACE_MS); // enter poll mode
    const source = getSource();
    expect(source.closed).toBe(false);
    const atUnsub = paths.length;

    unsub();
    expect(source.closed).toBe(true); // EventSource closed

    // Poll timer cleared: no resyncs leak after the last listener is gone.
    await vi.advanceTimersByTimeAsync(10 * LIVE_POLL_INTERVAL_MS);
    expect(paths.length).toBe(atUnsub);

    unsub(); // idempotent
  });
});

/**
 * Collab T7 — the reopen-after-drop reconnect signal that lets the relay/awareness
 * providers re-handshake tightly (rather than waiting out the coarse snapshot resync).
 * Fires only on a genuine reopen (a drop then a fresh `open`), trailing-debounced against
 * a flapping connection, and never in poll-mode — where convergence stays at snapshot-rate.
 */
describe('LiveStream reconnect signal (Collab T7)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires on SSE reopen-after-drop (trailing-debounced), never on the first open', async () => {
    vi.useFakeTimers();
    const {client, getSource} = makeClient();
    let reconnects = 0;
    const unsubContent = client.subscribePages(() => {}); // opens the stream
    const unsubReconnect = client.subscribeReconnect(() => {
      reconnects += 1;
    });
    const source = getSource();

    // First open (no prior error) → the one-shot handshakes cover connect; no reconnect.
    source.emit('open');
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_DEBOUNCE_MS + 50);
    expect(reconnects).toBe(0);

    // A drop then a reopen → the reconnect signal fires, but only after it settles.
    source.emit('error');
    source.emit('open');
    expect(reconnects).toBe(0); // trailing-debounced — not synchronous with the reopen
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_DEBOUNCE_MS);
    expect(reconnects).toBe(1);

    unsubReconnect();
    unsubContent();
  });

  it('coalesces a flapping reconnect into a single signal (flap-guard)', async () => {
    vi.useFakeTimers();
    const {client, getSource} = makeClient();
    let reconnects = 0;
    const unsubContent = client.subscribePages(() => {});
    const unsubReconnect = client.subscribeReconnect(() => {
      reconnects += 1;
    });
    const source = getSource();
    source.emit('open'); // initial connect

    // Flap: repeated error/open within the debounce window. Each reopen restarts the
    // trailing timer, so nothing fires while it's still flapping.
    for (let i = 0; i < 5; i += 1) {
      source.emit('error');
      source.emit('open');
      await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_DEBOUNCE_MS / 2);
    }
    expect(reconnects).toBe(0);

    // Once it stabilises for the full window, exactly ONE signal fires — not one per flap.
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_DEBOUNCE_MS);
    expect(reconnects).toBe(1);

    unsubReconnect();
    unsubContent();
  });

  it('never fires in poll-mode (no live SSE → convergence stays at snapshot-rate)', async () => {
    vi.useFakeTimers();
    const {client} = makeClient();
    let reconnects = 0;
    const unsubContent = client.subscribePages(() => {}); // opens; never emits `open`
    const unsubReconnect = client.subscribeReconnect(() => {
      reconnects += 1;
    });

    // The stream never opens → poll fallback. Poll resyncs must not masquerade as reconnects.
    await vi.advanceTimersByTimeAsync(LIVE_OPEN_GRACE_MS + 5 * LIVE_POLL_INTERVAL_MS);
    expect(reconnects).toBe(0);

    unsubReconnect();
    unsubContent();
  });

  it('stops firing once unsubscribed', async () => {
    vi.useFakeTimers();
    const {client, getSource} = makeClient();
    let reconnects = 0;
    const unsubContent = client.subscribePages(() => {});
    const unsubReconnect = client.subscribeReconnect(() => {
      reconnects += 1;
    });
    const source = getSource();
    source.emit('open');

    source.emit('error');
    source.emit('open');
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_DEBOUNCE_MS);
    expect(reconnects).toBe(1);

    unsubReconnect(); // gone
    source.emit('error');
    source.emit('open');
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_DEBOUNCE_MS + 50);
    expect(reconnects).toBe(1); // no further signals

    unsubContent();
  });
});

/**
 * Assets A2 — the DataClient asset contract on the HTTP path. Both `putAsset`
 * (upload) and `getAsset` (fetch) go over base64-JSON, DELIBERATELY, so they stay
 * byte-exact on BOTH the web-http and desktop-IPC (`tauriFetch`) transports — the
 * IPC bridge corrupts raw binary bodies. These assert the wire shape + a byte-exact
 * round-trip (including high bytes and a large payload that would overflow a naive
 * `String.fromCharCode(...)` base64 encoder).
 */
describe('HttpDataClient assets (base64-JSON is byte-exact on the http path)', () => {
  const jsonRes = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

  it('putAsset POSTs base64-JSON to /api/assets?pageId and returns {id}', async () => {
    let captured: {url: string; init?: RequestInit} | null = null;
    const client = new HttpDataClient('https://x', undefined, {
      fetchImpl: (url, init) => {
        captured = {url, init};
        return Promise.resolve(jsonRes({id: 'deadbeef'}, 201));
      },
    });
    const bytes = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
    const {id} = await client.putAsset(bytes, 'image/png', 'page 1');

    expect(id).toBe('deadbeef');
    expect(captured!.url).toBe('https://x/api/assets?pageId=page%201'); // pageId url-encoded
    expect(captured!.init!.method).toBe('POST');
    const body = JSON.parse(String(captured!.init!.body)) as {data: string; mime: string};
    expect(body.mime).toBe('image/png');
    // The base64 body decodes byte-exact back to the original bytes.
    expect(Array.from(Uint8Array.from(atob(body.data), (c) => c.charCodeAt(0)))).toEqual(Array.from(bytes));
  });

  it('getAsset decodes the base64-JSON variant byte-exact', async () => {
    const bytes = new Uint8Array([9, 8, 7, 0, 255, 128, 64]);
    let seenUrl = '';
    const client = new HttpDataClient('https://x', undefined, {
      fetchImpl: (url) => {
        seenUrl = url;
        return Promise.resolve(
          jsonRes({id: 'abc', mime: 'image/webp', size: bytes.length, data: btoa(String.fromCharCode(...bytes))}),
        );
      },
    });
    const got = await client.getAsset('abc');
    expect(seenUrl).toBe('https://x/api/assets/abc?encoding=base64'); // the byte-safe variant
    expect(got).not.toBeNull();
    expect(got!.mime).toBe('image/webp');
    expect(Array.from(got!.bytes)).toEqual(Array.from(bytes));
  });

  it('getAsset returns null on a 404 (missing or read-gated — no oracle)', async () => {
    const client = new HttpDataClient('https://x', undefined, {
      fetchImpl: () => Promise.resolve(jsonRes({error: 'asset not found'}, 404)),
    });
    expect(await client.getAsset('nope')).toBeNull();
  });

  it('round-trips a large payload through a fake in-memory store (chunked base64, no overflow)', async () => {
    // 300 KiB exercises the 32 KiB-chunked encoder; a naive spread would overflow.
    const bytes = new Uint8Array(300 * 1024);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
    const store = new Map<string, {mime: string; data: string}>();
    const client = new HttpDataClient('', undefined, {
      fetchImpl: (_url, init) => {
        if (init?.method === 'POST') {
          const b = JSON.parse(String(init.body)) as {data: string; mime: string};
          store.set('id1', b);
          return Promise.resolve(jsonRes({id: 'id1'}, 201));
        }
        const rec = store.get('id1')!;
        return Promise.resolve(jsonRes({id: 'id1', mime: rec.mime, size: 0, data: rec.data}));
      },
    });
    const {id} = await client.putAsset(bytes, 'image/png', 'p');
    const got = await client.getAsset(id);
    expect(got!.bytes.length).toBe(bytes.length);
    expect(Array.from(got!.bytes)).toEqual(Array.from(bytes)); // byte-exact end to end
  });
});
