import type {PageSnapshot} from '@open-book/sdk';

/**
 * Note search over page content: a lexical BM25 index that always works
 * (no model required), optionally reranked by embedding similarity when the
 * active AI provider can embed. Pure functions — the service wires them to
 * the store; tests drive them directly.
 */

// ── Text extraction ──────────────────────────────────────────────────────────

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

// ── Tokenizing + chunking ────────────────────────────────────────────────────

export const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);

/** Split text into overlapping chunks (embedding granularity + snippets). */
export function chunkText(text: string, size = 600, overlap = 100): string[] {
  if (text.length <= size) return text ? [text] : [];
  const chunks: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(at + size, text.length);
    // Prefer to break on a sentence/newline boundary near the end.
    if (end < text.length) {
      const slice = text.slice(at, end);
      const cut = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('. '));
      if (cut > size * 0.5) end = at + cut + 1;
    }
    chunks.push(text.slice(at, end).trim());
    if (end >= text.length) break;
    at = Math.max(end - overlap, at + 1);
  }
  return chunks.filter(Boolean);
}

// ── BM25 ─────────────────────────────────────────────────────────────────────

export interface IndexedDoc {
  pageId: string;
  title: string;
  chunkIndex: number;
  text: string;
  /** Optional embedding (hybrid mode). */
  embedding?: number[];
}

export interface Bm25Index {
  docs: IndexedDoc[];
  df: Map<string, number>;
  avgLen: number;
  tokens: string[][];
}

export function buildIndex(docs: IndexedDoc[]): Bm25Index {
  const tokens = docs.map((d) => tokenize(`${d.title} ${d.text}`));
  const df = new Map<string, number>();
  for (const ts of tokens) {
    for (const t of new Set(ts)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const avgLen = tokens.length > 0 ? tokens.reduce((n, ts) => n + ts.length, 0) / tokens.length : 0;
  return {docs, df, avgLen, tokens};
}

const K1 = 1.4;
const B = 0.75;

/** BM25 score of every doc for a query; returns doc indices with scores > 0. */
export function bm25Scores(index: Bm25Index, query: string): Array<{i: number; score: number}> {
  const qTokens = [...new Set(tokenize(query))];
  if (qTokens.length === 0 || index.docs.length === 0) return [];
  const n = index.docs.length;
  const results: Array<{i: number; score: number}> = [];
  for (let i = 0; i < n; i += 1) {
    const ts = index.tokens[i];
    if (ts.length === 0) continue;
    const tf = new Map<string, number>();
    for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const q of qTokens) {
      const f = tf.get(q) ?? 0;
      if (f === 0) continue;
      const df = index.df.get(q) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * ts.length) / index.avgLen)));
    }
    if (score > 0) results.push({i, score});
  }
  return results.sort((a, b) => b.score - a.score);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** A short display snippet centred on the first query hit. */
export function snippetFor(text: string, query: string, width = 160): string {
  const tokens = tokenize(query);
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of tokens) {
    const hit = lower.indexOf(t);
    if (hit >= 0 && (at === -1 || hit < at)) at = hit;
  }
  if (at === -1) return text.slice(0, width).trim();
  const start = Math.max(0, at - Math.floor(width / 3));
  const out = text.slice(start, start + width).trim();
  return `${start > 0 ? '…' : ''}${out}${start + width < text.length ? '…' : ''}`;
}

// ── Task-list parsing (model output → clean strings) ─────────────────────────

/** Parse an LLM's task list: numbered/bulleted/JSON-array forms all accepted. */
export function parseTaskList(raw: string): string[] {
  const text = raw.trim();
  // JSON array (possibly fenced)?
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const arr = JSON.parse(jsonMatch[0]) as unknown;
      if (Array.isArray(arr) && arr.every((x) => typeof x === 'string')) {
        return (arr as string[]).map((s) => s.trim()).filter(Boolean).slice(0, 20);
      }
    } catch {
      // fall through to line parsing
    }
  }
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 2 && !/^(tasks?|steps?|here)/i.test(line))
    .slice(0, 20);
}
