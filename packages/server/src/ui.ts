import {readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import type {Context, Hono} from 'hono';
import type {AppEnv} from './appEnv';

/**
 * STAB-7 (LAN-hosted web UI): serve a pre-built, client-only OpenBook web
 * bundle from the sidecar so a LAN browser (or the local machine) can open
 * `http://<host>:<port>/` directly instead of only reaching `/api/*`.
 *
 * Mounted LAST in {@link createApp} and gated on {@link AppOptions.uiDir}: when
 * unset the sidecar behaves exactly as before (a UI request 404s). When set, a
 * single `GET *` catch-all serves the static assets and falls back to
 * `index.html` for client-routed deep links — WITHOUT shadowing the API. Every
 * concrete `/api/*`, `/api/mcp`, `/api/live` (SSE), health and plugin route is
 * registered earlier and returns its own Response, so Hono never reaches this
 * handler for them; and as a belt-and-braces guard the handler itself refuses
 * to serve HTML for the `/api` and `/health` surfaces (an unmatched `/api/foo`
 * must 404 as the API, never as the SPA shell).
 *
 * Runtime-agnostic on purpose: it reads files with `node:fs` (available under
 * both the Node/vitest test harness and the Bun-compiled sidecar) rather than a
 * runtime-specific `serveStatic`, so one code path covers both.
 *
 * AUTH POSTURE (owner-decided): the served UI rides the existing `guestAccess`
 * setting unchanged — this handler adds NO gate of its own. The static shell is
 * public; every data read/write it issues still flows through the `/api/*`
 * access stack. STAB-8 note: when guest WRITES start requiring a custom client
 * header (e.g. `X-OpenBook-Client`), the CLIENT half plumbs into the UI's
 * `HttpDataClient` fetch wrapper (see `useWebClient` in packages/web) and the
 * SERVER half lands in the app.ts middleware region (near `cors()` / the guest
 * gate) — NOT here. `mountUi` only ships the static bytes and is deliberately
 * mounted LAST in {@link createApp}, so STAB-8's middleware stays upstream of it
 * and this catch-all needs no change: keep the merge additive on both sides.
 */
export function mountUi(app: Hono<AppEnv>, uiDir: string): void {
  const root = path.resolve(uiDir);
  const indexPath = path.join(root, 'index.html');

  app.get('*', async (c, next) => {
    const pathname = decodePathname(c.req.url);

    // Never answer the API/health surface with the SPA shell. These are either
    // handled above (and never reach here) or genuinely absent — in which case
    // the caller wants the API's own 404, not `index.html`.
    if (pathname === '/health' || pathname === '/api' || pathname.startsWith('/api/')) {
      return next();
    }

    // Try a concrete asset first (hashed JS/CSS/img/font), else fall back to the
    // SPA shell so a client-routed deep link (`/some/page`) still boots the app.
    const asset = resolveWithinRoot(root, pathname);
    // Base the immutable-cache decision on the RESOLVED path (relative to root),
    // never the raw request: a `..`-normalized or oddly-encoded request that lands
    // on a non-hashed file must not be able to spoof a 1-year immutable hint from a
    // `/_next/`-looking prefix it no longer resolves to.
    if (asset && isFile(asset)) return serveFile(c, asset, /*immutable*/ isHashed(path.relative(root, asset)));
    if (isFile(indexPath)) return serveFile(c, indexPath, /*immutable*/ false);
    return next();
  });
}

/** The URL path, percent-decoded, with the query/hash stripped. */
function decodePathname(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return new URL(url).pathname;
  }
}

/**
 * Resolve `pathname` to an absolute file path *inside* `root`, or null if it
 * would escape (a `..` traversal or an absolute-looking segment). The returned
 * path is not guaranteed to exist — callers check {@link isFile}.
 */
function resolveWithinRoot(root: string, pathname: string): string | null {
  // Strip the leading slash so `path.join` treats it as relative to root.
  const rel = pathname.replace(/^\/+/, '');
  const resolved = path.resolve(root, rel);
  // Contain the result: it must be root itself or a descendant of it.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * A build-hashed asset (immutable, safe to cache hard). Next emits everything under
 * `_next/` build-hashed, plus content-hashed filenames like `foo.a1b2c3d4.js`. Takes
 * a path RELATIVE to the UI root (see the caller) — not the raw request pathname — so
 * the cache hint tracks the file actually served, not a spoofable request prefix.
 */
function isHashed(relPath: string): boolean {
  const normalized = relPath.split(path.sep).join('/');
  return normalized.startsWith('_next/') || /\.[0-9a-f]{8,}\.[a-z0-9]+$/i.test(normalized);
}

function serveFile(c: Context<AppEnv>, filePath: string, immutable: boolean) {
  const bytes = readFileSync(filePath);
  const type = contentType(filePath);
  // Hashed assets are content-addressed → cache hard; the mutable shell must be
  // revalidated so a redeploy is picked up.
  const cacheControl = immutable ? 'public, max-age=31536000, immutable' : 'no-cache';
  // Serve the declared MIME verbatim — never let a browser content-sniff a served
  // asset into an executable type (defense-in-depth for a LAN-reachable origin).
  return c.body(bytes, 200, {
    'Content-Type': type,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

function contentType(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}
