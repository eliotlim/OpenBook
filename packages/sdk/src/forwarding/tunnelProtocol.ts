// The wire protocol for the reverse tunnel between a desktop and its relay. One
// WebSocket carries many concurrent HTTP exchanges, multiplexed by a numeric
// request id. Control frames are JSON (WS text); body chunks are binary (WS
// binary) prefixed with the id, so large payloads and SSE stream without base64
// overhead. Shared by the relay (open.book.pub) and the tunnel client below.

export type ControlFrame =
  // handshake (double-gated attach)
  | {t: 'challenge'; nonce: string}
  | {t: 'attach'; ticket: string; signature: string; clientInfo?: string}
  | {t: 'ready'; siteId: string}
  | {t: 'error'; message: string}
  // request/response multiplexing (relay → desktop is `req`; desktop → relay is `res`)
  | {t: 'req'; id: number; method: string; path: string; headers: [string, string][]}
  | {t: 'res'; id: number; status: number; headers: [string, string][]}
  | {t: 'end'; id: number} // body complete for `id` (from whichever side is sending)
  | {t: 'abort'; id: number; reason?: string}
  // liveness
  | {t: 'ping'}
  | {t: 'pong'};

export function encodeControl(frame: ControlFrame): string {
  return JSON.stringify(frame);
}

export function decodeControl(data: string): ControlFrame | null {
  try {
    const f = JSON.parse(data) as ControlFrame;
    return f && typeof (f as {t?: unknown}).t === 'string' ? f : null;
  } catch {
    return null;
  }
}

/** Binary body frame: [id: uint32 BE][...bytes]. */
export function encodeBody(id: number, chunk: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4 + chunk.byteLength);
  new DataView(out.buffer).setUint32(0, id >>> 0, false);
  out.set(chunk, 4);
  return out;
}

export function decodeBody(buf: Uint8Array): {id: number; chunk: Uint8Array} {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {id: view.getUint32(0, false), chunk: buf.subarray(4)};
}
