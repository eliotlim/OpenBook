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
import {MAX_ASSET_BYTES} from '@/blockeditor/imageBlock';
import {setAssetBridge} from '@/lib/assetBridge';
import {applyDataColors} from '@/lib/dataColorVars';
import {ViewerApp} from './ViewerApp';
import type {ViewerAssetEntry, ViewerHandle, ViewerMountOptions, ViewerSource} from './types';
import '@/index.css';
import './viewer.css';

export type {
  IslandPageJson,
  SpaceBundleJson,
  SpaceBundlePage,
  ViewerAssetEntry,
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

// The viewer is provider-less (no ThemeProvider), so nothing else writes the
// data-colour CSS vars. Emit them once at load so tags/charts/status lights read
// the canonical palette rather than the `var(…, fallback)` literals — and so the
// pastel/muted light-mode hairline (`--data-stroke`) correctly becomes
// transparent under any `.dark` host instead of a baked light-mode rgba (OB-378,
// Devon's dark-viewer note).
applyDataColors();

/** Decode a base64 payload to bytes (inverse of the export's data-URI body). */
function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Install the read-only asset bridge backed by the mount payload, so
 * asset-referencing blocks (images by `assetId`, HTML artifact documents)
 * resolve inside a standalone file exactly like they do in the app — but from
 * carried bytes instead of the data server. Uploads are rejected (the viewer
 * is read-only and nothing persists). Returns an uninstaller.
 *
 * Bounded decode: a malicious/corrupt island entry must not OOM the reader's
 * own tab, so each entry is capped at the app's asset limit
 * ({@link MAX_ASSET_BYTES}, shared constant — the store never legitimately
 * holds more): a cheap pre-decode length guard (base64 is 4/3×; UTF-8 is
 * ≤3 bytes per UTF-16 unit, so 4× covers both with slack) bounds the work,
 * and the exact post-decode check enforces the cap. Unknown `encoding` values
 * are rejected, never guessed — an over-cap, malformed, or unrecognised entry
 * resolves `null` and the block shows its placeholder.
 */
function installAssetPayload(assets: Record<string, ViewerAssetEntry>): () => void {
  setAssetBridge({
    putAsset: () => Promise.reject(new Error('OpenBookViewer is read-only — assets cannot be uploaded')),
    getAsset: (id) => {
      const entry = assets[id];
      if (!entry || typeof entry.data !== 'string') return Promise.resolve(null);
      if (entry.data.length > MAX_ASSET_BYTES * 4) return Promise.resolve(null); // pre-decode bound
      try {
        let bytes: Uint8Array;
        if (entry.encoding === 'base64') bytes = base64ToBytes(entry.data);
        else if (entry.encoding === 'utf8') bytes = new TextEncoder().encode(entry.data);
        else return Promise.resolve(null); // unknown encoding — never guess a decode
        if (bytes.byteLength > MAX_ASSET_BYTES) return Promise.resolve(null); // exact cap
        return Promise.resolve({bytes, mime: entry.mime || 'application/octet-stream'});
      } catch {
        return Promise.resolve(null); // malformed entry — the block shows its placeholder
      }
    },
  });
  return () => setAssetBridge(null);
}

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
  const uninstallAssets = opts?.assets && Object.keys(opts.assets).length > 0 ? installAssetPayload(opts.assets) : null;
  const root = createRoot(container);
  root.render(<ViewerApp source={source} initialPage={opts?.page} />);
  return {
    unmount(): void {
      root.unmount();
      uninstallAssets?.();
    },
  };
}
