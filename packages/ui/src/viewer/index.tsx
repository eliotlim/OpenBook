/**
 * OpenBook Viewer — the single-file, self-contained renderer HTML exports
 * embed (owner decision 2026-07-04). Built by `vite.viewer.config.js` into an
 * IIFE that exposes a global `OpenBookViewer` and inlines *everything*: React,
 * Yjs, the real block renderer, and the stylesheet (injected as a `<style>`
 * tag when the script loads) — so a bare HTML document can render a page from
 * `file://` with zero network requests.
 *
 * Public contract (the export rearchitecture codes against this):
 *
 *   OpenBookViewer.mount(container, source, opts?) => {unmount()}
 *
 * where `source` is either a `.book.html` island (`{version,id,name,icon,
 * updatedAt,data}`) or a space bundle (`{pages,databases}`) — see ./types.
 *
 * The viewer takes the island as a PRE-PARSED JSON object and never scans the
 * document itself. Hosts that need to pull the island out of a `.book.html`
 * document must extract it string/regex-wise (`readIsland`/`readIslandRaw` in
 * `@book.dev/sdk`), NOT via querySelector/DOMParser: the visible body renders
 * block text raw, so user content with an unterminated `<!--` opens a comment
 * that swallows a trailing island for any DOM parser. The regex reader is
 * immune (every `</` inside the island is escaped, so the first literal
 * `</script>` is the writer's own).
 */
import {createRoot} from 'react-dom/client';
import {registerReactiveBlocks} from '@/blockeditor/reactiveBlocks';
import {registerArtifactKit} from '@/blockeditor/kit';
import {ViewerApp} from './ViewerApp';
import type {ViewerHandle, ViewerMountOptions, ViewerSource} from './types';
import '@/index.css';
import './viewer.css';

export type {
  IslandPageJson,
  SpaceBundleJson,
  SpaceBundlePage,
  ViewerHandle,
  ViewerMountOptions,
  ViewerPage,
  ViewerPageData,
  ViewerSource,
} from './types';

// The custom blocks the locked renderer needs: the built-in reactive plugins
// (slider + formula) and the artifact kit (inputs, charts, status lights,
// cards). Registered once at load, same as the app's page host does.
registerReactiveBlocks();
registerArtifactKit();

// No <StrictMode>: its mount-cycle cleanup destroys the block editor's
// useMemo'd/effect-held internals (see useBlockEditor's UndoManager note).
/**
 * Render `source` into `container`, locked-but-interactive. Returns a handle
 * whose `unmount()` tears the viewer down and releases the container.
 */
export function mount(container: HTMLElement, source: ViewerSource, opts?: ViewerMountOptions): ViewerHandle {
  if (!container || !(container instanceof HTMLElement)) {
    throw new Error('OpenBookViewer.mount: container must be an HTMLElement');
  }
  if (!source || typeof source !== 'object') {
    throw new Error('OpenBookViewer.mount: source must be a page island or space bundle object');
  }
  const root = createRoot(container);
  root.render(<ViewerApp source={source} initialPage={opts?.page} />);
  return {
    unmount(): void {
      root.unmount();
    },
  };
}
