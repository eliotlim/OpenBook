/** SHA-256 for CSP hashes, kept synchronous because every export API is sync. */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const hashCache = new Map<string, string>();

const rotateRight = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

function sha256Bytes(text: string): Uint8Array {
  const input = new TextEncoder().encode(text);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const paddedView = new DataView(padded.buffer);
  const bitLength = BigInt(input.length) * 8n;
  paddedView.setUint32(paddedLength - 8, Number(bitLength >> 32n), false);
  paddedView.setUint32(paddedLength - 4, Number(bitLength & 0xffff_ffffn), false);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = paddedView.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const x = words[i - 15];
      const y = words[i - 2];
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + sum1 + choose + SHA256_K[i] + words[i]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  state.forEach((value, index) => digestView.setUint32(index * 4, value, false));
  return digest;
}

function base64(bytes: Uint8Array): string {
  let out = '';
  for (let at = 0; at < bytes.length; at += 3) {
    const a = bytes[at];
    const b = bytes[at + 1];
    const c = bytes[at + 2];
    out += BASE64[a >>> 2];
    out += BASE64[((a & 3) << 4) | ((b ?? 0) >>> 4)];
    out += at + 1 < bytes.length ? BASE64[((b & 15) << 2) | ((c ?? 0) >>> 6)] : '=';
    out += at + 2 < bytes.length ? BASE64[c & 63] : '=';
  }
  return out;
}

/** CSP source expression for the exact text inside one inline script element. */
export function inlineScriptHash(source: string): string {
  const cached = hashCache.get(source);
  if (cached) return cached;
  const hash = `'sha256-${base64(sha256Bytes(source))}'`;
  // The fixed viewer/d3/runtime sources dominate repeat exports. Keep a small
  // bounded cache so determinism does not mean re-hashing megabytes per page.
  if (hashCache.size >= 32) hashCache.clear();
  hashCache.set(source, hash);
  return hash;
}

/** Network-off page policy; only the exact emitted inline scripts may execute. */
export function pageCsp(scriptHashes: readonly string[]): string {
  const scripts = scriptHashes.length > 0 ? [...new Set(scriptHashes)].join(' ') : '\'none\'';
  return [
    'default-src \'none\'',
    'base-uri \'none\'',
    'object-src \'none\'',
    'form-action \'none\'',
    'frame-ancestors \'none\'',
    `script-src ${scripts}`,
    'script-src-attr \'none\'',
    // The renderer relies on generated style attributes (chart dimensions,
    // progress fills, viewer layout). No external stylesheet is permitted.
    'style-src \'unsafe-inline\'',
    'img-src data: blob: https:',
    'font-src data:',
    'media-src data: blob:',
    'frame-src \'self\' data: blob:',
    'connect-src \'none\'',
    'worker-src \'none\'',
    'manifest-src \'none\'',
  ].join('; ');
}
