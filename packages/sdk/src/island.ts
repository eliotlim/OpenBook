/**
 * The shared **source-island** mechanism (OB export format): a machine-readable
 * JSON blob embedded in an otherwise human-visible HTML document, carrying the
 * lossless OpenBook source so the file round-trips back into pglite. The visible
 * body is a *rendering*; the island is *authoritative*.
 *
 * One mechanism, three surfaces:
 *  - the sync-folder `.book.html` format (one page island each) — {@link ./bookfile};
 *  - single-page / slide-deck standalone HTML exports (a page island) — ui `toHtml`;
 *  - whole-site standalone HTML exports (one space-bundle island) — ui `toHtmlSite`.
 *
 * ## Asset contract (for the future island-first import task)
 * The island's block-doc references image `assetId`s (content-addressed, *not*
 * inlined), while the surrounding visible HTML carries the resolved `data:` URIs
 * (see the ui `exportAssets` pass). Re-import reads the island → gets faithful
 * `assetId`s; recovering the actual bytes (from the sibling data-URIs, or by
 * re-fetching) is the import task's job. This module keeps the island FAITHFUL:
 * `assetId`s are never rewritten to data-URIs, so the source stays lossless and
 * the id → capability read-gate is preserved.
 */

/** The `<script type>` marking an OpenBook JSON source island. */
export const OPENBOOK_ISLAND_MARKER = 'application/openbook+json';

/**
 * Serialise a value to an island JSON body, escaping `</` so a literal
 * `</script>` — or any `</…>` — anywhere in the content can't close the tag
 * early. `<\/` is still valid JSON and parses back to `</`, so the round-trip is
 * lossless. This is the *only* escaping the island needs (it is inert data, not
 * executed), and it is what makes the island immune to hostile page content.
 */
export function encodeIsland(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

/**
 * Wrap an island body in the canonical inert `<script>` tag. `attrs` adds extra
 * tag attributes (e.g. `data-openbook-snapshot`); `indent` prefixes the tag lines
 * so callers can keep their surrounding HTML pretty-printed. The browser never
 * executes a non-JS `type`, so the island is pure carried data.
 */
export function islandScript(value: unknown, opts: {attrs?: string; indent?: string} = {}): string {
  return taggedIslandScript(OPENBOOK_ISLAND_MARKER, value, opts);
}

/** The generic inert-tag wrapper behind every island flavour. */
function taggedIslandScript(marker: string, value: unknown, opts: {attrs?: string; indent?: string} = {}): string {
  const {attrs = '', indent = ''} = opts;
  return `${indent}<script type="${marker}"${attrs ? ` ${attrs}` : ''}>\n${encodeIsland(value)}\n${indent}</script>`;
}

const islandRe = (marker: string): RegExp =>
  new RegExp(`<script[^>]*type="${marker.replace(/[/+]/g, '\\$&')}"[^>]*>([\\s\\S]*?)</script>`, 'gi');

const ISLAND_RE = islandRe(OPENBOOK_ISLAND_MARKER);

/** Extract the first island's raw (still `<\/`-escaped) JSON text, or `null`. */
export function readIslandRaw(html: string): string | null {
  ISLAND_RE.lastIndex = 0; // shared sticky regex — always scan from the top
  const m = ISLAND_RE.exec(html);
  return m ? m[1].trim() : null;
}

/**
 * Parse the first island in an HTML string back to its value, or `null` when
 * absent or corrupt. `JSON.parse` unescapes the `<\/` sequences for free (`\/`
 * is a valid JSON escape for `/`), so no separate unescape step is needed.
 */
export function readIsland<T = unknown>(html: string): T | null {
  const raw = readIslandRaw(html);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ── Export assets island ─────────────────────────────────────────────────────

/**
 * The `<script type>` marking an export's **assets island** — the sibling blob
 * carrying asset BYTES the visible document has no natural carrier for (today:
 * `htmlArtifact` documents; images ride the visible `<img data-asset-id
 * src="data:…">` tags instead and are never duplicated here). Emitted by the
 * ui export pipeline AFTER the source island; consumed by the standalone
 * viewer's boot and by island-first import, which together with the img tags
 * recovers a producer-decoupled `Map<assetId, bytes>`.
 */
export const OPENBOOK_ASSETS_MARKER = 'application/openbook-assets+json';

/** One asset's bytes in the assets island. `utf8` carries text directly (an
 *  HTML artifact stays human-readable inside the JSON); `base64` is the
 *  extension point for binary payloads. */
export interface ExportAssetEntry {
  mime: string;
  encoding: 'utf8' | 'base64';
  data: string;
}

/** The assets island payload: `{version: 1, assets: {assetId → entry}}`. */
export interface ExportAssetsIsland {
  version: 1;
  assets: Record<string, ExportAssetEntry>;
}

/**
 * Wrap an assets map as its island `<script>` (versioned, `</`-escaped).
 *
 * ORDERING CONTRACT: emitters must place this AFTER the source island. String
 * readers accept the first plausible `<script type=…>` sequence, and hostile
 * *content* inside an earlier blob can embed a spoof opening tag — keeping the
 * trusted islands first means a spoof can only trail the real ones (and
 * {@link readAssetsIsland} additionally shape-checks every candidate).
 */
export function assetsIslandScript(assets: Record<string, ExportAssetEntry>, opts: {attrs?: string; indent?: string} = {}): string {
  const payload: ExportAssetsIsland = {version: 1, assets};
  return taggedIslandScript(OPENBOOK_ASSETS_MARKER, payload, {attrs: 'data-openbook-assets', ...opts});
}

/**
 * Read an export's assets island back, or `null` when absent/corrupt. Scans
 * EVERY candidate tag and returns the first that parses to the versioned
 * shape: a spoof opening tag smuggled inside the (earlier) source island's
 * JSON text captures garbage that fails the parse, so it cannot mask the real
 * island that follows.
 */
export function readAssetsIsland(html: string): ExportAssetsIsland | null {
  const re = islandRe(OPENBOOK_ASSETS_MARKER);
  for (let m = re.exec(html); m; m = re.exec(html)) {
    try {
      const parsed = JSON.parse(m[1].trim()) as Partial<ExportAssetsIsland>;
      if (parsed && parsed.version === 1 && parsed.assets && typeof parsed.assets === 'object' && !Array.isArray(parsed.assets)) {
        return {version: 1, assets: parsed.assets as Record<string, ExportAssetEntry>};
      }
    } catch {
      /* spoofed / truncated candidate — keep scanning */
    }
  }
  return null;
}
