import {describe, expect, it, vi} from 'vitest';
import {TunnelClient} from './tunnelClient';
import type {FetchLike} from '../client';
import {decodeBody, decodeControl, encodeControl, type ControlFrame} from './tunnelProtocol';

/**
 * OB-284 regression: the tunnel must forward a response — especially the infinite
 * `/api/live` SSE body — to the relay *as it arrives*, never buffering it. A
 * tunneled browser's `EventSource` has to see HTTP 200 (the `res` frame) the
 * moment headers are known, then live body frames, with no terminal `end` for a
 * stream that never closes. Before the fix the desktop's `localFetch` buffered the
 * whole body (`read_to_end`), so `/api/live` hung until the relay's 120s abort and
 * the tunnel emitted nothing. These tests pin the streaming contract at the
 * tunnel-client seam (a streaming `fetchImpl` + a fake relay socket).
 */

/** A fake relay WebSocket: records what the client sends, and lets a test deliver
 *  inbound control frames. Implements just the surface {@link TunnelClient} uses. */
class FakeWS {
  static instances: FakeWS[] = [];
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  binaryType = 'blob';
  onmessage: ((ev: {data: string | ArrayBuffer}) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: Array<string | Uint8Array> = [];

  constructor(readonly url: string) {
    FakeWS.instances.push(this);
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  /** Deliver an inbound frame as if the relay sent it. */
  deliver(frame: ControlFrame): void {
    this.onmessage?.({data: encodeControl(frame)});
  }

  /** The control frames (JSON text) the client has sent so far. */
  controlFrames(): ControlFrame[] {
    return this.sent.filter((d): d is string => typeof d === 'string').map((d) => decodeControl(d)!);
  }

  /** The decoded binary body frames the client has sent so far. */
  bodyFrames(): Array<{id: number; chunk: Uint8Array}> {
    return this.sent.filter((d): d is Uint8Array => d instanceof Uint8Array).map((d) => decodeBody(d));
  }
}

/** A streaming `fetchImpl` whose body is fed by the returned `controller`, and
 *  which exposes the `init.signal` so a test can assert cancel propagation. */
function streamingFetch() {
  const handle: {
    controller: ReadableStreamDefaultController<Uint8Array> | null;
    signal: AbortSignal | undefined;
    status: number;
  } = {controller: null, signal: undefined, status: 200};

  const fetchImpl: FetchLike = (_url, init) => {
    handle.signal = init?.signal ?? undefined;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        handle.controller = c;
      },
    });
    // A relay-side abort cancels `controller` (via init.signal) → mirror that onto
    // the body stream so the client's reader loop unwinds, exactly as the desktop's
    // streaming localFetch does when it tells Rust to shut the socket down.
    handle.signal?.addEventListener('abort', () => {
      try {
        handle.controller?.error(new DOMException('Aborted', 'AbortError'));
      } catch {
        /* already closed */
      }
    });
    return Promise.resolve(new Response(body, {status: handle.status, headers: {'content-type': 'text/event-stream'}}));
  };

  return {fetchImpl, handle};
}

function makeClient(fetchImpl: FetchLike): {client: TunnelClient; ws: () => FakeWS} {
  FakeWS.instances.length = 0;
  const client = new TunnelClient({
    ticketProvider: () => Promise.resolve({relayWsUrl: 'wss://relay/__tunnel?site=s', ticket: 't'}),
    privateKey: 'unused-no-handshake',
    localOrigin: '',
    fetchImpl,
    webSocketImpl: FakeWS as unknown as typeof WebSocket,
  });
  return {client, ws: () => FakeWS.instances[0]};
}

const enc = new TextEncoder();

describe('TunnelClient streaming', () => {
  it('answers headers immediately, then forwards SSE body frames live (no buffering)', async () => {
    const {fetchImpl, handle} = streamingFetch();
    const {client, ws} = makeClient(fetchImpl);
    client.start();
    await vi.waitFor(() => expect(ws()).toBeTruthy());
    const sock = ws();

    // The relay forwards a browser's EventSource open. `handleRequest` runs and
    // awaits the (streaming) fetch.
    sock.deliver({t: 'req', id: 7, method: 'GET', path: '/api/live', headers: []});

    // The `res` frame (HTTP 200) goes out as soon as headers are known — BEFORE any
    // body has been produced, and with no `end` (the SSE stream is still open).
    await vi.waitFor(() => expect(sock.controlFrames().some((f) => f.t === 'res')).toBe(true));
    const res = sock.controlFrames().find((f) => f.t === 'res');
    expect(res).toMatchObject({t: 'res', id: 7, status: 200});
    expect(sock.bodyFrames()).toHaveLength(0);
    expect(sock.controlFrames().some((f) => f.t === 'end')).toBe(false);

    // Each SSE frame the server emits is forwarded as it arrives — live, not pooled.
    handle.controller!.enqueue(enc.encode('event: list\ndata: {"type":"list"}\n\n'));
    await vi.waitFor(() => expect(sock.bodyFrames()).toHaveLength(1));
    expect(sock.bodyFrames()[0]).toMatchObject({id: 7});
    expect(new TextDecoder().decode(sock.bodyFrames()[0].chunk)).toContain('"type":"list"');

    handle.controller!.enqueue(enc.encode('event: ping\ndata:\n\n'));
    await vi.waitFor(() => expect(sock.bodyFrames()).toHaveLength(2));

    // Still no `end`: an infinite stream stays open.
    expect(sock.controlFrames().some((f) => f.t === 'end')).toBe(false);
  });

  it('propagates a relay-side abort down to the localFetch (cancels the body stream)', async () => {
    const {fetchImpl, handle} = streamingFetch();
    const {client, ws} = makeClient(fetchImpl);
    client.start();
    await vi.waitFor(() => expect(ws()).toBeTruthy());
    const sock = ws();

    sock.deliver({t: 'req', id: 9, method: 'GET', path: '/api/live', headers: []});
    await vi.waitFor(() => expect(sock.controlFrames().some((f) => f.t === 'res')).toBe(true));
    handle.controller!.enqueue(enc.encode('event: ping\ndata:\n\n'));
    await vi.waitFor(() => expect(sock.bodyFrames()).toHaveLength(1));

    // The viewer closed the page → the relay aborts the exchange. The client must
    // abort the in-flight request, which cancels `init.signal` — the desktop bridge
    // turns that into a Rust socket shutdown (asserted here via the signal).
    expect(handle.signal?.aborted).toBe(false);
    sock.deliver({t: 'abort', id: 9});
    await vi.waitFor(() => expect(handle.signal?.aborted).toBe(true));

    // No spurious `abort` frame is sent back (we initiated it), and no further body.
    // The body stream is already errored by the abort, so a late write even throws —
    // proof the source was cancelled, not merely ignored.
    const bodyCount = sock.bodyFrames().length;
    expect(() => handle.controller!.enqueue(enc.encode('late\n\n'))).toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(sock.bodyFrames().length).toBe(bodyCount);
    expect(sock.controlFrames().some((f) => f.t === 'abort')).toBe(false);
  });

  it('streams a finite response and closes it with an `end` frame', async () => {
    const {fetchImpl, handle} = streamingFetch();
    const {client, ws} = makeClient(fetchImpl);
    client.start();
    await vi.waitFor(() => expect(ws()).toBeTruthy());
    const sock = ws();

    sock.deliver({t: 'req', id: 3, method: 'GET', path: '/api/pages', headers: []});
    await vi.waitFor(() => expect(sock.controlFrames().some((f) => f.t === 'res')).toBe(true));

    handle.controller!.enqueue(enc.encode('[{"id":"p1"}]'));
    handle.controller!.close(); // finite body ends
    await vi.waitFor(() => expect(sock.controlFrames().some((f) => f.t === 'end')).toBe(true));

    expect(sock.bodyFrames().map((b) => new TextDecoder().decode(b.chunk)).join('')).toBe('[{"id":"p1"}]');
    const end = sock.controlFrames().find((f) => f.t === 'end');
    expect(end).toMatchObject({t: 'end', id: 3});
  });
});
