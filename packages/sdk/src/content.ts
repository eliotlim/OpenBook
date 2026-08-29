import type {PageSnapshot} from './types';
import {richTextRuns, type RichTextInput, type Run} from './richTextInput';

/**
 * Plain-text projection of page content, shared by every consumer that needs
 * to read or build pages outside the editor: the server's search index, the
 * agent harness's tools, and the MCP server. One module so they all agree on
 * what a page "says".
 */

interface AnyBlock {
  id?: string;
  type?: string;
  data?: Record<string, unknown>;
  text?: Array<{t: string}>;
  children?: AnyBlock[];
  props?: Record<string, unknown>;
}

const stripHtml = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * One block's worth of text from a page snapshot. `blockId` is the block-editor
 * block the text came from — carried so a search hit can anchor to its
 * originating block (the `?block=` scroll-to). It is absent for legacy stored
 * pages, whose stored block ids don't survive the migrate-on-open remap and so
 * would never match a rendered `[data-block-row]`.
 */
export interface SnapshotSegment {
  blockId?: string;
  text: string;
}

/**
 * Per-block text projection of a page snapshot. {@link snapshotText} is just
 * these segments flattened (joined by newlines), so the two never drift; the
 * server's search index reads segments instead so each indexed chunk remembers
 * the block it came from.
 */
export function snapshotSegments(data: PageSnapshot | null | undefined): SnapshotSegment[] {
  if (!data) return [];
  const segments: SnapshotSegment[] = [];

  // Block-editor pages: read the JSON projection, one segment per block (its
  // text runs plus any code source), tagged with the block id.
  const blockdoc = data.blockdoc as {blocks?: AnyBlock[]} | undefined;
  if (data.editor === 'blocks' && blockdoc?.blocks) {
    const walk = (blocks: AnyBlock[]): void => {
      for (const b of blocks) {
        const parts: string[] = [];
        if (Array.isArray(b.text)) parts.push(b.text.map((r) => r.t).join(''));
        if (typeof b.props?.source === 'string') parts.push(String(b.props.source));
        if (parts.length > 0) segments.push({blockId: b.id, text: parts.join('\n')});
        if (b.children) walk(b.children);
      }
    };
    walk(blockdoc.blocks);
    return segments;
  }

  // Legacy stored pages: pull the text-ish fields out of each block. No stable
  // block id survives migration, so these segments carry text only.
  const blocks = (data.editorjs as {blocks?: AnyBlock[]} | undefined)?.blocks ?? [];
  for (const b of blocks) {
    const d = b.data ?? {};
    if (typeof d.text === 'string') segments.push({text: stripHtml(d.text)});
    if (typeof d.code === 'string') segments.push({text: String(d.code)});
    if (typeof d.title === 'string') segments.push({text: stripHtml(String(d.title))});
    if (typeof d.content === 'string') segments.push({text: stripHtml(String(d.content))});
    if (Array.isArray(d.items)) {
      for (const item of d.items as Array<string | {text?: string; content?: string}>) {
        const t = typeof item === 'string' ? item : (item.text ?? item.content ?? '');
        if (t) segments.push({text: stripHtml(String(t))});
      }
    }
    if (Array.isArray(d.content)) {
      for (const row of d.content as string[][]) {
        if (Array.isArray(row)) segments.push({text: row.map((c) => stripHtml(String(c))).join(' ')});
      }
    }
  }
  return segments;
}

/** Flatten a page snapshot (legacy stored or block-editor) into plain text. */
export function snapshotText(data: PageSnapshot | null | undefined): string {
  return snapshotSegments(data)
    .map((s) => s.text)
    .join('\n')
    .trim();
}

/**
 * Turn plain text into block-native paragraph blocks (one per non-empty line):
 * the JSON-projection shape a `blockdoc` stores (`{id, type, text: runs}`), NOT
 * the legacy EditorJS `{type, data}` shape. Fed into {@link textSnapshot} and
 * the block branch of {@link appendTextToSnapshot}.
 */
export function paragraphBlocks(content: string, idPrefix = 'gen'): Array<{id: string; type: 'paragraph'; text: Array<{t: string}>}> {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((text, i) => ({id: `${idPrefix}-${i}`, type: 'paragraph' as const, text: [{t: text}]}));
}

/**
 * Build a fresh page snapshot whose document is the given plain text — a
 * block-native `blockdoc` (`editor: 'blocks'`), so pages created by the AI
 * agent, the MCP server, and plugins carry the CRDT block editor's shape from
 * birth and never hit the legacy migrate-on-open path. The blockdoc is the
 * JSON-projection form (no CRDT `update`); the editor rebuilds the Y.Doc from
 * `blocks` on first load and stamps a real update on the first save (exactly
 * like {@link appendBlocksToSnapshot}). `editorjs` is kept as an empty
 * placeholder — the retained storage key every reader tolerates.
 */
export function textSnapshot(content = '', idPrefix = 'gen'): PageSnapshot {
  return {editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: {blocks: paragraphBlocks(content, idPrefix)}};
}

/**
 * Append plain text to a page snapshot as paragraph blocks, returning the new
 * snapshot (or `data` unchanged when there's nothing to add). Used by the agent
 * and the MCP server.
 *
 * A block-editor page (or any snapshot already carrying a `blockdoc`) gets the
 * paragraphs merged into its blockdoc JSON projection — the stale CRDT `update`
 * is dropped so a live client re-merges from `blocks` on next load (this
 * server-side path has no live editor; mirrors {@link appendBlocksToSnapshot}).
 * A pre-existing LEGACY page (no blockdoc) keeps its stored `editorjs` shape —
 * its content upgrades to blockdoc only when the editor opens it
 * (migrateLegacyBlocks) — so appended paragraphs use the legacy `{type, data}`
 * shape there, never mixing dialects in one block list.
 */
export function appendTextToSnapshot(data: PageSnapshot, content: string, idPrefix = 'gen'): PageSnapshot {
  if (data.editor === 'blocks' || data.blockdoc) {
    const added = paragraphBlocks(content, idPrefix);
    if (added.length === 0) return data;
    const blockdoc = (data.blockdoc as {blocks?: unknown[]; update?: string; v?: number} | undefined) ?? {blocks: []};
    return {...data, editor: 'blocks', blockdoc: {...blockdoc, update: undefined, blocks: [...(blockdoc.blocks ?? []), ...added]}};
  }
  const added = content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((text, i) => ({id: `${idPrefix}-${i}`, type: 'paragraph' as const, data: {text}}));
  if (added.length === 0) return data;
  const editorjs = (data.editorjs as {blocks?: unknown[]} | undefined) ?? {blocks: []};
  return {...data, editorjs: {...editorjs, blocks: [...(editorjs.blocks ?? []), ...added]}};
}

/** A block to append to a block-editor page (the agent / MCP write path). */
export interface AppendBlock {
  type: string;
  /** Plain text (text-carrying blocks). */
  text?: RichTextInput;
  /** Treat a string `text` literally instead of parsing mini-markdown. */
  plain?: boolean;
  props?: Record<string, unknown>;
  /**
   * Nested children — the document model is ONE recursive shape, so a container
   * block (`columns`/`column`, `table`/`row`/`cell`, `group`, `tabs`/`tab`,
   * `accordion`/`accordionsection`) carries its contents here, to any depth. The
   * projection below preserves them verbatim; the editor's `coerceNewBlock` /
   * `makeBlock` build the real CRDT containers when the page opens. Dropping this
   * field (as the pre-API-1 flat projection did) silently discards every nested
   * block, so a table/columns payload landed as a single empty container.
   */
  children?: AppendBlock[];
}

/**
 * One block in the blockdoc JSON projection (`blockdoc.blocks`) — the shape
 * {@link projectAppendBlocks} emits and `decodeSnapshot` rebuilds a Y.Doc from.
 */
export interface ProjectedBlock {
  id: string;
  type: string;
  text?: Run[];
  props?: Record<string, unknown>;
  children?: ProjectedBlock[];
}

/**
 * Project {@link AppendBlock}s into the blockdoc JSON projection, RECURSIVELY —
 * text becomes runs and `children` are projected at every level (the model is
 * uniformly recursive, so a table is just `table → row → cell → blocks`).
 *
 * Ids are DERIVED FROM POSITION within the given `idPrefix` (`<prefix>-0`,
 * `<prefix>-0-1`, `<prefix>-0-1-2`), so a nested child is addressable afterwards
 * (inspect_page_structure → update_block / delete_block). Stability holds only for
 * a FIXED prefix: a direct MCP write uses a time-based prefix (`mcp-<ts>`), so two
 * appends of identical content get DIFFERENT ids — and the SUGGEST path never runs
 * this projection at all (the raw payload rides in the suggestion and the editor
 * bridge's `coerceNewBlock` mints its own ids on accept).
 */
export function projectAppendBlocks(blocks: AppendBlock[], idPrefix = 'gen'): ProjectedBlock[] {
  return blocks.map((b, i) => {
    const id = `${idPrefix}-${i}`;
    return {
      id,
      type: b.type,
      ...(b.text !== undefined ? {text: richTextRuns(b.text, b.plain)} : {}),
      ...(b.props ? {props: b.props} : {}),
      ...(b.children && b.children.length > 0 ? {children: projectAppendBlocks(b.children, id)} : {}),
    };
  });
}

/**
 * Append blocks to a **block-editor** page's JSON projection, returning the new
 * snapshot — or `null` for legacy stored pages (use {@link appendTextToSnapshot}
 * there). Nested `children` are preserved (see {@link projectAppendBlocks}), so
 * a `table`/`columns`/`group` payload materializes as a real container tree.
 * This mutates only the JSON projection (`blockdoc.blocks`), NOT the
 * CRDT `update` — so a *live* editor on that page should apply the change
 * through the editor bridge instead (one CRDT transaction, undoable). This
 * server-side path exists for the MCP server, which has no live editor; a live
 * client merges the JSON projection on next load. Used by the agent's confirm
 * gate only as a fallback when no editor bridge is present.
 */
export function appendBlocksToSnapshot(data: PageSnapshot, blocks: AppendBlock[], idPrefix = 'gen'): PageSnapshot | null {
  if (data.editor !== 'blocks') return null;
  if (blocks.length === 0) return data;
  const blockdoc = (data.blockdoc as {blocks?: unknown[]; update?: string; v?: number} | undefined) ?? {blocks: []};
  const projected = projectAppendBlocks(blocks, idPrefix);
  return {
    ...data,
    // Drop the stale CRDT `update` so the page rebuilds from the JSON projection
    // (decodeSnapshot prefers `update`; clearing it forces the merged blocks in).
    blockdoc: {...blockdoc, update: undefined, blocks: [...(blockdoc.blocks ?? []), ...projected]},
  };
}
