import {useEffect} from 'react';

// The editor claims file drops on its own root and inserts image / htmlArtifact
// blocks (BlockEditor.tsx `onRootDrop`). Anything OUTSIDE that root — the
// sidebar, the nav bar, the window margins — has no drop handler, so a stray
// file drop falls through to the browser / WKWebView default: it navigates the
// whole document to `file://…`, stranding the app full-screen with no way back
// (desktop `dragDropEnabled` is deliberately `false` so in-page HTML5 block
// re-order works, which means WKWebView, not Tauri, owns native drops). The web
// app has the same hazard (the browser opens the dropped file in the tab).
const EDITOR_ROOT_SELECTOR = '.obe-root';

// Is this drag carrying external files (vs an internal block-move drag, which
// uses custom / text types and must be left completely alone)? Mirrors
// BlockEditor's `isFileDrag`.
const isFileDrag = (dt: DataTransfer | null): boolean =>
  !!dt && Array.from(dt.types).includes('Files');

/**
 * Window-level backstop that stops a file drop anywhere outside the editor from
 * navigating the document away. Mounted once in {@link DefaultLayout}, so both
 * the web app and the Tauri desktop shell get it.
 *
 * Listens in the *capture* phase (above React's root-container delegation) but
 * only ever calls `preventDefault` — never `stopPropagation` — so the editor's
 * own React drop handlers still run for in-editor drops (they run in the bubble
 * phase, after this). For a file drag over non-editor chrome it swallows the
 * default action; the drop is a no-op and the app stays put. Internal block
 * drags carry no `Files` type, so re-ordering is untouched.
 */
export default function DragDropGuard(): null {
  useEffect(() => {
    // dragover must be preventDefault-ed for the subsequent `drop` to fire at
    // all; do it for every file drag (in- or out-of-editor) so the drop event
    // always reaches us and we can decide there. The editor also prevents its
    // own dragover, so this is at worst redundant on the editor path.
    const onDragOver = (e: DragEvent): void => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (e: DragEvent): void => {
      if (!isFileDrag(e.dataTransfer)) return;
      // Inside an editor root the editor's own handler owns this drop — don't
      // touch it (it prevents its own default and ingests the files).
      const target = e.target as Element | null;
      if (target?.closest?.(EDITOR_ROOT_SELECTOR)) return;
      // Outside the editor: swallow the default so the webview / browser never
      // navigates to the dropped file.
      e.preventDefault();
    };
    window.addEventListener('dragover', onDragOver, true);
    window.addEventListener('drop', onDrop, true);
    return () => {
      window.removeEventListener('dragover', onDragOver, true);
      window.removeEventListener('drop', onDrop, true);
    };
  }, []);
  return null;
}
