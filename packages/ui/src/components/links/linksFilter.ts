/**
 * Pure, data-client-free helpers for the Linked-references pane. Kept in their
 * own module so the exclusion logic is unit-testable without importing the
 * React component (and its provider/data-layer imports).
 */

/** An unlinked-mention row: a page whose text names this page without linking it. */
export interface MentionRow {
  pageId: string;
  title: string;
  snippet: string;
  /** The block the match came from, for anchored navigation (when available). */
  blockId: string | null;
}

/** A raw search hit fed to {@link filterUnlinkedMentions}. */
export interface MentionCandidate {
  pageId: string;
  title: string;
  snippet: string;
  blockId?: string | null;
}

/** Trim page text into a compact one-line snippet for a row. */
export function toSnippet(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

/**
 * Pure filter for unlinked mentions. From raw search hits keep only rows that
 * (a) aren't the target page itself, (b) don't already link here (a backlink),
 * (c) haven't been emitted yet (one row per page), and (d) actually name the
 * page — their title or snippet contains `needle`. `needle` must already be
 * lower-cased. Extracted from `useUnlinkedMentions` so the exclusion logic is
 * unit-testable without a data client.
 */
export function filterUnlinkedMentions(
  hits: readonly MentionCandidate[],
  opts: {selfId: string; backlinkIds: ReadonlySet<string>; needle: string},
): MentionRow[] {
  const {selfId, backlinkIds, needle} = opts;
  const seen = new Set<string>();
  const out: MentionRow[] = [];
  for (const hit of hits) {
    if (hit.pageId === selfId) continue; // self
    if (backlinkIds.has(hit.pageId)) continue; // already linked
    if (seen.has(hit.pageId)) continue; // one row per page
    const haystack = `${hit.title} ${hit.snippet}`.toLowerCase();
    if (!haystack.includes(needle)) continue; // must actually name this page
    seen.add(hit.pageId);
    out.push({pageId: hit.pageId, title: hit.title, snippet: toSnippet(hit.snippet), blockId: hit.blockId ?? null});
  }
  return out;
}
