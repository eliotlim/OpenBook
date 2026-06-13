import type {PageSnapshot} from './types';

/**
 * Plain-text projection of page content, shared by every consumer that needs
 * to read or build pages outside the editor: the server's search index, the
 * agent harness's tools, and the MCP server. One module so they all agree on
 * what a page "says".
 */

interface AnyBlock {
  type?: string;
  data?: Record<string, unknown>;
  text?: Array<{t: string}>;
  children?: AnyBlock[];
  props?: Record<string, unknown>;
}

const stripHtml = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** Flatten a page snapshot (EditorJS or block-editor) into plain text. */
export function snapshotText(data: PageSnapshot | null | undefined): string {
  if (!data) return '';
  const parts: string[] = [];

  // Block-editor pages: read the JSON projection.
  const blockdoc = data.blockdoc as {blocks?: AnyBlock[]} | undefined;
  if (data.editor === 'blocks' && blockdoc?.blocks) {
    const walk = (blocks: AnyBlock[]): void => {
      for (const b of blocks) {
        if (Array.isArray(b.text)) parts.push(b.text.map((r) => r.t).join(''));
        if (typeof b.props?.source === 'string') parts.push(String(b.props.source));
        if (b.children) walk(b.children);
      }
    };
    walk(blockdoc.blocks);
    return parts.join('\n').trim();
  }

  // EditorJS pages: pull the text-ish fields out of each block.
  const blocks = (data.editorjs as {blocks?: AnyBlock[]} | undefined)?.blocks ?? [];
  for (const b of blocks) {
    const d = b.data ?? {};
    if (typeof d.text === 'string') parts.push(stripHtml(d.text));
    if (typeof d.code === 'string') parts.push(String(d.code));
    if (typeof d.title === 'string') parts.push(stripHtml(String(d.title)));
    if (typeof d.content === 'string') parts.push(stripHtml(String(d.content)));
    if (Array.isArray(d.items)) {
      for (const item of d.items as Array<string | {text?: string; content?: string}>) {
        const t = typeof item === 'string' ? item : (item.text ?? item.content ?? '');
        if (t) parts.push(stripHtml(String(t)));
      }
    }
    if (Array.isArray(d.content)) {
      for (const row of d.content as string[][]) {
        if (Array.isArray(row)) parts.push(row.map((c) => stripHtml(String(c))).join(' '));
      }
    }
  }
  return parts.join('\n').trim();
}

/** Turn plain text into EditorJS paragraph blocks (one per non-empty line). */
export function paragraphBlocks(content: string, idPrefix = 'gen'): Array<{id: string; type: 'paragraph'; data: {text: string}}> {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((text, i) => ({id: `${idPrefix}-${i}`, type: 'paragraph' as const, data: {text}}));
}

/** Build a fresh page snapshot whose document is the given plain text. */
export function textSnapshot(content = '', idPrefix = 'gen'): PageSnapshot {
  return {editorjs: {blocks: paragraphBlocks(content, idPrefix)}, values: [], names: []};
}

/**
 * Append plain text to a page snapshot as paragraph blocks, returning the new
 * snapshot — or `null` when the page can't be appended to this way (the
 * collaborative block editor owns those documents). Used by the agent and the
 * MCP server so both apply the same guard.
 */
export function appendTextToSnapshot(data: PageSnapshot, content: string, idPrefix = 'gen'): PageSnapshot | null {
  if (data.editor === 'blocks') return null;
  const added = paragraphBlocks(content, idPrefix);
  if (added.length === 0) return data;
  const editorjs = (data.editorjs as {blocks?: unknown[]} | undefined) ?? {blocks: []};
  return {...data, editorjs: {...editorjs, blocks: [...(editorjs.blocks ?? []), ...added]}};
}

/** A block to append to a block-editor page (the agent / MCP write path). */
export interface AppendBlock {
  type: string;
  /** Plain text (text-carrying blocks). */
  text?: string;
  props?: Record<string, unknown>;
}

/**
 * Append blocks to a **block-editor** page's JSON projection, returning the new
 * snapshot — or `null` for legacy EditorJS pages (use {@link appendTextToSnapshot}
 * there). This mutates only the JSON projection (`blockdoc.blocks`), NOT the
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
  const projected = blocks.map((b, i) => ({
    id: `${idPrefix}-${i}`,
    type: b.type,
    ...(b.text !== undefined ? {text: [{t: b.text}]} : {}),
    ...(b.props ? {props: b.props} : {}),
  }));
  return {
    ...data,
    // Drop the stale CRDT `update` so the page rebuilds from the JSON projection
    // (decodeSnapshot prefers `update`; clearing it forces the merged blocks in).
    blockdoc: {...blockdoc, update: undefined, blocks: [...(blockdoc.blocks ?? []), ...projected]},
  };
}
