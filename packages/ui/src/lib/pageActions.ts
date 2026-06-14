/**
 * Cross-cutting page actions that several surfaces (context menus, the command
 * palette, the sidebar) trigger, but which act on UI that lives elsewhere in the
 * tree — so they go through the window/clipboard rather than React props.
 */

/** Build a shareable deep link to a page (`?page=<id>`), no split. */
export function pageLinkUrl(pageId: string): string {
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
