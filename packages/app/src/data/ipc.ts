import {invoke} from '@tauri-apps/api/core';
import {listen, type UnlistenFn} from '@tauri-apps/api/event';
import type {FetchLike, LiveSourceLike} from '@open-book/sdk';

/**
 * The desktop's IPC transport for {@link HttpDataClient}. The local server is
 * portless (it listens on a Unix socket), so instead of `fetch`/`EventSource`
 * the data client tunnels through the Tauri host: each request becomes an
 * `api_request` command, and the live feed arrives as `openbook://live` events
 * the host bridges from the server's SSE stream.
 */

interface ApiResponse {
  status: number;
  body: string;
}

/** A `fetch` that tunnels one request to the local server over host IPC. */
export const tauriFetch: FetchLike = async (input, init = {}) => {
  const method = init.method ?? 'GET';
  const body = typeof init.body === 'string' ? init.body : init.body != null ? String(init.body) : null;
  const res = await invoke<ApiResponse>('api_request', {method, path: input, body});
  // A null-body status (204/304) must not carry a body, or `new Response` throws.
  const bodiless = res.status === 204 || res.status === 205 || res.status === 304;
  return new Response(bodiless || res.body.length === 0 ? null : res.body, {status: res.status});
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
