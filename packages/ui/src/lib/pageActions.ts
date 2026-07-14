/**
 * Cross-cutting page actions that several surfaces (context menus, the command
 * palette, the sidebar) trigger, but which act on UI that lives elsewhere in the
 * tree — so they go through the window/clipboard rather than React props.
 */

// ── Share-link origin ───────────────────────────────────────────────────────
// On the desktop, `window.location` is `tauri://localhost` — a copied link built
// from it is dead for anyone else. While the library is published through the
// forwarding tunnel, the forwarded `https://<prefix>.book.cloud` host is the only
// externally reachable address, so `ForwardingProvider` registers it here while
// the tunnel is live (and clears it when it isn't). A module-level registry, not
// React context, because copy-link is also triggered from plain-module callers
// (the page/nav context menus) outside the provider tree.

let shareLinkOrigin: string | null = null;

/**
 * Register (or clear, with `null`) the externally reachable origin that copied
 * page links should use. Accepts a bare host (`prefix.book.cloud`) or a full
 * origin/URL; the stored value is normalized to a bare `https://<host>` origin —
 * any path/query is stripped and any other scheme is upgraded (published sites
 * are https-only). An unparseable value clears the registry rather than storing
 * something `pageLinkUrl` would later throw on.
 */
export function setShareLinkOrigin(origin: string | null): void {
  if (!origin) {
    shareLinkOrigin = null;
    return;
  }
  try {
    const url = new URL(origin.includes('://') ? origin : `https://${origin}`);
    shareLinkOrigin = url.host ? `https://${url.host}` : null;
  } catch {
    shareLinkOrigin = null;
  }
}

/** The currently registered share-link origin, if any (see {@link setShareLinkOrigin}). */
export function getShareLinkOrigin(): string | null {
  return shareLinkOrigin;
}

/** Build a shareable deep link to a page (`?page=<id>`), no split. Prefers the
 *  registered share-link origin (the published address) over `window.location`. */
export function pageLinkUrl(pageId: string): string {
  if (shareLinkOrigin) {
    const url = new URL('/', shareLinkOrigin);
    url.searchParams.set('page', pageId);
    return url.toString();
  }
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.href);
  url.searchParams.set('page', pageId);
  url.searchParams.delete('split');
  return url.toString();
}

/** Copy arbitrary text to the clipboard. Resolves to whether it worked. */
export async function copyText(text: string): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for WKWebView / non-secure contexts where the async clipboard
    // API is unavailable: a throwaway textarea + execCommand('copy').
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Copy a page's deep link to the clipboard. Resolves to whether it worked. */
export async function copyPageLink(pageId: string): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  return copyText(pageLinkUrl(pageId));
}

// ── Rename bridge ───────────────────────────────────────────────────────────
// "Rename" from a menu focuses the page's title field, which lives in the page
// header (outside the menu's subtree). We both fire an event (for a title
// already mounted) and stash a pending target (for one about to mount after a
// page switch), so it works whether or not we're already on the page.

const RENAME_EVENT = 'ob:rename-page';
let pendingRenameId: string | null = null;

/** Ask the editor showing `pageId` to focus its title field for renaming. */
export function requestRenamePage(pageId: string): void {
  if (typeof window === 'undefined') return;
  pendingRenameId = pageId;
  window.dispatchEvent(new CustomEvent(RENAME_EVENT, {detail: {pageId}}));
}

/** If a rename is pending for `pageId`, claim it (clears the flag). */
export function consumePendingRename(pageId: string): boolean {
  if (pendingRenameId !== pageId) return false;
  pendingRenameId = null;
  return true;
}

/** Subscribe to rename requests. Returns an unsubscribe fn. */
export function onRenamePageRequest(cb: (pageId: string) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (e: Event) => {
    const id = (e as CustomEvent<{pageId: string}>).detail?.pageId;
    if (id) cb(id);
  };
  window.addEventListener(RENAME_EVENT, handler);
  return () => window.removeEventListener(RENAME_EVENT, handler);
}

// ── Move bridge ─────────────────────────────────────────────────────────────
// "Move to…" from a context menu opens the destination picker, which lives at
// the layout level (a menu unmounts on select, so it can't host the dialog).

const MOVE_EVENT = 'ob:move-page';

/** Open the "Move to…" destination picker for `pageId`. */
export function requestMovePage(pageId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(MOVE_EVENT, {detail: {pageId}}));
}

/** Subscribe to move requests. Returns an unsubscribe fn. */
export function onMovePageRequest(cb: (pageId: string) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (e: Event) => {
    const id = (e as CustomEvent<{pageId: string}>).detail?.pageId;
    if (id) cb(id);
  };
  window.addEventListener(MOVE_EVENT, handler);
  return () => window.removeEventListener(MOVE_EVENT, handler);
}
