// Small, dependency-free encoding helpers. We avoid Node's `Buffer` so this
// module runs unchanged on Node, the Vercel edge runtime, and the browser.

const enc = new TextEncoder();
const dec = new TextDecoder();

// Returns an ArrayBuffer-backed view (not SharedArrayBuffer) so the bytes satisfy
// Web Crypto's `BufferSource` under TS 6's stricter typed-array generics.
export function utf8(s: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(s.length * 3);
  const {written} = enc.encodeInto(s, out);
  return out.subarray(0, written) as Uint8Array<ArrayBuffer>;
}

export function fromUtf8(bytes: Uint8Array): string {
  return dec.decode(bytes);
}

/** Base64url-encode bytes (RFC 4648 §5, no padding). */
export function b64uEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode a base64url string back to bytes. Tolerates missing padding. */
export function b64uDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64uEncodeString(s: string): string {
  return b64uEncode(utf8(s));
}

export function b64uDecodeString(s: string): string {
  return fromUtf8(b64uDecode(s));
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Constant-time string compare for secrets/MACs. Always walks the full length of
 * the longer input so timing doesn't leak where two values diverge.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
