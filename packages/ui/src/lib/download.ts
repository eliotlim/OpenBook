/**
 * Trigger a client-side file download for a Blob via a temporary `<a download>`.
 * Works in the browser; on the desktop (WKWebView/Tauri) a programmatic download
 * may need the Tauri fs/dialog plugin — verify on the real app.
 */
export function downloadBlob(filename: string, blob: Blob): void {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has consumed the URL.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Download a UTF-8 text file (markdown, html, json) with the given MIME type. */
export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  downloadBlob(filename, new Blob([text], {type: `${mime};charset=utf-8`}));
}

/** A filesystem-safe slug for a page title, for export filenames. */
export function safeFilename(name: string | null | undefined, fallback = 'untitled'): string {
  const base = (name ?? '').trim() || fallback;
  return base.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 120);
}
