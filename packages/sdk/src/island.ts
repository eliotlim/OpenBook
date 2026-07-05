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
  const {attrs = '', indent = ''} = opts;
  return `${indent}<script type="${OPENBOOK_ISLAND_MARKER}"${attrs ? ` ${attrs}` : ''}>\n${encodeIsland(value)}\n${indent}</script>`;
}

const ISLAND_RE = new RegExp(
  `<script[^>]*type="${OPENBOOK_ISLAND_MARKER.replace(/[/+]/g, '\\$&')}"[^>]*>([\\s\\S]*?)</script>`,
  'i',
);

/** Extract the first island's raw (still `<\/`-escaped) JSON text, or `null`. */
export function readIslandRaw(html: string): string | null {
  const m = html.match(ISLAND_RE);
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
