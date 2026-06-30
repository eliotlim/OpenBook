import {Channel, invoke} from '@tauri-apps/api/core';
import {listen, type UnlistenFn} from '@tauri-apps/api/event';
import type {FetchLike, LiveSourceLike} from '@book.dev/sdk';

/**
 * The desktop's IPC transport for {@link HttpDataClient}. The local server is
 * portless (it listens on a Unix socket), so instead of `fetch`/`EventSource`
 * the data client tunnels through the Tauri host: each request becomes an
 * `api_request` command, and the live feed arrives as `openbook://live` events
 * the host bridges from the server's SSE stream.
 */

interface ApiResponse {
  status: number;
  headers: [string, string][];
  body: string;
}

/** A `fetch` that tunnels one request to the local server over host IPC. */
export const tauriFetch: FetchLike = async (input, init = {}) => {
  const method = init.method ?? 'GET';
  // Normalise the body to a string for the single-shot IPC bridge. The data client
  // sends JSON strings; the forwarding tunnel sends a ReadableStream — `String()`
  // would turn that into "[object ReadableStream]", so drain it via Response.
  const raw = init.body;
  const body = raw == null ? null : typeof raw === 'string' ? raw : await new Response(raw as BodyInit).text();
  // Forward request headers (the bridge drops host/connection/content-length).
  const headers = init.headers ? [...new Headers(init.headers as HeadersInit)] : [];
  const res = await invoke<ApiResponse>('api_request', {method, path: input, headers, body});
  // A null-body status (204/304) must not carry a body, or `new Response` throws.
  const bodiless = res.status === 204 || res.status === 205 || res.status === 304;
  return new Response(bodiless || res.body.length === 0 ? null : res.body, {status: res.status, headers: res.headers});
};

/** One message of a streamed response (mirrors Rust's `StreamMessage`). */
type StreamMessage =
  | {kind: 'head'; status: number; headers: [string, string][]}
  | {kind: 'chunk'; data: string} // base64; see `base64ToBytes`
  | {kind: 'end'}
  | {kind: 'error'; message: string};

/**
 * Decode a base64 chunk (Rust's `StreamMessage::Chunk`) back to its exact bytes.
 * The Rust side base64-encodes each body slice — far more compact over the Tauri
 * bridge than serde's JSON integer array (~1.33× vs ~4–6×) — so we decode here.
 * `atob` yields a binary string (one char per byte, 0–255), kept byte-exact by
 * reading `charCodeAt`; the bytes never round-trip through UTF-8.
 */
const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

const safeClose = (c: ReadableStreamDefaultController<Uint8Array> | null): void => {
  try {
    c?.close();
  } catch {
    /* already closed */
  }
};
const safeError = (c: ReadableStreamDefaultController<Uint8Array> | null, err: unknown): void => {
  try {
    c?.error(err);
  } catch {
    /* already closed/errored */
  }
};

/**
 * A **streaming** `fetch` over host IPC, for the forwarding tunnel's `localFetch`.
 *
 * {@link tauriFetch} buffers the whole response (`read_to_end` on the Rust side)
 * before resolving — fine for finite `/api` calls, but it hangs forever on
 * `/api/live`, whose SSE body never closes. A tunneled browser's `EventSource`
 * therefore saw nothing until the relay aborted at 120s (OB-284). This variant
 * resolves the `Response` as soon as the status+headers arrive and feeds the body
 * into a `ReadableStream` chunk-by-chunk, so SSE (and every other response) flows
 * live up the tunnel.
 *
 * Delivery rides a Tauri `Channel` (not app-global events): it's scoped to this
 * one invocation — no cross-window id collision — and ordered by construction, so
 * `head` → `chunk`s → terminal arrive in order without any listener juggling. The
 * channel is Rust→JS only, so cancellation (the relay dropped the request, or the
 * consumer aborts via `init.signal` / the body stream's `cancel`) flows back via
 * `api_request_abort`, keyed by a UUID `streamId` unique across windows, which
 * shuts the Rust socket down.
 */
export const tauriStreamFetch: FetchLike = async (input, init = {}) => {
  const method = init.method ?? 'GET';
  // Normalise the body to a string, draining a ReadableStream (the tunnel sends
  // request bodies as streams) — same as the single-shot path.
  const raw = init.body;
  const body = raw == null ? null : typeof raw === 'string' ? raw : await new Response(raw as BodyInit).text();
  const headers = init.headers ? [...new Headers(init.headers as HeadersInit)] : [];

  // A globally-unique id (across windows) so the JS→Rust abort can't collide with
  // another webview's in-flight stream — the Channel itself needs no id.
  const streamId = globalThis.crypto.randomUUID();
  const signal = init.signal;

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let settled = false;
  let closed = false;

  // Abort the Rust stream (idempotent): close its socket + drop the task.
  const abortRust = (): void => {
    void invoke('api_request_abort', {streamId}).catch(() => undefined);
  };

  return await new Promise<Response>((resolve, reject) => {
    const channel = new Channel<StreamMessage>();
    channel.onmessage = (msg): void => {
      if (msg.kind === 'head') {
        // A null-body status (204/304) must carry no body, or `new Response` throws;
        // there'll be no chunks, just a terminal `end`.
        const bodiless = msg.status === 204 || msg.status === 205 || msg.status === 304;
        const respBody = bodiless
          ? null
          : new ReadableStream<Uint8Array>({
            start: (c) => {
              controller = c;
            },
            // The consumer cancelled the body stream → tear the Rust task down.
            cancel: () => {
              if (!closed) {
                closed = true;
                abortRust();
              }
            },
          });
        settled = true;
        resolve(new Response(respBody, {status: msg.status, headers: msg.headers}));
      } else if (msg.kind === 'chunk') {
        controller?.enqueue(base64ToBytes(msg.data));
      } else if (msg.kind === 'end') {
        closed = true;
        safeClose(controller);
      } else if (msg.kind === 'error') {
        closed = true;
        const err = new Error(msg.message || 'stream failed');
        if (settled) safeError(controller, err);
        else reject(err);
      }
    };

    // Propagate an upstream abort (the tunnel's AbortController on `init.signal`)
    // down to the Rust task, and fail the response if it hadn't resolved yet.
    const onAbort = (): void => {
      if (closed) return;
      closed = true;
      abortRust();
      const err = new DOMException('Aborted', 'AbortError');
      if (settled) safeError(controller, err);
      else reject(err);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return; // never start the stream for an already-aborted request
      }
      signal.addEventListener('abort', onAbort, {once: true});
    }

    // Kick off the streaming request; the response arrives over the channel (the
    // command resolves only when the stream ends), so we don't await it here.
    void invoke('api_request_stream', {streamId, method, path: input, headers, body, channel}).catch((err) => {
      if (!settled && !closed) reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
};

interface LiveFrame {
  event: string;
  data: string;
}
type Handler = (event: {data?: string}) => void;

/**
 * A {@link LiveSourceLike} backed by the host's live bridge. Named SSE frames
 * arrive as `openbook://live` events; connection state ('open'/'error') arrives
 * as `openbook://live-status`, mapping onto the source's open/error handlers so
 * the client resyncs on reconnect (OB-132).
 */
export const createTauriLiveSource = (): LiveSourceLike => {
  const handlers = new Map<string, Handler[]>();
  const fire = (type: string, data?: string): void => {
    for (const h of handlers.get(type) ?? []) h({data});
  };

  let unlistenFrame: UnlistenFn | null = null;
  let unlistenStatus: UnlistenFn | null = null;
  void listen<LiveFrame>('openbook://live', (e) => fire(e.payload.event, e.payload.data)).then((u) => (unlistenFrame = u));
  void listen<string>('openbook://live-status', (e) => fire(e.payload)).then((u) => (unlistenStatus = u));

  // The shared bridge connected before this window subscribed, so we missed its
  // initial replay — simulate a reconnect so the LiveStream resyncs current
  // state (sidebar list, open pages) on the next tick once handlers are wired.
  setTimeout(() => {
    fire('error');
    fire('open');
  }, 0);

  return {
    addEventListener(type, handler) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    close() {
      unlistenFrame?.();
      unlistenStatus?.();
      handlers.clear();
    },
  };
};
