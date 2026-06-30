import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  HttpDataClient,
  LIVE_OPEN_GRACE_MS,
  LIVE_POLL_AFTER_ERRORS,
  LIVE_POLL_INTERVAL_MS,
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
