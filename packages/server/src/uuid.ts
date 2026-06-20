/**
 * Isomorphic UUID v4. The store runs in two homes now — the Node sidecar and,
 * via the `@open-book/server/browser` entry, directly inside the app/web
 * webview's PGlite — so it can't reach for `node:crypto`. `globalThis.crypto`
 * carries `randomUUID` in every modern browser and in Node ≥ 19, which is the
 * only surface the store needs.
 */
export const randomUUID = (): string => globalThis.crypto.randomUUID();
